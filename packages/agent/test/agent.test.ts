import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { resolveCuaRuntimeSpec } from "@onkernel/cua-ai";
import type Kernel from "@onkernel/sdk";
import {
	Agent,
	AgentHarness,
	CuaAgent,
	CuaAgentHarness,
	InMemorySessionRepo,
	NodeExecutionEnv,
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

		expect(agent.state.tools.map((item) => item.name)).toEqual([...runtime.toolExecutors.map((item) => item.definition.name), "custom"]);
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

		expect(agent.state.tools.map((item) => item.name)).toEqual([...runtime.toolExecutors.map((item) => item.definition.name), "custom"]);
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
		expect(agent.state.tools.map((tool) => tool.name)).toEqual(runtime.toolExecutors.map((tool) => tool.definition.name));
	});

	it("synthesizes navigation tools when requested", () => {
		const runtime = resolveCuaRuntimeSpec("openai:gpt-5.5");
		const agent = new CuaAgent({
			browser,
			client,
			computerUseExtra: true,
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
			"playwright_execute",
		]);
	});

	it("toggles playwright_execute on and off through setPlaywright", () => {
		const runtime = resolveCuaRuntimeSpec("openai:gpt-5.5");
		const baseNames = runtime.toolExecutors.map((tool) => tool.definition.name);
		const agent = new CuaAgent({
			browser,
			client,
			initialState: {
				model: "openai:gpt-5.5",
			},
		});

		expect(agent.state.tools.map((tool) => tool.name)).toEqual(baseNames);

		agent.setPlaywright(true);
		expect(agent.state.tools.map((tool) => tool.name)).toEqual([...baseNames, "playwright_execute"]);

		agent.setPlaywright(false);
		expect(agent.state.tools.map((tool) => tool.name)).toEqual(baseNames);
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
		expect(agent.state.tools).toHaveLength(runtime.toolExecutors.length);
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
		expect(agent.state.tools.map((item) => item.name)).toEqual([...runtime.toolExecutors.map((item) => item.definition.name), "custom"]);
		expect(agent.state.systemPrompt).toBe("custom prompt");
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
			computerUseExtra: true,
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
		expect(update?.context?.tools).toHaveLength(runtime.toolExecutors.length);

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
			initialState: { model: "openai:gpt-5.5" },
		});

		await agent.prompt("inspect the page");

		expect(screenshots).toBe(1);
		expect(providerCalls).toBe(2);
		const fedBack = contexts[1]!.messages.find((message) => message.role === "toolResult");
		expect(fedBack, "second provider request should carry the tool result").toBeDefined();
		expect(fedBack!.content.some((block) => block.type === "image" && block.mimeType === "image/png")).toBe(true);
	});
});

describe("CuaAgentHarness", () => {
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

	it("toggles playwright_execute on and off through harness.setPlaywright", async () => {
		const runtime = resolveCuaRuntimeSpec("openai:gpt-5.5");
		const baseNames = runtime.toolExecutors.map((tool) => tool.definition.name);
		const harness = new CuaAgentHarness({
			...(await createHarnessServices()),
			browser,
			client,
			model: "openai:gpt-5.5",
		});

		expect(harness.getTools().map((tool) => tool.name)).toEqual(baseNames);

		await harness.setPlaywright(true);
		expect(harness.getTools().map((tool) => tool.name)).toEqual([...baseNames, "playwright_execute"]);

		await harness.setPlaywright(false);
		expect(harness.getTools().map((tool) => tool.name)).toEqual(baseNames);
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
		expect(harness.getTools()).toHaveLength(runtime.toolExecutors.length);
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
			resolveCuaRuntimeSpec("google:gemini-3-flash-preview").toolExecutors.length,
		);
		expect(harness.getActiveTools().map((tool) => tool.name)).toEqual(["click", "screenshot"]);

		const branch = await session.getBranch();
		const activeToolEntries = branch.filter((entry) => entry.type === "active_tools_change");
		expect(activeToolEntries.at(-1)?.activeToolNames).toEqual(["click", "screenshot"]);
	});
});
