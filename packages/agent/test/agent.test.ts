import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Context,
	createCuaModels,
	type CuaSimpleStreamOptions,
	resolveCuaRuntimeSpec,
} from "@onkernel/cua-ai";
import type Kernel from "@onkernel/sdk";
import {
	Agent,
	AgentHarness,
	CuaAgent,
	CuaAgentHarness,
	InMemorySessionRepo,
	NodeExecutionEnv,
	type AgentMessage,
	type AgentTool,
	type KernelBrowser,
	type StreamFn,
} from "../src/index";

const browser = { session_id: "browser_123" } as KernelBrowser;
const client = {} as Kernel;
const ANTHROPIC_BATCH_TOOL_NAME = "computer_batch";
const tinyPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
	"base64",
);

function createAssistantMessage(model: { api: string; provider: string; id: string }): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function createHarnessServices() {
	const sessionRepo = new InMemorySessionRepo();
	return {
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
		session: await sessionRepo.create(),
	};
}

function createCustomTool(name = "custom"): AgentTool {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: { type: "object", properties: {}, additionalProperties: false } as never,
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
}

function finishMessage(message: AssistantMessage, text?: string): AssistantMessage {
	if (text !== undefined) message.content = [{ type: "text", text }];
	return message;
}

function createScriptedStream(texts: Array<string | undefined>, contexts?: Array<{ messages: Array<{ role: string }> }>) {
	let providerCalls = 0;
	const streamFn: StreamFn = (model, context) => {
		contexts?.push(context as never);
		const stream = createAssistantMessageEventStream();
		const message = finishMessage(createAssistantMessage(model), texts[providerCalls]);
		providerCalls += 1;
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};
	return { streamFn, calls: () => providerCalls };
}

function createModelsFromStream(streamFn: StreamFn, provider = "openai") {
	const models = createCuaModels();
	models.setProvider({
		id: provider,
		name: `scripted ${provider}`,
		auth: {
			apiKey: {
				name: "test key",
				resolve: async () => ({ auth: { apiKey: "test-key" } }),
			},
		},
		getModels: () => [],
		stream: streamFn,
		streamSimple: streamFn,
	} as never);
	return models;
}

function createScriptedModels(
	texts: Array<string | undefined>,
	contexts?: Array<{ messages: Array<{ role: string }> }>,
) {
	const scripted = createScriptedStream(texts, contexts);
	return {
		models: createModelsFromStream(scripted.streamFn),
		calls: scripted.calls,
	};
}

describe("CuaAgent", () => {
	it("extends pi Agent and resolves model refs in initialState", () => {
		const runtime = resolveCuaRuntimeSpec("openai:gpt-5.5");
		const agent = new CuaAgent({
			browser,
			client,
			initialState: {
				model: "openai:gpt-5.5",
			},
		});

		expect(agent).toBeInstanceOf(Agent);
		expect(agent.state.model.id).toBe("gpt-5.5");
		expect(agent.state.tools.length).toBeGreaterThan(0);
		expect(agent.state.systemPrompt).toBe(runtime.defaultSystemPrompt);
	});

	it("appends extra tools to provider CUA tools", () => {
		const runtime = resolveCuaRuntimeSpec("yutori:n1.5-latest");
		const tool = createCustomTool();

		const agent = new CuaAgent({
			browser,
			client,
			extraTools: [tool],
			initialState: {
				model: "yutori:n1.5-latest",
			},
		});

		expect(agent.state.tools.map((item) => item.name)).toEqual([...runtime.toolExecutors.map((item) => item.definition.name), "computer_use_extra", "custom"]);
	});

	it("always keeps provider CUA tools when adding extra tools", () => {
		const runtime = resolveCuaRuntimeSpec("openai:gpt-5.5");
		const tool = createCustomTool();

		const agent = new CuaAgent({
			browser,
			client,
			extraTools: [tool],
			initialState: {
				model: "openai:gpt-5.5",
				systemPrompt: "Use the browser carefully.",
			},
		});

		expect(agent.state.tools.map((item) => item.name)).toEqual([...runtime.toolExecutors.map((item) => item.definition.name), "computer_use_extra", "custom"]);
		expect(agent.state.systemPrompt).toBe("Use the browser carefully.");
	});

	it("installs provider-defined batch tools", () => {
		const runtime = resolveCuaRuntimeSpec("anthropic:claude-opus-4-7");
		const agent = new CuaAgent({
			browser,
			client,
			initialState: {
				model: "anthropic:claude-opus-4-7",
			},
		});

		expect(runtime.toolDefinitions.map((tool) => tool.name)).toContain(ANTHROPIC_BATCH_TOOL_NAME);
		expect(agent.state.tools.map((tool) => tool.name)).toEqual([...runtime.toolExecutors.map((tool) => tool.definition.name), "computer_use_extra"]);
	});

	it("synthesizes navigation tools by default", () => {
		const runtime = resolveCuaRuntimeSpec("openai:gpt-5.5");
		const agent = new CuaAgent({
			browser,
			client,
			initialState: {
				model: "openai:gpt-5.5",
			},
		});

		expect(agent.state.tools.map((tool) => tool.name)).toEqual([
			...runtime.toolExecutors.map((tool) => tool.definition.name),
			"computer_use_extra",
		]);
	});

	it("synthesizes a playwright_execute tool when requested", () => {
		const runtime = resolveCuaRuntimeSpec("openai:gpt-5.5");
		const agent = new CuaAgent({
			browser,
			client,
			playwright: true,
			initialState: {
				model: "openai:gpt-5.5",
			},
		});

		expect(agent.state.tools.map((tool) => tool.name)).toEqual([
			...runtime.toolExecutors.map((tool) => tool.definition.name),
			"computer_use_extra",
			"playwright_execute",
		]);
	});

	it("refreshes CUA runtime state when state.model changes", () => {
		const runtime = resolveCuaRuntimeSpec("google:gemini-3-flash-preview");
		const agent = new CuaAgent({
			browser,
			client,
			initialState: {
				model: "openai:gpt-5.5",
			},
		});

		agent.state.model = "google:gemini-3-flash-preview";

		expect(agent.state.model.id).toBe(runtime.model.id);
		expect(agent.state.systemPrompt).toBe(runtime.defaultSystemPrompt);
		expect(agent.state.tools).toHaveLength(runtime.toolExecutors.length + 1);
	});

	it("switches action planes through setMode", () => {
		const agent = new CuaAgent({
			browser,
			client,
			initialState: {
				model: "anthropic:claude-opus-4-5",
			},
		});
		expect(agent.getMode()).toBe("computer");
		expect(agent.state.tools.map((tool) => tool.name)).toContain("click");

		agent.setMode("browser");

		expect(agent.getMode()).toBe("browser");
		const names = agent.state.tools.map((tool) => tool.name);
		expect(names).toContain("snapshot");
		expect(names).not.toContain("move");
		expect(agent.state.systemPrompt).toBe(resolveCuaRuntimeSpec("anthropic:claude-opus-4-5", { mode: "browser" }).defaultSystemPrompt);
	});

	it("rejects setMode conflicting with a configured native tool", () => {
		const agent = new CuaAgent({
			browser,
			client,
			nativeTool: { type: "browser_20260701" },
			initialState: {
				model: "anthropic:claude-opus-4-8",
			},
		});
		expect(agent.getMode()).toBe("browser");
		expect(() => agent.setMode("computer")).toThrow(/requires mode "browser"/);
		expect(agent.getMode()).toBe("browser");
	});

	it("keeps extra tools and caller-owned system prompt when state.model changes", () => {
		const tool = createCustomTool();
		const agent = new CuaAgent({
			browser,
			client,
			extraTools: [tool],
			initialState: {
				model: "openai:gpt-5.5",
				systemPrompt: "custom prompt",
			},
		});

		agent.state.model = "google:gemini-3-flash-preview";

		const runtime = resolveCuaRuntimeSpec("google:gemini-3-flash-preview");
		expect(agent.state.tools.map((item) => item.name)).toEqual([...runtime.toolExecutors.map((item) => item.definition.name), "computer_use_extra", "custom"]);
		expect(agent.state.systemPrompt).toBe("custom prompt");
	});

	it("does not retry transient errors by default", async () => {
		let calls = 0;
		const agent = new CuaAgent({
			browser,
			client,
			streamFn: (model) => {
				calls += 1;
				const stream = createAssistantMessageEventStream();
				const message = createAssistantMessage(model);
				message.stopReason = "error";
				message.errorMessage = "HTTP 429: rate limited";
				stream.push({ type: "error", reason: "error", error: message });
				return stream;
			},
			initialState: { model: "openai:gpt-5.5" },
		});

		await agent.prompt("hello");
		expect(calls).toBe(1);
	});

	it("retries transient errors from a custom stream function", async () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			const streamFn: StreamFn = (model) => {
				calls += 1;
				const stream = createAssistantMessageEventStream();
				const message = createAssistantMessage(model);
				stream.push({ type: "start", partial: message });
				if (calls === 1) {
					message.stopReason = "error";
					message.errorMessage = "HTTP 429: rate limited";
					message.content.push({ type: "text", text: "discarded" });
					stream.push({ type: "error", reason: "error", error: message });
				} else {
					message.content.push({ type: "text", text: "done" });
					stream.push({ type: "done", reason: "stop", message });
				}
				return stream;
			};
			const agent = new CuaAgent({
				browser,
				client,
				streamFn,
				retry: { enabled: true },
				initialState: { model: "openai:gpt-5.5" },
			});
			const prompt = agent.prompt("hello");
			await vi.advanceTimersByTimeAsync(2_000);
			await prompt;

			expect(calls).toBe(2);
			expect(JSON.stringify(agent.state.messages)).toContain("done");
			expect(JSON.stringify(agent.state.messages)).not.toContain("discarded");
		} finally {
			vi.useRealTimers();
		}
	});

	it("composes payload hooks for custom stream functions", async () => {
		const payloads: unknown[] = [];
		const streamFn: StreamFn = (model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				payloads.push(await options?.onPayload?.({ provider: model.provider }, model));
				const message = createAssistantMessage(model);
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			})();
			return stream;
		};

		const agent = new CuaAgent({
			browser,
			client,
			streamFn,
			onPayload: (payload) => ({ payload, userHook: true }),
			initialState: {
				model: "openai:gpt-5.5",
			},
		});

		await agent.prompt("hello");

		expect(payloads).toHaveLength(1);
		expect(payloads[0]).toMatchObject({ payload: { provider: "openai" }, userHook: true });
	});

	it("uses yutori runtime hooks to append screenshots while stripping local executor tools", async () => {
		const payloads: unknown[] = [];
		const screenshotClient = {
			browsers: {
				computer: {
					captureScreenshot: async () => new Response(tinyPng),
				},
			},
		} as unknown as Kernel;
		const streamFn: StreamFn = (model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				payloads.push(
					await options?.onPayload?.(
						{
							messages: [{ role: "user", content: "Inspect the page" }],
							tools: [
								{ type: "function", function: { name: "click" } },
								{ type: "function", function: { name: "computer_use_extra" } },
								{ type: "function", function: { name: "custom_tool" } },
							],
						},
						model,
					),
				);
				const message = createAssistantMessage(model);
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			})();
			return stream;
		};

		const agent = new CuaAgent({
			browser,
			client: screenshotClient,
			streamFn,
			extraTools: [createCustomTool("custom_tool")],
			initialState: {
				model: "yutori:n1.5-latest",
			},
		});

		await agent.prompt("hello");

		const payload = payloads[0] as {
			messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
			tools?: Array<{ function?: { name?: string } }>;
			tool_set?: string;
		};
		expect(payload.tool_set).toBe("browser_tools_core-20260403");
		expect(payload.tools?.map((tool) => tool.function?.name)).toEqual([
			"computer_use_extra",
			"custom_tool",
		]);
		expect(payload.messages[0]!.content.at(-1)?.image_url?.url.startsWith("data:image/webp;base64,")).toBe(true);
	});

	it("leaves pi turn preparation untouched while the runtime is unchanged", async () => {
		const agent = new CuaAgent({
			browser,
			client,
			initialState: { model: "openai:gpt-5.5" },
		});

		await expect(agent.prepareNextTurn?.(undefined)).resolves.toBeUndefined();
	});

	it("builds a one-shot turn update after a mid-run model assignment", async () => {
		const runtime = resolveCuaRuntimeSpec("google:gemini-3-flash-preview");
		const agent = new CuaAgent({
			browser,
			client,
			initialState: { model: "openai:gpt-5.5" },
		});

		agent.state.model = "google:gemini-3-flash-preview";

		const update = await agent.prepareNextTurn?.(undefined);
		expect(update?.model?.id).toBe(runtime.model.id);
		expect(update?.context?.tools).toHaveLength(runtime.toolExecutors.length + 1);

		await expect(agent.prepareNextTurn?.(undefined)).resolves.toBeUndefined();
	});

	it("executes model tool calls against the Kernel browser and feeds the result back", async () => {
		let screenshots = 0;
		const screenshotClient = {
			browsers: {
				computer: {
					captureScreenshot: async () => {
						screenshots += 1;
						return new Response(tinyPng);
					},
				},
			},
		} as unknown as Kernel;
		const contexts: Array<{ messages: Array<{ role: string; content: Array<{ type: string; mimeType?: string }> }> }> = [];
		let providerCalls = 0;
		const streamFn: StreamFn = (model, context, _options) => {
			contexts.push(context as never);
			const stream = createAssistantMessageEventStream();
			const message = createAssistantMessage(model);
			if (providerCalls++ === 0) {
				message.content = [{ type: "toolCall", id: "tool-1", name: "screenshot", arguments: {} }];
				message.stopReason = "toolUse";
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
				stream.end(message);
			} else {
				message.content = [{ type: "text", text: "done" }];
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			}
			return stream;
		};

		const agent = new CuaAgent({
			browser,
			client: screenshotClient,
			streamFn,
			emptyResponseRecovery: { followUp: "continue", maxAttempts: 1 },
			initialState: { model: "openai:gpt-5.5" },
		});

		await agent.prompt("inspect the page");

		expect(screenshots).toBe(1);
		expect(providerCalls).toBe(2);
		const fedBack = contexts[1]!.messages.find((message) => message.role === "toolResult");
		expect(fedBack, "second provider request should carry the tool result").toBeDefined();
		expect(fedBack!.content.some((block) => block.type === "image" && block.mimeType === "image/png")).toBe(true);
	});

	it("stops a native multi-action turn after its first failed action", async () => {
		const contexts: Context[] = [];
		let providerCalls = 0;
		const streamFn: StreamFn = (model, context) => {
			contexts.push({ ...context, messages: structuredClone(context.messages) });
			const stream = createAssistantMessageEventStream();
			const message = createAssistantMessage(model);
			if (providerCalls++ === 0) {
				message.content = [
					{ type: "toolCall", id: "tool-1", name: "browser", arguments: { action: "warp" } },
					{ type: "toolCall", id: "tool-2", name: "browser", arguments: { action: "navigate", url: "https://example.com" } },
				];
				message.stopReason = "toolUse";
			} else {
				message.content = [{ type: "text", text: "done" }];
			}
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
			return stream;
		};
		const agent = new CuaAgent({
			browser,
			client,
			streamFn,
			nativeTool: { type: "browser_20260701" },
			initialState: { model: "anthropic:claude-opus-4-8" },
		});

		await agent.prompt("run two browser actions");

		const results = contexts[1]!.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({ toolCallId: "tool-1", isError: true });
		expect(results[1]).toMatchObject({
			toolCallId: "tool-2",
			isError: true,
			content: [{ type: "text", text: "Not executed: an earlier action in this turn failed." }],
		});
	});

	it("applies screenshot projection after a caller context transform", async () => {
		const history: AgentMessage[] = [];
		for (let index = 1; index <= 5; index += 1) {
			const assistant = createAssistantMessage({ api: "anthropic-messages", provider: "anthropic", id: "test" });
			assistant.content = [{ type: "toolCall", id: `call-${index}`, name: "custom_image", arguments: {} }];
			assistant.stopReason = "toolUse";
			const images = index < 5 ? [index] : [5, 6, 7, 8, 9];
			history.push(assistant, {
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "custom_image",
				content: [
					{ type: "text", text: `result-${index}` },
					...images.map((image) => ({
						type: "image" as const,
						data: Buffer.from(`image-${image}`).toString("base64"),
						mimeType: "image/png",
					})),
				],
				details: { index },
				isError: false,
				timestamp: index,
			});
		}

		let providerContext: Parameters<StreamFn>[1] | undefined;
		const streamFn: StreamFn = (model, context) => {
			providerContext = context;
			const stream = createAssistantMessageEventStream();
			const message = createAssistantMessage(model);
			message.content = [{ type: "text", text: "done" }];
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		};
		const agent = new CuaAgent({
			browser,
			client,
			streamFn,
			transformContext: async (messages) =>
				messages.map((message) =>
					message.role === "user" && Array.isArray(message.content)
						? {
								...message,
								content: message.content.map((block) =>
									block.type === "text" ? { ...block, text: `caller:${block.text}` } : block,
								),
							}
						: message,
				),
			initialState: { model: "anthropic:claude-haiku-4-5", messages: history },
		});

		await agent.prompt("next");

		const projected = providerContext!.messages;
		const projectedImages = projected.flatMap((message) => message.content).filter((block) => block.type === "image");
		expect(projectedImages.map((block) => Buffer.from(block.data, "base64").toString())).toEqual([
			"image-6",
			"image-7",
			"image-8",
			"image-9",
		]);
		const finalResult = projected.find(
			(message) => message.role === "toolResult" && message.toolCallId === "call-5",
		);
		expect(finalResult?.content).toContainEqual({ type: "text", text: "result-5" });
		expect(
			finalResult?.content.filter(
				(block) => block.type === "text" && block.text === "[stale tool-result images omitted]",
			),
		).toHaveLength(1);
		expect(
			projected.flatMap((message) => message.content).some((block) => block.type === "text" && block.text === "caller:next"),
		).toBe(true);
		expect(
			projected.filter((message) => message.role === "toolResult").map(({ toolCallId, toolName, details, isError, timestamp }) => ({
				toolCallId,
				toolName,
				details,
				isError,
				timestamp,
			})),
		).toEqual(
			Array.from({ length: 5 }, (_, index) => ({
				toolCallId: `call-${index + 1}`,
				toolName: "custom_image",
				details: { index: index + 1 },
				isError: false,
				timestamp: index + 1,
			})),
		);
		expect(agent.state.messages.flatMap((message) => message.content).filter((block) => block.type === "image")).toHaveLength(9);
	});

	it.each([
		{ limit: 2 as const, expected: ["image-4", "image-5"] },
		{ limit: 0 as const, expected: [] },
		{ limit: false as const, expected: ["image-1", "image-2", "image-3", "image-4", "image-5"] },
	])("supports toolResultImageReplayLimit=$limit", async ({ limit, expected }) => {
		const history: AgentMessage[] = Array.from({ length: 5 }, (_, index) => ({
			role: "toolResult" as const,
			toolCallId: `call-${index + 1}`,
			toolName: "custom_image",
			content: [{
				type: "image" as const,
				data: Buffer.from(`image-${index + 1}`).toString("base64"),
				mimeType: "image/png",
			}],
			details: {},
			isError: false,
			timestamp: index + 1,
		}));
		let providerContext: Parameters<StreamFn>[1] | undefined;
		const streamFn: StreamFn = (model, context) => {
			providerContext = context;
			const stream = createAssistantMessageEventStream();
			const message = createAssistantMessage(model);
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		};
		const agent = new CuaAgent({
			browser,
			client,
			streamFn,
			toolResultImageReplayLimit: limit,
			initialState: { model: "anthropic:claude-haiku-4-5", messages: history },
		});

		await agent.prompt("next");

		expect(
			providerContext!.messages
				.flatMap((message) => message.content)
				.filter((block) => block.type === "image")
				.map((block) => Buffer.from(block.data, "base64").toString()),
		).toEqual(expected);
		expect(agent.state.messages.flatMap((message) => message.content).filter((block) => block.type === "image")).toHaveLength(5);
	});

	it.each([true, false])("passes responseThreading=$enabled to provider streams", async (enabled) => {
		let streamOptions: CuaSimpleStreamOptions | undefined;
		const streamFn: StreamFn = (model, _context, options) => {
			streamOptions = options as CuaSimpleStreamOptions;
			const stream = createAssistantMessageEventStream();
			const message = createAssistantMessage(model);
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		};
		const agent = new CuaAgent({
			browser,
			client,
			streamFn,
			responseThreading: enabled,
			initialState: { model: "openai:gpt-5.5" },
		});

		await agent.prompt("next");

		expect(streamOptions?.disableResponseThreading).toBe(!enabled);
	});

	it("rejects invalid context-management options", async () => {
		expect(() => new CuaAgent({
			browser,
			client,
			responseThreading: "false" as never,
			initialState: { model: "openai:gpt-5.5" },
		})).toThrow(new TypeError("responseThreading must be a boolean"));

		const services = await createHarnessServices();
		expect(() => new CuaAgentHarness({
			...services,
			browser,
			client,
			model: "openai:gpt-5.5",
			responseThreading: "false" as never,
		})).toThrow(new TypeError("responseThreading must be a boolean"));

		for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => new CuaAgent({
				browser,
				client,
				toolResultImageReplayLimit: limit,
				initialState: { model: "openai:gpt-5.5" },
			})).toThrow(new TypeError("toolResultImageReplayLimit must be a finite non-negative integer or false"));

			const services = await createHarnessServices();
			expect(() => new CuaAgentHarness({
				...services,
				browser,
				client,
				model: "openai:gpt-5.5",
				toolResultImageReplayLimit: limit,
			})).toThrow(new TypeError("toolResultImageReplayLimit must be a finite non-negative integer or false"));
		}
	});

	const recovery = { followUp: "  Please continue exactly.  ", maxAttempts: 1 };

	it("preserves pi completion semantics when recovery is omitted", async () => {
		const scripted = createScriptedStream([undefined]);
		const agent = new CuaAgent({
			browser,
			client,
			streamFn: scripted.streamFn,
			initialState: { model: "openai:gpt-5.5" },
		});

		await agent.prompt("finish the task");

		expect(scripted.calls()).toBe(1);
		expect(agent.state.messages.at(-1)?.content).toEqual([]);
		expect(agent.state.messages.filter((message) => message.role === "user")).toHaveLength(1);
	});

	it("uses pi followUp for explicit empty-response recovery", async () => {
		const contexts: Array<{
			messages: Array<{
				role: string;
				content: Array<{ type: string; text?: string }>;
			}>;
		}> = [];
		const scripted = createScriptedStream([undefined, "finished"], contexts);
		const agent = new CuaAgent({
			browser,
			client,
			streamFn: scripted.streamFn,
			emptyResponseRecovery: recovery,
			initialState: { model: "openai:gpt-5.5" },
		});

		await agent.prompt("finish the task");

		expect(scripted.calls()).toBe(2);
		const messages = contexts[1]!.messages;
		expect(messages.at(-2)).toMatchObject({ role: "assistant", content: [] });
		expect(messages.at(-1)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: recovery.followUp }],
		});
	});

	it("enforces and resets the configured recovery budget", async () => {
		const scripted = createScriptedStream([undefined, undefined, undefined, "done"]);
		const agent = new CuaAgent({
			browser,
			client,
			streamFn: scripted.streamFn,
			emptyResponseRecovery: recovery,
			initialState: { model: "openai:gpt-5.5" },
		});

		await agent.prompt("first");
		expect(scripted.calls()).toBe(2);
		await agent.prompt("second");
		expect(scripted.calls()).toBe(4);
	});

	it("makes exactly one additional call per configured attempt", async () => {
		const scripted = createScriptedStream([undefined, undefined, undefined]);
		const agent = new CuaAgent({
			browser,
			client,
			streamFn: scripted.streamFn,
			emptyResponseRecovery: { followUp: "continue", maxAttempts: 2 },
			initialState: { model: "openai:gpt-5.5" },
		});

		await agent.prompt("task");
		expect(scripted.calls()).toBe(3);
	});

	it("recovers exact-empty content regardless of usage accounting", async () => {
		let calls = 0;
		const streamFn: StreamFn = (model) => {
			const stream = createAssistantMessageEventStream();
			const message = finishMessage(createAssistantMessage(model), calls++ === 0 ? undefined : "done");
			if (message.content.length === 0) {
				message.usage.output = 7;
				message.usage.reasoning = 5;
			}
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		};
		const agent = new CuaAgent({
			browser,
			client,
			streamFn,
			emptyResponseRecovery: recovery,
			initialState: { model: "openai:gpt-5.5" },
		});

		await agent.prompt("task");
		expect(calls).toBe(2);
	});

	it.each([
		["whitespace text", [{ type: "text", text: "   " }], "stop"],
		["thinking content", [{ type: "thinking", thinking: "working" }], "stop"],
		["length stop", [], "length"],
		["error stop", [], "error"],
		["aborted stop", [], "aborted"],
	] as const)("does not recover %s", async (_name, content, stopReason) => {
		let calls = 0;
		const streamFn: StreamFn = (model) => {
			calls += 1;
			const stream = createAssistantMessageEventStream();
			const message = createAssistantMessage(model);
			message.content = [...content] as AssistantMessage["content"];
			message.stopReason = stopReason;
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: stopReason, message });
			stream.end(message);
			return stream;
		};
		const agent = new CuaAgent({
			browser,
			client,
			streamFn,
			emptyResponseRecovery: recovery,
			initialState: { model: "openai:gpt-5.5" },
		});

		await agent.prompt("task");
		expect(calls).toBe(1);
	});

	it.each([[-1], [1.5], [Number.POSITIVE_INFINITY], [Number.NaN]])("rejects invalid maxAttempts %s", (maxAttempts) => {
		expect(
			() =>
				new CuaAgent({
					browser,
					client,
					emptyResponseRecovery: { followUp: "continue", maxAttempts },
					initialState: { model: "openai:gpt-5.5" },
				}),
		).toThrow(/non-negative finite integer/);
	});

	it("rejects blank follow-up text and accepts zero attempts", async () => {
		expect(
			() =>
				new CuaAgent({
					browser,
					client,
					emptyResponseRecovery: { followUp: "  ", maxAttempts: 1 },
					initialState: { model: "openai:gpt-5.5" },
				}),
		).toThrow(/must not be blank/);
		const scripted = createScriptedStream([undefined]);
		const agent = new CuaAgent({
			browser,
			client,
			streamFn: scripted.streamFn,
			emptyResponseRecovery: { followUp: "continue", maxAttempts: 0 },
			initialState: { model: "openai:gpt-5.5" },
		});
		await agent.prompt("task");
		expect(scripted.calls()).toBe(1);
	});

	it.each(["one-at-a-time", "all"] as const)(
		"lets queued caller work drain before recovery in %s mode",
		async (mode) => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const contexts: Array<{
				messages: Array<{
					role: string;
					content: Array<{ type: string; text?: string }>;
				}>;
			}> = [];
			let calls = 0;
			const streamFn: StreamFn = (model, context) => {
				contexts.push(context as never);
				const stream = createAssistantMessageEventStream();
				const message = finishMessage(createAssistantMessage(model), calls === 2 ? "recovered" : undefined);
				calls += 1;
				void (async () => {
					if (calls === 1) await gate;
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
				})();
				return stream;
			};
			const agent = new CuaAgent({
				browser,
				client,
				streamFn,
				followUpMode: mode,
				emptyResponseRecovery: recovery,
				initialState: { model: "openai:gpt-5.5" },
			});
			const prompt = agent.prompt("task");
			await vi.waitFor(() => expect(calls).toBe(1));
			agent.followUp({
				role: "user",
				content: [{ type: "text", text: "caller" }],
				timestamp: Date.now(),
			});
			release();
			await prompt;

			expect(calls).toBe(3);
			expect(contexts[1]!.messages.at(-1)).toMatchObject({
				role: "user",
				content: [{ text: "caller" }],
			});
			expect(contexts[2]!.messages.at(-1)).toMatchObject({
				role: "user",
				content: [{ text: recovery.followUp }],
			});
		},
	);

	it("does not recover when the active signal is aborted", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const streamFn: StreamFn = (model) => {
			calls += 1;
			const stream = createAssistantMessageEventStream();
			const message = createAssistantMessage(model);
			void gate.then(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		};
		const agent = new CuaAgent({
			browser,
			client,
			streamFn,
			emptyResponseRecovery: recovery,
			initialState: { model: "openai:gpt-5.5" },
		});
		const prompt = agent.prompt("task");
		await vi.waitFor(() => expect(calls).toBe(1));
		agent.abort();
		release();
		await prompt;
		expect(calls).toBe(1);
	});
});

describe("CuaAgentHarness", () => {
	const recovery = { followUp: "  Please continue exactly.  ", maxAttempts: 1 };

	it("preserves pi completion semantics when recovery is omitted", async () => {
		const scripted = createScriptedModels([undefined]);
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "openai:gpt-5.5",
			models: scripted.models,
		});

		const response = await harness.prompt("finish the task");
		expect(scripted.calls()).toBe(1);
		expect(response.content).toEqual([]);
	});

	it("uses pi followUp for explicit empty-response recovery", async () => {
		const contexts: Array<{
			messages: Array<{
				role: string;
				content: Array<{ type: string; text?: string }>;
			}>;
		}> = [];
		const scripted = createScriptedModels([undefined, "finished"], contexts);
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "openai:gpt-5.5",
			models: scripted.models,
			emptyResponseRecovery: recovery,
		});

		const response = await harness.prompt("finish the task");

		expect(scripted.calls()).toBe(2);
		expect(response.content).toEqual([{ type: "text", text: "finished" }]);
		expect(contexts[1]!.messages.at(-2)).toMatchObject({
			role: "assistant",
			content: [],
		});
		expect(contexts[1]!.messages.at(-1)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: recovery.followUp }],
		});
	});

	it("enforces and resets the configured recovery budget", async () => {
		const scripted = createScriptedModels([undefined, undefined, undefined, "done"]);
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "openai:gpt-5.5",
			models: scripted.models,
			emptyResponseRecovery: recovery,
		});

		await harness.prompt("first");
		expect(scripted.calls()).toBe(2);
		await harness.prompt("second");
		expect(scripted.calls()).toBe(4);
	});

	it("clears stale queue snapshots before a new prompt starts", async () => {
		const scripted = createScriptedModels([undefined, "finished"]);
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "openai:gpt-5.5",
			models: scripted.models,
			emptyResponseRecovery: recovery,
		});

		(harness as unknown as { hasPendingActiveQueue: boolean }).hasPendingActiveQueue = true;
		const response = await harness.prompt("finish the task");

		expect(scripted.calls()).toBe(2);
		expect(response.content).toEqual([{ type: "text", text: "finished" }]);
	});

	it("makes exactly one additional call per configured attempt", async () => {
		const scripted = createScriptedModels([undefined, undefined, undefined]);
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "openai:gpt-5.5",
			models: scripted.models,
			emptyResponseRecovery: { followUp: "continue", maxAttempts: 2 },
		});

		await harness.prompt("task");
		expect(scripted.calls()).toBe(3);
	});

	it("recovers exact-empty content with nonzero usage", async () => {
		let calls = 0;
		const streamFn: StreamFn = (model) => {
			const stream = createAssistantMessageEventStream();
			const message = finishMessage(createAssistantMessage(model), calls++ === 0 ? undefined : "done");
			if (message.content.length === 0) {
				message.usage.output = 9;
				message.usage.reasoning = 6;
			}
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		};
		const models = createModelsFromStream(streamFn);
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "openai:gpt-5.5",
			models,
			emptyResponseRecovery: recovery,
		});

		await harness.prompt("task");
		expect(calls).toBe(2);
	});

	it.each([
		["whitespace text", [{ type: "text", text: "   " }], "stop"],
		["thinking content", [{ type: "thinking", thinking: "working" }], "stop"],
		["length stop", [], "length"],
		["error stop", [], "error"],
		["aborted stop", [], "aborted"],
	] as const)("does not recover %s", async (_name, content, stopReason) => {
		let calls = 0;
		const streamFn: StreamFn = (model) => {
			calls += 1;
			const stream = createAssistantMessageEventStream();
			const message = createAssistantMessage(model);
			message.content = [...content] as AssistantMessage["content"];
			message.stopReason = stopReason;
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: stopReason, message });
			stream.end(message);
			return stream;
		};
		const models = createModelsFromStream(streamFn);
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "openai:gpt-5.5",
			models,
			emptyResponseRecovery: recovery,
		});

		await harness.prompt("task");
		expect(calls).toBe(1);
	});

	it("does not treat a tool-use turn as an empty response", async () => {
		let calls = 0;
		const streamFn: StreamFn = (model) => {
			const stream = createAssistantMessageEventStream();
			const message = createAssistantMessage(model);
			if (calls++ === 0) {
				message.content = [{ type: "toolCall", id: "tool-1", name: "custom", arguments: {} }];
				message.stopReason = "toolUse";
			} else {
				message.content = [{ type: "text", text: "done" }];
			}
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
			return stream;
		};
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "openai:gpt-5.5",
			models: createModelsFromStream(streamFn),
			extraTools: [createCustomTool()],
			emptyResponseRecovery: recovery,
		});

		await harness.prompt("task");
		expect(calls).toBe(2);
	});

	it("stops a native harness turn after its first failed action", async () => {
		const contexts: Context[] = [];
		let calls = 0;
		const streamFn: StreamFn = (model, context) => {
			contexts.push({ ...context, messages: structuredClone(context.messages) });
			const stream = createAssistantMessageEventStream();
			const message = createAssistantMessage(model);
			if (calls++ === 0) {
				message.content = [
					{ type: "toolCall", id: "tool-1", name: "computer", arguments: { action: "warp" } },
					{ type: "toolCall", id: "tool-2", name: "computer", arguments: { action: "screenshot" } },
				];
				message.stopReason = "toolUse";
			} else {
				message.content = [{ type: "text", text: "done" }];
			}
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
			return stream;
		};
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "anthropic:claude-opus-4-8",
			models: createModelsFromStream(streamFn, "anthropic"),
			nativeTool: { type: "computer_20260701" },
		});

		await harness.prompt("run two computer actions");

		const results = contexts[1]!.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({ toolCallId: "tool-1", isError: true });
		expect(results[1]).toMatchObject({
			toolCallId: "tool-2",
			isError: true,
			content: [{ type: "text", text: "Not executed: an earlier computer action in this turn failed." }],
		});
	});

	it.each([[-1], [1.5], [Number.POSITIVE_INFINITY], [Number.NaN]])(
		"rejects invalid maxAttempts %s",
		async (maxAttempts) => {
			const services = await createHarnessServices();
			expect(
				() =>
					new CuaAgentHarness({
						...services,
						browser,
						client,
						model: "openai:gpt-5.5",
						emptyResponseRecovery: { followUp: "continue", maxAttempts },
					}),
			).toThrow(/non-negative finite integer/);
		},
	);

	it("rejects blank follow-up text and accepts zero attempts", async () => {
		const services = await createHarnessServices();
		expect(
			() =>
				new CuaAgentHarness({
					...services,
					browser,
					client,
					model: "openai:gpt-5.5",
					emptyResponseRecovery: { followUp: " ", maxAttempts: 1 },
				}),
		).toThrow(/must not be blank/);
		const scripted = createScriptedModels([undefined]);
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "openai:gpt-5.5",
			models: scripted.models,
			emptyResponseRecovery: { followUp: "continue", maxAttempts: 0 },
		});
		await harness.prompt("task");
		expect(scripted.calls()).toBe(1);
	});

	it.each(["one-at-a-time", "all"] as const)(
		"lets queued caller work drain before recovery in %s mode",
		async (mode) => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const contexts: Array<{
				messages: Array<{
					role: string;
					content: Array<{ type: string; text?: string }>;
				}>;
			}> = [];
			let calls = 0;
			const streamFn: StreamFn = (model, context) => {
				contexts.push(context as never);
				const stream = createAssistantMessageEventStream();
				const message = finishMessage(createAssistantMessage(model), calls === 2 ? "recovered" : undefined);
				calls += 1;
				void (async () => {
					if (calls === 1) await gate;
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
				})();
				return stream;
			};
			const models = createModelsFromStream(streamFn);
			const harness = new CuaAgentHarness({
				...(await createHarnessServices()),
				browser,
				client,
				model: "openai:gpt-5.5",
				models,
				emptyResponseRecovery: recovery,
			});
			await harness.setFollowUpMode(mode);
			const prompt = harness.prompt("task");
			await vi.waitFor(() => expect(calls).toBe(1));
			await harness.followUp("caller");
			release();
			await prompt;

			expect(calls).toBe(3);
			expect(contexts[1]!.messages.at(-1)).toMatchObject({
				role: "user",
				content: [{ text: "caller" }],
			});
			expect(contexts[2]!.messages.at(-1)).toMatchObject({
				role: "user",
				content: [{ text: recovery.followUp }],
			});
		},
	);

	it("does not let nextTurn suppress active-run recovery", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const contexts: Array<{
			messages: Array<{
				role: string;
				content: Array<{ type: string; text?: string }>;
			}>;
		}> = [];
		let calls = 0;
		const streamFn: StreamFn = (model, context) => {
			contexts.push(context as never);
			const stream = createAssistantMessageEventStream();
			const message = finishMessage(createAssistantMessage(model), calls++ === 0 ? undefined : "done");
			void (async () => {
				if (calls === 1) await gate;
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			})();
			return stream;
		};
		const models = createModelsFromStream(streamFn);
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "openai:gpt-5.5",
			models,
			emptyResponseRecovery: recovery,
		});
		const prompt = harness.prompt("first");
		await vi.waitFor(() => expect(calls).toBe(1));
		await harness.nextTurn("later");
		release();
		await prompt;
		expect(calls).toBe(2);
		expect(contexts[1]!.messages.at(-1)).toMatchObject({
			role: "user",
			content: [{ text: recovery.followUp }],
		});

		await harness.prompt("second");
		expect(
			contexts[2]!.messages.some(
				(message) => message.role === "user" && message.content.some((block) => block.text === "later"),
			),
		).toBe(true);
	});

	it("does not recover when the active signal is aborted", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const streamFn: StreamFn = (model) => {
			calls += 1;
			const stream = createAssistantMessageEventStream();
			const message = createAssistantMessage(model);
			void gate.then(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		};
		const models = createModelsFromStream(streamFn);
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "openai:gpt-5.5",
			models,
			emptyResponseRecovery: recovery,
		});
		const prompt = harness.prompt("task");
		await vi.waitFor(() => expect(calls).toBe(1));
		const abort = harness.abort();
		release();
		await abort;
		await prompt;
		expect(calls).toBe(1);
	});
	it.each([
		{ limit: 2 as const, expected: ["image-4", "image-5"] },
		{ limit: 0 as const, expected: [] },
		{ limit: false as const, expected: ["image-1", "image-2", "image-3", "image-4", "image-5"] },
	])("supports toolResultImageReplayLimit=$limit", async ({ limit, expected }) => {
		const services = await createHarnessServices();
		for (let index = 1; index <= 5; index += 1) {
			await services.session.appendMessage({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "custom_image",
				content: [{ type: "image", data: Buffer.from(`image-${index}`).toString("base64"), mimeType: "image/png" }],
				details: {},
				isError: false,
				timestamp: index,
			});
		}
		let providerContext: Parameters<StreamFn>[1] | undefined;
		const streamFn: StreamFn = (model, context) => {
			providerContext = context;
			const stream = createAssistantMessageEventStream();
			const message = createAssistantMessage(model);
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		};
		const models = createCuaModels();
		models.setProvider({
			id: "anthropic",
			name: "stateless test provider",
			auth: { apiKey: { name: "test key", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
			getModels: () => [],
			stream: streamFn,
			streamSimple: streamFn,
		});
		const harness = new CuaAgentHarness({
			...services,
			browser,
			client,
			model: "anthropic:claude-haiku-4-5",
			models,
			toolResultImageReplayLimit: limit,
		});

		await harness.prompt("next");

		expect(
			providerContext!.messages
				.flatMap((message) => message.content)
				.filter((block) => block.type === "image")
				.map((block) => Buffer.from(block.data, "base64").toString()),
		).toEqual(expected);
		const stored = await services.session.buildContext();
		expect(stored.messages.flatMap((message) => message.content).filter((block) => block.type === "image")).toHaveLength(5);
	});

	it.each([true, false])("applies context management through all harness model methods", async (enabled) => {
		const services = await createHarnessServices();
		let streamOptions: CuaSimpleStreamOptions | undefined;
		let providerImageCount = -1;
		const streamFn: StreamFn = (model, context, options) => {
			streamOptions = options as CuaSimpleStreamOptions;
			providerImageCount = context.messages.flatMap((message) => message.content).filter((block) => block.type === "image").length;
			const stream = createAssistantMessageEventStream();
			const message = createAssistantMessage(model);
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		};
		const models = createCuaModels();
		models.setProvider({
			id: "openai",
			name: "threading test provider",
			auth: { apiKey: { name: "test key", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
			getModels: () => [],
			stream: streamFn,
			streamSimple: streamFn,
		});
		const harness = new CuaAgentHarness({
			...services,
			browser,
			client,
			model: "openai:gpt-5.5",
			models,
			responseThreading: enabled,
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		});

		const expected = enabled ? undefined : true;
		const context: Context = {
			messages: Array.from({ length: 5 }, (_, index) => ({
				role: "toolResult" as const,
				toolCallId: `call-${index}`,
				toolName: "screenshot",
				content: [{ type: "image" as const, data: `${index}`, mimeType: "image/png" }],
				isError: false,
				timestamp: index,
			})),
		};
		const model = harness.getModel();

		await harness.models.stream(model, context).result();
		expect(streamOptions?.disableResponseThreading).toBe(expected);
		expect(providerImageCount).toBe(4);
		streamOptions = undefined;

		await harness.models.complete(model, context);
		expect(streamOptions?.disableResponseThreading).toBe(expected);
		expect(providerImageCount).toBe(4);
		streamOptions = undefined;

		await harness.models.streamSimple(model, context).result();
		expect(streamOptions?.disableResponseThreading).toBe(expected);
		expect(providerImageCount).toBe(4);
		streamOptions = undefined;

		await harness.models.completeSimple(model, context);
		expect(streamOptions?.disableResponseThreading).toBe(expected);
		expect(providerImageCount).toBe(4);
	});

	it("applies image projection after user context hooks", async () => {
		const run = async (replace: boolean) => {
			const services = await createHarnessServices();
			for (let index = 1; index <= 5; index += 1) {
				await services.session.appendMessage({
					role: "toolResult",
					toolCallId: `call-${index}`,
					toolName: "custom_image",
					content: [{ type: "image", data: `${index}`, mimeType: "image/png" }],
					details: {},
					isError: false,
					timestamp: index,
				});
			}
			let providerImageCount = -1;
			let providerOmissionCount = -1;
			let observedImageCount = -1;
			const streamFn: StreamFn = (model, context) => {
				providerImageCount = context.messages.flatMap((message) => message.content).filter((block) => block.type === "image").length;
				providerOmissionCount = context.messages
					.flatMap((message) => message.content)
					.filter((block) => block.type === "text" && block.text === "[stale tool-result images omitted]").length;
				const stream = createAssistantMessageEventStream();
				const message = createAssistantMessage(model);
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			};
			const models = createCuaModels();
			models.setProvider({
				id: "anthropic",
				name: "stateless test provider",
				auth: { apiKey: { name: "test key", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
				getModels: () => [],
				stream: streamFn,
				streamSimple: streamFn,
			});
			const harness = new CuaAgentHarness({ ...services, browser, client, model: "anthropic:claude-haiku-4-5", models });
			harness.on("context", ({ messages }) => {
				observedImageCount = messages.flatMap((message) => message.content).filter((block) => block.type === "image").length;
				return replace ? { messages } : undefined;
			});

			await harness.prompt("next");
			return { observedImageCount, providerImageCount, providerOmissionCount };
		};

		await expect(run(false)).resolves.toEqual({ observedImageCount: 5, providerImageCount: 4, providerOmissionCount: 1 });
		await expect(run(true)).resolves.toEqual({ observedImageCount: 5, providerImageCount: 4, providerOmissionCount: 1 });
	});

	it("bounds screenshots retained across long stateless CUA trajectories", async () => {
		const contexts: Parameters<StreamFn>[1][] = [];
		let providerCalls = 0;
		const models = createCuaModels();
		const streamFn: StreamFn = (model, context) => {
			contexts.push({ ...context, messages: structuredClone(context.messages) });
			const stream = createAssistantMessageEventStream();
			const message = createAssistantMessage(model);
			if (providerCalls++ % 2 === 0) {
				message.content = [{ type: "toolCall", id: `screenshot-${providerCalls}`, name: "screenshot", arguments: {} }];
				message.stopReason = "toolUse";
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
			} else {
				message.content = [{ type: "text", text: "continue" }];
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			}
			stream.end(message);
			return stream;
		};
		models.setProvider({
			id: "anthropic",
			name: "stateless test provider",
			auth: { apiKey: { name: "test key", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
			getModels: () => [],
			stream: streamFn,
			streamSimple: streamFn,
		});

		let screenshots = 0;
		const screenshotClient = {
			browsers: {
				computer: { captureScreenshot: async () => new Response(Buffer.from(`screenshot-${++screenshots}`)) },
			},
		} as unknown as Kernel;
		const services = await createHarnessServices();
		const harness = new CuaAgentHarness({
			...services,
			browser,
			client: screenshotClient,
			model: "anthropic:claude-haiku-4-5",
			models,
		});

		for (let turn = 0; turn < 9; turn += 1) await harness.prompt(`turn ${turn}`);

		const providerImages = contexts.map((context) =>
			context.messages
				.flatMap((message) => message.content)
				.filter((block) => block.type === "image")
				.map((block) => Buffer.from(block.data, "base64").toString()),
		);
		expect(providerImages).toEqual([
			[],
			["screenshot-1"],
			["screenshot-1"],
			["screenshot-1", "screenshot-2"],
			["screenshot-1", "screenshot-2"],
			["screenshot-1", "screenshot-2", "screenshot-3"],
			["screenshot-1", "screenshot-2", "screenshot-3"],
			["screenshot-1", "screenshot-2", "screenshot-3", "screenshot-4"],
			["screenshot-1", "screenshot-2", "screenshot-3", "screenshot-4"],
			["screenshot-2", "screenshot-3", "screenshot-4", "screenshot-5"],
			["screenshot-2", "screenshot-3", "screenshot-4", "screenshot-5"],
			["screenshot-3", "screenshot-4", "screenshot-5", "screenshot-6"],
			["screenshot-3", "screenshot-4", "screenshot-5", "screenshot-6"],
			["screenshot-4", "screenshot-5", "screenshot-6", "screenshot-7"],
			["screenshot-4", "screenshot-5", "screenshot-6", "screenshot-7"],
			["screenshot-5", "screenshot-6", "screenshot-7", "screenshot-8"],
			["screenshot-5", "screenshot-6", "screenshot-7", "screenshot-8"],
			["screenshot-6", "screenshot-7", "screenshot-8", "screenshot-9"],
		]);
		expect(Math.max(...providerImages.map((images) => images.length))).toBeLessThanOrEqual(4);

		const omissionCounts = contexts.map((context) =>
			context.messages
				.flatMap((message) => message.content)
				.filter((block) => block.type === "text" && block.text === "[stale tool-result images omitted]").length,
		);
		expect(omissionCounts[9]).toBe(1);
		expect(omissionCounts[17]).toBe(5);

		const stored = await services.session.buildContext();
		expect(
			stored.messages.flatMap((message) => message.content).filter((block) => block.type === "image"),
		).toHaveLength(9);
	});

	it("projects stale images returned by extra tools without removing their result shell", async () => {
		const contexts: Parameters<StreamFn>[1][] = [];
		const tools = ["image_extra", "screenshot", "screenshot", "screenshot", "screenshot"];
		let providerCalls = 0;
		const models = createCuaModels();
		const streamFn: StreamFn = (model, context) => {
			contexts.push({ ...context, messages: structuredClone(context.messages) });
			const stream = createAssistantMessageEventStream();
			const message = createAssistantMessage(model);
			if (providerCalls % 2 === 0) {
				const turn = providerCalls / 2;
				message.content = [{ type: "toolCall", id: `call-${turn}`, name: tools[turn]!, arguments: {} }];
				message.stopReason = "toolUse";
			} else {
				message.content = [{ type: "text", text: "continue" }];
			}
			providerCalls += 1;
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
			return stream;
		};
		models.setProvider({
			id: "anthropic",
			name: "stateless test provider",
			auth: { apiKey: { name: "test key", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
			getModels: () => [],
			stream: streamFn,
			streamSimple: streamFn,
		});
		let screenshots = 0;
		const services = await createHarnessServices();
		const harness = new CuaAgentHarness({
			...services,
			browser,
			client: {
				browsers: { computer: { captureScreenshot: async () => new Response(Buffer.from(`builtin-${++screenshots}`)) } },
			} as unknown as Kernel,
			model: "anthropic:claude-haiku-4-5",
			models,
			extraTools: [{
				...createCustomTool("image_extra"),
				async execute() {
					return {
						content: [
							{ type: "text" as const, text: "extra text" },
							{ type: "image" as const, data: Buffer.from("extra-image").toString("base64"), mimeType: "image/png" },
						],
						details: { source: "extra" },
					};
				},
			}],
		});

		for (let turn = 0; turn < tools.length; turn += 1) await harness.prompt(`turn ${turn}`);

		const finalContext = contexts.at(-1)!;
		const extraResult = finalContext.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "call-0",
		);
		expect(extraResult).toMatchObject({
			role: "toolResult",
			toolCallId: "call-0",
			toolName: "image_extra",
			details: { source: "extra" },
			isError: false,
		});
		expect(extraResult?.content).toEqual([
			{ type: "text", text: "extra text" },
			{ type: "text", text: "[stale tool-result images omitted]" },
		]);
		expect(finalContext.messages.some((message) =>
			message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.id === "call-0"),
		)).toBe(true);
		expect(
			finalContext.messages.flatMap((message) => message.content).filter((block) => block.type === "image").map((block) => Buffer.from(block.data, "base64").toString()),
		).toEqual(["builtin-1", "builtin-2", "builtin-3", "builtin-4"]);
		const stored = await services.session.buildContext();
		expect(stored.messages.flatMap((message) => message.content).filter((block) => block.type === "image")).toHaveLength(5);
	});

	it("caps a multi-screenshot computer_batch result by image ordinal", async () => {
		const contexts: Parameters<StreamFn>[1][] = [];
		let providerCalls = 0;
		const models = createCuaModels();
		const streamFn: StreamFn = (model, context) => {
			contexts.push({ ...context, messages: structuredClone(context.messages) });
			const stream = createAssistantMessageEventStream();
			const message = createAssistantMessage(model);
			if (providerCalls++ === 0) {
				message.content = [{
					type: "toolCall",
					id: "batch-1",
					name: ANTHROPIC_BATCH_TOOL_NAME,
					arguments: { actions: [
						{ type: "screenshot" }, { type: "screenshot" }, { type: "screenshot" },
						{ type: "screenshot" }, { type: "cursor_position" },
						{ type: "screenshot" }, { type: "screenshot" },
					] },
				}];
				message.stopReason = "toolUse";
			} else {
				message.content = [{ type: "text", text: "done" }];
			}
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
			return stream;
		};
		models.setProvider({
			id: "anthropic",
			name: "stateless test provider",
			auth: { apiKey: { name: "test key", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
			getModels: () => [],
			stream: streamFn,
			streamSimple: streamFn,
		});
		let screenshots = 0;
		const services = await createHarnessServices();
		const harness = new CuaAgentHarness({
			...services,
			browser,
			client: { browsers: { computer: {
				captureScreenshot: async () => new Response(Buffer.from(`batch-${++screenshots}`)),
				getMousePosition: async () => ({ x: 17, y: 23 }),
			} } } as unknown as Kernel,
			model: "anthropic:claude-haiku-4-5",
			models,
		});

		await harness.prompt("inspect several frames");

		const followUp = contexts[1]!;
		const result = followUp.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "batch-1",
		);
		expect(result).toMatchObject({
			role: "toolResult",
			toolCallId: "batch-1",
			toolName: ANTHROPIC_BATCH_TOOL_NAME,
			isError: false,
			details: {
				statusText: "Actions executed successfully.",
				readResults: [
					{ type: "screenshot", bytes: 7 }, { type: "screenshot", bytes: 7 },
					{ type: "screenshot", bytes: 7 }, { type: "screenshot", bytes: 7 },
					{ type: "cursor_position", x: 17, y: 23 },
					{ type: "screenshot", bytes: 7 }, { type: "screenshot", bytes: 7 },
				],
			},
		});
		expect(result?.content).toEqual([
			{ type: "text", text: "[stale tool-result images omitted]" },
			{ type: "image", data: Buffer.from("batch-3").toString("base64"), mimeType: "image/png" },
			{ type: "image", data: Buffer.from("batch-4").toString("base64"), mimeType: "image/png" },
			{ type: "text", text: "cursor_position(): 17,23" },
			{ type: "image", data: Buffer.from("batch-5").toString("base64"), mimeType: "image/png" },
			{ type: "image", data: Buffer.from("batch-6").toString("base64"), mimeType: "image/png" },
		]);
		expect(result?.content.filter((block) => block.type === "text" && block.text === "[stale tool-result images omitted]")).toHaveLength(1);
		expect(followUp.messages.some((message) =>
			message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.id === "batch-1"),
		)).toBe(true);
		expect(followUp.messages.flatMap((message) => message.content).filter((block) => block.type === "image")).toHaveLength(4);
		const stored = await services.session.buildContext();
		expect(stored.messages.flatMap((message) => message.content).filter((block) => block.type === "image")).toHaveLength(6);
	});

	it("extends pi AgentHarness and resolves model refs", async () => {
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "openai:gpt-5.5",
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});
		expect(harness).toBeInstanceOf(AgentHarness);
		expect(harness.getModel().id).toBe("gpt-5.5");
		expect(harness.getTools().length).toBeGreaterThan(0);
	});

	it("refreshes CUA runtime state through setModel", async () => {
		const runtime = resolveCuaRuntimeSpec("google:gemini-3-flash-preview");
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "openai:gpt-5.5",
		});

		await harness.setModel("google:gemini-3-flash-preview");

		expect(harness.getModel().id).toBe(runtime.model.id);
		expect(harness.getTools()).toHaveLength(runtime.toolExecutors.length + 1);
	});

	it("switches action planes through setMode", async () => {
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "anthropic:claude-opus-4-5",
		});
		expect(harness.getMode()).toBe("computer");

		await harness.setMode("hybrid");

		expect(harness.getMode()).toBe("hybrid");
		const names = harness.getTools().map((tool) => tool.name);
		expect(names).toContain("computer_click");
		expect(names).toContain("browser_snapshot");
	});

	it("setMode keeps the requested activation state of surviving tools", async () => {
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "anthropic:claude-opus-4-5",
			extraTools: [createCustomTool()],
		});
		const withoutCustom = harness
			.getTools()
			.map((tool) => tool.name)
			.filter((name) => name !== "custom");
		await harness.setActiveTools(withoutCustom);

		await harness.setMode("browser");

		const active = harness.getActiveTools().map((tool) => tool.name);
		expect(active).toContain("snapshot");
		expect(active).not.toContain("custom");
	});

	it("setModel after setMode keeps the mode's active tool subset", async () => {
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "anthropic:claude-opus-4-5",
			extraTools: [createCustomTool()],
		});
		const withoutCustom = harness
			.getTools()
			.map((tool) => tool.name)
			.filter((name) => name !== "custom");
		await harness.setActiveTools(withoutCustom);
		await harness.setMode("browser");

		await harness.setModel("anthropic:claude-opus-4-7");

		const active = harness.getActiveTools().map((tool) => tool.name);
		expect(active).toContain("snapshot");
		expect(active).not.toContain("custom");
	});

	it("a failed mode switch keeps the pre-switch runtime and its live translator", async () => {
		const { env, session } = await createHarnessServices();
		let failWrites = false;
		const flakySession = new Proxy(session, {
			get(target, prop, receiver) {
				if (prop === "appendActiveToolsChange" && failWrites) {
					return () => Promise.reject(new Error("session write failed"));
				}
				return Reflect.get(target, prop, receiver);
			},
		});
		const harness = new CuaAgentHarness({
			env,
			session: flakySession,
			browser,
			client,
			model: "anthropic:claude-opus-4-5",
		});
		const runtime = (harness as unknown as { runtime: { translator: unknown } }).runtime;
		const translatorBefore = runtime.translator;

		failWrites = true;
		await expect(harness.setMode("browser")).rejects.toThrow("session write failed");

		// The exposed tools wrap this translator; rollback must not have
		// disposed or replaced it.
		expect(runtime.translator).toBe(translatorBefore);
		expect(harness.getMode()).toBe("computer");

		failWrites = false;
		await harness.setMode("browser");
		expect(harness.getMode()).toBe("browser");
		expect(harness.getTools().map((tool) => tool.name)).toContain("snapshot");
	});

	it("setMode keeps the translator and its CDP-backed state alive", async () => {
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "anthropic:claude-opus-4-5",
		});
		const runtime = (harness as unknown as { runtime: { translator: unknown } }).runtime;
		const translator = runtime.translator;

		await harness.setMode("browser");
		await harness.setMode("hybrid");

		expect(runtime.translator).toBe(translator);
	});

	it("setModel keeps the translator when the provider translator config is unchanged", async () => {
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "anthropic:claude-opus-4-5",
		});
		const runtime = (harness as unknown as { runtime: { translator: unknown } }).runtime;
		const translator = runtime.translator;

		await harness.setModel("anthropic:claude-opus-4-7");
		expect(runtime.translator).toBe(translator);

		// Gemini uses a normalized coordinate system: the translator must be rebuilt.
		await harness.setModel("google:gemini-3-flash-preview");
		expect(runtime.translator).not.toBe(translator);
	});

	it("an overlapping model switch disposes the superseded pending translator", async () => {
		const { env, session } = await createHarnessServices();
		let gate: Promise<void> | undefined;
		const gatedSession = new Proxy(session, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (prop === "appendActiveToolsChange" && gate) {
					const pending = gate;
					gate = undefined;
					return async (...args: unknown[]) => {
						await pending;
						return (value as (...a: unknown[]) => Promise<void>).apply(target, args);
					};
				}
				return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
			},
		});
		const harness = new CuaAgentHarness({
			env,
			session: gatedSession,
			browser,
			client,
			model: "anthropic:claude-opus-4-5",
		});
		const runtime = (harness as unknown as { runtime: { translator: { dispose(): void } } }).runtime;
		const original = vi.spyOn(runtime.translator, "dispose");

		let release!: () => void;
		gate = new Promise((resolve) => {
			release = resolve;
		});
		const first = harness.setModel("google:gemini-3-flash-preview");
		const superseded = vi.spyOn(runtime.translator, "dispose");

		const second = harness.setModel("openai:gpt-5.5");
		release();
		await Promise.all([first, second]);

		// Neither the original nor the superseded pending translator may leak.
		expect(original).toHaveBeenCalled();
		expect(superseded).toHaveBeenCalled();
		expect(harness.getModel().id).toBe("gpt-5.5");
	});

	it("treats a repeated setMode as a no-op", async () => {
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "anthropic:claude-opus-4-5",
		});
		const before = harness.getTools();

		await harness.setMode("computer");

		// Same tool instances: the translator and its CDP state were not replaced.
		expect(harness.getTools()[0]).toBe(before[0]);
	});

	it("appends extraTools in harness construction", async () => {
		const runtime = resolveCuaRuntimeSpec("openai:gpt-5.5");
		const tool = createCustomTool();
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "openai:gpt-5.5",
			extraTools: [tool],
		});

		expect(harness.getTools().map((item) => item.name)).toEqual([
			...runtime.toolExecutors.map((item) => item.definition.name),
			"computer_use_extra",
			"custom",
		]);
	});

	it("preserves active tool selection when setModel refreshes tools", async () => {
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "openai:gpt-5.5",
		});

		await harness.setActiveTools([]);
		await harness.setModel("google:gemini-3-flash-preview");

		expect(harness.getActiveTools()).toEqual([]);
	});

	it("re-applies the requested active tool subset and persists it when setModel refreshes tools", async () => {
		const { env, session } = await createHarnessServices();
		const harness = new CuaAgentHarness({
			env,
			session,
			browser,
			client,
			model: "openai:gpt-5.5",
		});

		await harness.setActiveTools(["click", "screenshot"]);
		await harness.setModel("google:gemini-3-flash-preview");

		expect(harness.getTools()).toHaveLength(
			resolveCuaRuntimeSpec("google:gemini-3-flash-preview").toolExecutors.length + 1,
		);
		expect(harness.getActiveTools().map((tool) => tool.name)).toEqual(["click", "screenshot"]);

		const branch = await session.getBranch();
		const activeToolEntries = branch.filter((entry) => entry.type === "active_tools_change");
		expect(activeToolEntries.at(-1)?.activeToolNames).toEqual(["click", "screenshot"]);
	});
});
