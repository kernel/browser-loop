import { describe, expect, it, vi } from "vitest";
import {
	createAssistantMessageEventStream,
	createCuaModels,
	getCuaModel,
	cua,
	GOOGLE_CUA_INTERACTIONS_API,
	isCuaToolSpec,
	type AssistantMessage,
	type Context,
	type Model,
} from "@onkernel/cua-ai";
import type Kernel from "@onkernel/sdk";
import {
	Agent,
	AgentHarness,
	CuaAgent,
	CuaAgentHarness,
	InMemorySessionRepo,
	type AgentMessage,
	type AgentTool,
	type KernelBrowser,
	type StreamFn,
} from "../src/index";

const browser = { session_id: "browser_123", viewport: { width: 1440, height: 900 } } as KernelBrowser;
const client = {} as Kernel;

function assistant(model: Model<string>, content: AssistantMessage["content"] = [], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason,
		timestamp: Date.now(),
	};
}

function scriptedStream(
	turns: Array<(model: Model<string>) => AssistantMessage>,
	contexts: Context[] = [],
): StreamFn {
	let call = 0;
	return (model, context) => {
		contexts.push({ ...context, messages: structuredClone(context.messages), tools: context.tools?.slice() });
		const stream = createAssistantMessageEventStream();
		const message = turns[call++]?.(model) ?? assistant(model);
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
		stream.end(message);
		return stream;
	};
}

function callerTool(name: string, execute?: AgentTool["execute"], executionMode?: AgentTool["executionMode"]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: { type: "object", properties: {}, additionalProperties: false } as never,
		...(executionMode ? { executionMode } : {}),
		execute: execute ?? (async () => ({ content: [{ type: "text", text: "ok" }], details: {} })),
	};
}

async function harnessServices() {
	const repo = new InMemorySessionRepo();
	return {
		session: await repo.create(),
	};
}

function modelsFromStream(streamFn: StreamFn, provider = "openai") {
	const models = createCuaModels();
	models.setProvider({
		id: provider,
		name: "scripted",
		auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "test" } }) } },
		getModels: () => [],
		stream: streamFn,
		streamSimple: streamFn,
	} as never);
	return models;
}

describe("CuaAgent explicit tools", () => {
	it("uses composition and accepts tools: [] without a prompt or implicit tool", () => {
		const agent = new CuaAgent({ browser, client, tools: [], initialState: { model: "openai:gpt-5.5" } });
		expect(agent).not.toBeInstanceOf(Agent);
		expect(agent.getTools()).toEqual([]);
		expect("inspectTools" in agent).toBe(false);
		expect(agent.state.tools).toEqual([]);
		expect(agent.state.systemPrompt).toBe("");
		expect("setMode" in agent).toBe(false);
		expect("getMode" in agent).toBe(false);
	});

	it("retains protocol-required OpenAI native computer screenshot results outside the image replay limit", async () => {
		const contexts: Context[] = [];
		const model = getCuaModel("openai:gpt-5.5");
		const nativeComputer = cua.providers.openai.tools.computer();
		const ordinaryTool = callerTool("ordinary");
		const image = { type: "image" as const, data: "c2NyZWVuc2hvdA==", mimeType: "image/png" };
		const messages: AgentMessage[] = [
			assistant(model, [{ type: "toolCall", id: "native-shot", name: "computer", arguments: { action: { type: "screenshot" } } }], "toolUse"),
			{ role: "toolResult", toolCallId: "native-shot", toolName: "computer", content: [image], isError: false, timestamp: 1 },
			assistant(model, [{ type: "toolCall", id: "ordinary-shot", name: "ordinary", arguments: {} }], "toolUse"),
			{ role: "toolResult", toolCallId: "ordinary-shot", toolName: "ordinary", content: [image], isError: false, timestamp: 2 },
		];
		const agent = new CuaAgent({
			browser,
			client,
			tools: [nativeComputer, ordinaryTool],
			streamFn: scriptedStream([(selectedModel) => assistant(selectedModel)], contexts),
			toolResultImageReplayLimit: 0,
			initialState: { model, messages },
		});

		await agent.prompt("continue");

		const results = contexts[0]!.messages.filter((message) => message.role === "toolResult");
		expect(results[0]!.content).toEqual([image]);
		expect(results[1]!.content).toEqual([{ type: "text", text: "[stale tool-result images omitted]" }]);
	});

	it("installs exact native-only, native-plus-CUA, Playwright-only, and browser-act-only catalogs", () => {
		const custom = callerTool("customer_lookup");
		const cases = [
			{
				model: "anthropic:claude-opus-5" as const,
				tools: [cua.providers.anthropic.tools.browser(), custom],
				names: ["browser", "customer_lookup"],
			},
			{
				model: "openai:gpt-5.5" as const,
				tools: [cua.providers.openai.tools.computer(), cua.tools.browser.snapshot(), cua.tools.browser.act()],
				names: ["computer", "browser_snapshot", "browser_act"],
			},
			{ model: "openai:gpt-5.5" as const, tools: [cua.tools.playwright()], names: ["playwright_execute"] },
			{ model: "openai:gpt-5.5" as const, tools: [cua.tools.browser.act()], names: ["browser_act"] },
		];
		for (const entry of cases) {
			const agent = new CuaAgent({ browser, client, tools: entry.tools, initialState: { model: entry.model } });
			expect(agent.state.tools.map((tool) => tool.name)).toEqual(entry.names);
			expect(agent.getTools()).toEqual(entry.tools);
		}
	});

	it("returns a copy of the exact requested specs", () => {
		const requested = [cua.tools.browser.snapshot(), callerTool("customer_lookup")];
		const agent = new CuaAgent({ browser, client, tools: requested, initialState: { model: "anthropic:claude-opus-5" } });
		expect(agent.getTools()).toEqual(requested);
		expect(agent.getTools()).not.toBe(requested);
		expect(agent.state.tools.map((tool) => tool.name)).toEqual(["browser_snapshot", "customer_lookup"]);
	});

	it("keeps the caller system prompt stable across setTools", () => {
		const agent = new CuaAgent({
			browser,
			client,
			tools: [],
			initialState: { model: "openai:gpt-5.5", systemPrompt: "caller-owned" },
		});
		agent.setTools([cua.tools.playwright()]);
		expect(agent.state.systemPrompt).toBe("caller-owned");
		expect(agent.getTools().map((tool) => tool.name)).toEqual(["playwright_execute"]);
	});

	it("marks a sequential in-tool prefix addition for deferred loading", async () => {
		const contexts: Context[] = [];
		let agent!: CuaAgent;
		const added = callerTool("added");
		const loader = callerTool("loader", async () => {
			agent.setTools([...agent.getTools(), added]);
			return { content: [{ type: "text", text: "loaded" }], details: {} };
		}, "sequential");
		agent = new CuaAgent({
			browser,
			client,
			tools: [loader],
			streamFn: scriptedStream([
				(model) => assistant(model, [{ type: "toolCall", id: "load-1", name: "loader", arguments: {} }], "toolUse"),
				(model) => assistant(model, [{ type: "text", text: "done" }]),
			], contexts),
			initialState: { model: "openai:gpt-5.5" },
		});

		await agent.prompt("load it");

		expect(agent.getTools()).toEqual([loader, added]);
		expect(contexts[1]?.tools?.map((tool) => tool.name)).toEqual(["loader", "added"]);
		expect(contexts[1]?.messages.find((message) => message.role === "toolResult")).toMatchObject({ addedToolNames: ["added"] });
	});

	it("computes deferred additions from the final in-tool catalog", async () => {
		const contexts: Context[] = [];
		let agent!: CuaAgent;
		const added = callerTool("temporary");
		const loader = callerTool("loader", async () => {
			agent.setTools([...agent.getTools(), added]);
			agent.setTools([loader]);
			return { content: [{ type: "text", text: "unchanged" }], details: {} };
		}, "sequential");
		agent = new CuaAgent({
			browser,
			client,
			tools: [loader],
			streamFn: scriptedStream([
				(model) => assistant(model, [{ type: "toolCall", id: "load", name: "loader", arguments: {} }], "toolUse"),
				(model) => assistant(model),
			], contexts),
			initialState: { model: "openai:gpt-5.5" },
		});
		await agent.prompt("load");
		expect(contexts[1]?.messages.find((message) => message.role === "toolResult")).not.toHaveProperty("addedToolNames");
	});

	it("uses eager fallback for removals and replacements", async () => {
		const run = async (replacement: "remove" | "replace") => {
			const contexts: Context[] = [];
			let agent!: CuaAgent;
			const loader = callerTool("loader", async () => {
				agent.setTools(replacement === "remove" ? [] : [callerTool("loader")]);
				return { content: [{ type: "text", text: replacement }], details: {} };
			}, "sequential");
			agent = new CuaAgent({
				browser,
				client,
				tools: [loader],
				streamFn: scriptedStream([
					(model) => assistant(model, [{ type: "toolCall", id: "change", name: "loader", arguments: {} }], "toolUse"),
					(model) => assistant(model),
				], contexts),
				initialState: { model: "openai:gpt-5.5" },
			});
			await agent.prompt("change");
			return contexts[1]?.messages.find((message) => message.role === "toolResult");
		};
		expect(await run("remove")).not.toHaveProperty("addedToolNames");
		expect(await run("replace")).not.toHaveProperty("addedToolNames");
	});

	it("keeps deferred additions when a replacement wrapper reuses the same execute function", async () => {
		const contexts: Context[] = [];
		let agent!: CuaAgent;
		const sharedExecute: AgentTool["execute"] = async () => ({ content: [{ type: "text", text: "ok" }], details: {} });
		const original = callerTool("original", sharedExecute);
		const added = callerTool("added");
		const loader = callerTool("loader", async () => {
			const rewrapped = { ...original };
			expect(rewrapped).not.toBe(original);
			agent.setTools([rewrapped, loader, added]);
			return { content: [{ type: "text", text: "loaded" }], details: {} };
		}, "sequential");
		agent = new CuaAgent({
			browser,
			client,
			tools: [original, loader],
			streamFn: scriptedStream([
				(model) => assistant(model, [{ type: "toolCall", id: "load", name: "loader", arguments: {} }], "toolUse"),
				(model) => assistant(model),
			], contexts),
			initialState: { model: "openai:gpt-5.5" },
		});
		await agent.prompt("load");
		expect(contexts[1]?.messages.find((message) => message.role === "toolResult")).toMatchObject({ addedToolNames: ["added"] });
	});

	it("installs and invokes a replacement executor with an identical name and schema", async () => {
		const contexts: Context[] = [];
		const calls: string[] = [];
		let agent!: CuaAgent;
		const workerV1 = callerTool("worker", async () => {
			calls.push("v1");
			return { content: [{ type: "text", text: "v1" }], details: {} };
		});
		const loader = callerTool("loader", async () => {
			const workerV2 = callerTool("worker", async () => {
				calls.push("v2");
				return { content: [{ type: "text", text: "v2" }], details: {} };
			});
			agent.setTools([loader, workerV2]);
			return { content: [{ type: "text", text: "replaced" }], details: {} };
		}, "sequential");
		agent = new CuaAgent({
			browser,
			client,
			tools: [loader, workerV1],
			streamFn: scriptedStream([
				(model) => assistant(model, [{ type: "toolCall", id: "load", name: "loader", arguments: {} }], "toolUse"),
				(model) => assistant(model, [{ type: "toolCall", id: "work", name: "worker", arguments: {} }], "toolUse"),
				(model) => assistant(model),
			], contexts),
			initialState: { model: "openai:gpt-5.5" },
		});
		await agent.prompt("replace then work");
		expect(calls).toEqual(["v2"]);
		expect(contexts[1]?.messages.find((message) => message.role === "toolResult")).not.toHaveProperty("addedToolNames");
	});

	it("treats a freshly created spec object as a replacement but the same object as stable", async () => {
		const run = async (reuseSpec: boolean) => {
			const contexts: Context[] = [];
			let agent!: CuaAgent;
			const spec = cua.tools.browser.snapshot();
			const added = callerTool("added");
			const loader = callerTool("loader", async () => {
				agent.setTools([reuseSpec ? spec : cua.tools.browser.snapshot(), loader, added]);
				return { content: [{ type: "text", text: "loaded" }], details: {} };
			}, "sequential");
			agent = new CuaAgent({
				browser,
				client,
				tools: [spec, loader],
				streamFn: scriptedStream([
					(model) => assistant(model, [{ type: "toolCall", id: "load", name: "loader", arguments: {} }], "toolUse"),
					(model) => assistant(model),
				], contexts),
				initialState: { model: "openai:gpt-5.5" },
			});
			await agent.prompt("load");
			return contexts[1]?.messages.find((message) => message.role === "toolResult");
		};
		expect(await run(true)).toMatchObject({ addedToolNames: ["added"] });
		expect(await run(false)).not.toHaveProperty("addedToolNames");
	});

	it("leaves model, requested tools, and installed executables untouched when setTools fails", () => {
		const spec = cua.tools.browser.snapshot();
		const keep = callerTool("keep");
		const agent = new CuaAgent({ browser, client, tools: [spec, keep], initialState: { model: "openai:gpt-5.5" } });
		const installed = agent.state.tools;
		expect(() => agent.setTools([cua.providers.anthropic.tools.browser()])).toThrow(/requires a anthropic model/);
		expect(() => agent.setTools([callerTool("keep"), callerTool("keep")])).toThrow(/caller\.keep/);
		expect(agent.getModel().id).toBe("gpt-5.5");
		expect(agent.getTools()).toEqual([spec, keep]);
		expect(agent.state.tools).toEqual(installed);
		agent.state.tools.forEach((tool, index) => expect(tool).toBe(installed[index]));
	});

	it("leaves model, requested tools, and installed executables untouched when setModel fails", () => {
		const spec = cua.providers.anthropic.tools.browser();
		const agent = new CuaAgent({ browser, client, tools: [spec], initialState: { model: "anthropic:claude-opus-5" } });
		const installed = agent.state.tools;
		expect(() => agent.setModel("openai:gpt-5.5")).toThrow(/requires a anthropic model/);
		expect(agent.getModel().provider).toBe("anthropic");
		expect(agent.getTools()).toEqual([spec]);
		agent.state.tools.forEach((tool, index) => expect(tool).toBe(installed[index]));
	});

	it("rejects in-tool mutation from a non-sequential caller tool", async () => {
		let agent!: CuaAgent;
		const loader = callerTool("loader", async () => {
			agent.setTools([cua.tools.playwright()]);
			return { content: [{ type: "text", text: "unexpected" }], details: {} };
		});
		agent = new CuaAgent({
			browser,
			client,
			tools: [loader],
			streamFn: scriptedStream([
				(model) => assistant(model, [{ type: "toolCall", id: "load", name: "loader", arguments: {} }], "toolUse"),
				(model) => assistant(model),
			]),
			initialState: { model: "openai:gpt-5.5" },
		});
		await agent.prompt("load");
		const result = agent.state.messages.find((message) => message.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(result?.content).toEqual([expect.objectContaining({ text: expect.stringContaining('executionMode: "sequential"') })]);
	});

	it("rejects in-tool model switching from a non-sequential caller tool", async () => {
		let agent!: CuaAgent;
		const switcher = callerTool("switcher", async () => {
			agent.setModel("anthropic:claude-opus-5");
			return { content: [{ type: "text", text: "unexpected" }], details: {} };
		});
		agent = new CuaAgent({
			browser,
			client,
			tools: [switcher],
			streamFn: scriptedStream([
				(model) => assistant(model, [{ type: "toolCall", id: "switch", name: "switcher", arguments: {} }], "toolUse"),
				(model) => assistant(model),
			]),
			initialState: { model: "openai:gpt-5.5" },
		});
		await agent.prompt("switch");
		const result = agent.state.messages.find((message) => message.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(result?.content).toEqual([expect.objectContaining({ text: expect.stringContaining('before calling setModel()') })]);
		expect(agent.getModel().provider).toBe("openai");
	});

	it("allows in-tool model switching from a sequential caller tool", async () => {
		const contexts: Context[] = [];
		let agent!: CuaAgent;
		const switcher = callerTool("switcher", async () => {
			agent.setModel("anthropic:claude-opus-5");
			return { content: [{ type: "text", text: "switched" }], details: {} };
		}, "sequential");
		agent = new CuaAgent({
			browser,
			client,
			tools: [switcher],
			streamFn: scriptedStream([
				(model) => assistant(model, [{ type: "toolCall", id: "switch", name: "switcher", arguments: {} }], "toolUse"),
				(model) => assistant(model),
			], contexts),
			initialState: { model: "openai:gpt-5.5" },
		});
		await agent.prompt("switch");
		const result = agent.state.messages.find((message) => message.role === "toolResult");
		expect(result).not.toMatchObject({ isError: true });
		expect(agent.getModel().provider).toBe("anthropic");
		expect(agent.getTools()).toEqual([switcher]);
		expect(contexts[1]?.messages.find((message) => message.role === "toolResult")).not.toHaveProperty("addedToolNames");
	});

	it("streams with the transport setTools derives, not just the catalog it compiles", async () => {
		const streamedApis: string[] = [];
		const agent = new CuaAgent({
			browser,
			client,
			tools: [cua.tools.browser.snapshot()],
			streamFn: (model, context, options) => {
				streamedApis.push(model.api);
				return scriptedStream([(selectedModel) => assistant(selectedModel)])(model, context, options);
			},
			initialState: { model: "google:gemini-3.6-flash" },
		});
		expect(agent.getModel().api).toBe("google-generative-ai");

		agent.setTools(cua.providers.google.toolsets.browser());
		expect(agent.getModel().api).toBe(GOOGLE_CUA_INTERACTIONS_API);

		await agent.prompt("go");
		expect(streamedApis).toEqual([GOOGLE_CUA_INTERACTIONS_API]);
	});
});

describe("CuaAgentHarness explicit tools", () => {
	it("resolves refs from supplied models for construction and setModel", async () => {
		const models = createCuaModels();
		const openai = models.getProvider("openai")!;
		const first = { ...getCuaModel("openai:gpt-5.5"), baseUrl: "https://first.example" };
		const second = { ...getCuaModel("openai:gpt-5.6-sol"), baseUrl: "https://second.example" };
		models.setProvider({ ...openai, getModels: () => [first, second] });
		const services = await harnessServices();
		const harness = new CuaAgentHarness({ ...services, browser, client, models, model: "openai:gpt-5.5", tools: [] });
		expect(harness.getModel()).toBe(first);
		await harness.setModel("openai:gpt-5.6-sol");
		expect(harness.getModel()).toBe(second);

		// A ref the supplied collection does not carry falls back to the registry
		// rather than being refused: the provider decides what exists.
		const fallback = new CuaAgentHarness({ ...services, browser, client, models, model: "openai:gpt-5.4", tools: [] });
		expect(fallback.getModel().id).toBe("gpt-5.4");
	});

	it("uses composition, hides active-tool APIs, and supports an empty catalog", async () => {
		const harness = new CuaAgentHarness({ ...(await harnessServices()), browser, client, model: "openai:gpt-5.5", tools: [] });
		expect(harness).not.toBeInstanceOf(AgentHarness);
		expect(harness.getTools()).toEqual([]);
		expect("inspectTools" in harness).toBe(false);
		expect("getActiveTools" in harness).toBe(false);
		expect("setActiveTools" in harness).toBe(false);
		expect("setMode" in harness).toBe(false);
	});

	it("preserves requested tools on compatible model changes and rejects incompatible native tools", async () => {
		const custom = callerTool("custom");
		const harness = new CuaAgentHarness({ ...(await harnessServices()), browser, client, model: "openai:gpt-5.5", tools: [custom] });
		await harness.setModel("anthropic:claude-opus-5");
		expect(harness.getTools()).toEqual([custom]);
		expect(harness.getModel().provider).toBe("anthropic");

		await harness.setTools([cua.providers.anthropic.tools.browser()]);
		await expect(harness.setModel("openai:gpt-5.5")).rejects.toThrow(/requires a anthropic model/);
		expect(harness.getModel().provider).toBe("anthropic");
		const installed = harness.getTools()[0];
		expect(installed && isCuaToolSpec(installed) ? installed.identity : undefined).toBe("provider.anthropic.native.browser.20260701");
	});

	it("keeps the harness catalog and executors unchanged when setTools fails", async () => {
		const keep = callerTool("keep");
		const harness = new CuaAgentHarness({ ...(await harnessServices()), browser, client, model: "openai:gpt-5.5", tools: [keep] });
		await expect(harness.setTools([cua.providers.anthropic.tools.browser()])).rejects.toThrow(/requires a anthropic model/);
		expect(harness.getModel().id).toBe("gpt-5.5");
		expect(harness.getTools()).toEqual([keep]);
	});

	it("persists exact tool-name changes and anchors additive in-tool loading", async () => {
		const contexts: Context[] = [];
		const services = await harnessServices();
		let harness!: CuaAgentHarness;
		const added = callerTool("added");
		const loader = callerTool("loader", async () => {
			await harness.setTools([...harness.getTools(), added]);
			return { content: [{ type: "text", text: "loaded" }], details: {} };
		}, "sequential");
		harness = new CuaAgentHarness({
			...services,
			browser,
			client,
			model: "openai:gpt-5.5",
			models: modelsFromStream(scriptedStream([
				(model) => assistant(model, [{ type: "toolCall", id: "load", name: "loader", arguments: {} }], "toolUse"),
				(model) => assistant(model),
			], contexts)),
			tools: [loader],
			systemPrompt: "stable",
		});

		await harness.prompt("load");

		expect(contexts[0]?.systemPrompt).toBe("stable");
		expect(contexts[1]?.systemPrompt).toBe("stable");
		expect(contexts[1]?.messages.find((message) => message.role === "toolResult")).toMatchObject({ addedToolNames: ["added"] });
		const changes = (await services.session.getBranch()).filter((entry) => entry.type === "active_tools_change");
		expect(changes.at(-1)).toMatchObject({ activeToolNames: ["loader", "added"] });
	});

	it("does not emit an artificial tool result for idle additions", async () => {
		const contexts: Context[] = [];
		const harness = new CuaAgentHarness({
			...(await harnessServices()),
			browser,
			client,
			model: "openai:gpt-5.5",
			models: modelsFromStream(scriptedStream([(model) => assistant(model)], contexts)),
			tools: [],
		});
		await harness.setTools([callerTool("added")]);
		await harness.prompt("next");
		expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["added"]);
		expect(contexts[0]?.messages.some((message) => message.role === "toolResult")).toBe(false);
	});

	it("clears failed-turn state before the next prompt", async () => {
		let successfulCalls = 0;
		const failing = callerTool("failing", async () => {
			throw new Error("expected failure");
		});
		const succeeding = callerTool("succeeding", async () => {
			successfulCalls += 1;
			return { content: [{ type: "text", text: "ok" }], details: {} };
		});
		const harness = new CuaAgentHarness({
			...(await harnessServices()),
			browser,
			client,
			model: "anthropic:claude-opus-5",
			models: modelsFromStream(scriptedStream([
				(model) => assistant(model, [{ type: "toolCall", id: "fail", name: "failing", arguments: {} }], "toolUse"),
				(model) => assistant(model, [{ type: "toolCall", id: "succeed", name: "succeeding", arguments: {} }], "toolUse"),
				(model) => assistant(model, [{ type: "text", text: "done" }]),
			]), "anthropic"),
			tools: [cua.providers.anthropic.tools.browser(), failing, succeeding],
		});
		harness.on("tool_result", (event) => event.toolName === "failing" ? { terminate: true } : undefined);

		await harness.prompt("fail once");
		await harness.prompt("try again");

		expect(successfulCalls).toBe(1);
	});

	it("streams with the transport setTools derives, not just the catalog it compiles", async () => {
		const streamedApis: string[] = [];
		const script = scriptedStream([(selectedModel) => assistant(selectedModel)]);
		const harness = new CuaAgentHarness({
			...(await harnessServices()),
			browser,
			client,
			model: "google:gemini-3.6-flash",
			models: modelsFromStream((model, context, options) => {
				streamedApis.push(model.api);
				return script(model, context, options);
			}, "google"),
			tools: [cua.tools.browser.snapshot()],
		});
		expect(harness.getModel().api).toBe("google-generative-ai");

		await harness.setTools(cua.providers.google.toolsets.browser());
		expect(harness.getModel().api).toBe(GOOGLE_CUA_INTERACTIONS_API);

		await harness.prompt("go");
		expect(streamedApis).toEqual([GOOGLE_CUA_INTERACTIONS_API]);
	});

	it("does not record a model change for a setTools() call that leaves the derived transport unchanged", async () => {
		const services = await harnessServices();
		const harness = new CuaAgentHarness({
			...services,
			browser,
			client,
			model: "openai:gpt-5.5",
			tools: [callerTool("first")],
		});
		await harness.setTools([callerTool("second")]);
		const modelChanges = (await services.session.getBranch()).filter((entry) => entry.type === "model_change");
		expect(modelChanges).toEqual([]);
	});

	it("records one model change for a switch that changes both the model and its derived transport", async () => {
		const services = await harnessServices();
		const harness = new CuaAgentHarness({
			...services,
			browser,
			client,
			model: "google:gemini-3.6-flash",
			tools: cua.providers.google.toolsets.browser(),
		});
		expect(harness.getModel().api).toBe(GOOGLE_CUA_INTERACTIONS_API);

		await harness.setModelAndTools("openai:gpt-5.5", [cua.tools.browser.snapshot()]);
		expect(harness.getModel().api).toBe("openai-responses");

		const modelChanges = (await services.session.getBranch()).filter((entry) => entry.type === "model_change");
		expect(modelChanges).toHaveLength(1);
	});
});
