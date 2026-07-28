import { describe, expect, it, vi } from "vitest";
import {
	createAssistantMessageEventStream,
	createCuaModels,
	cua,
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
	NodeExecutionEnv,
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
		stream.push({ type: "done", reason: message.stopReason, message });
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
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
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
		expect(agent.inspectTools()).toEqual([]);
		expect(agent.state.tools).toEqual([]);
		expect(agent.state.systemPrompt).toBe("");
		expect("setMode" in agent).toBe(false);
		expect("getMode" in agent).toBe(false);
	});

	it("installs exact native-only, recommended-plus-CUA, Playwright-only, and browser-act-only catalogs", () => {
		const custom = callerTool("customer_lookup");
		const cases = [
			{
				model: "anthropic:claude-opus-5" as const,
				tools: [cua.providers.anthropic.tools.browser(), custom],
				names: ["browser", "customer_lookup"],
			},
			{
				model: "anthropic:claude-opus-5" as const,
				tools: [...cua.providers.anthropic.toolsets.computer(), cua.tools.browser.snapshot(), cua.tools.browser.act()],
				names: ["computer", "computer_batch", "browser_snapshot", "browser_act"],
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

	it("returns the requested specs while exposing resolved inspection", () => {
		const requested = [cua.tools.browser.snapshot(), callerTool("customer_lookup")];
		const agent = new CuaAgent({ browser, client, tools: requested, initialState: { model: "anthropic:claude-opus-5" } });
		expect(agent.getTools()).toEqual(requested);
		expect(agent.getTools()).not.toBe(requested);
		expect(agent.inspectTools().map((tool) => [tool.identity, tool.name, tool.origin])).toEqual([
			["cua.browser.snapshot.v1", "browser_snapshot", "cua"],
			["caller.customer_lookup", "customer_lookup", "caller"],
		]);
		expect(agent.state.tools.map((tool) => tool.name)).toEqual(["browser_snapshot", "customer_lookup"]);
		const requestGrounded = new CuaAgent({
			browser,
			client,
			tools: cua.providers.yutori.toolsets.n15Core().slice(0, 1),
			initialState: { model: "yutori:n1.5-latest" },
		});
		expect(requestGrounded.inspectTools()[0]?.requestGrounding).toBe("os-screenshot");
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
});

describe("CuaAgentHarness explicit tools", () => {
	it("uses composition, hides active-tool APIs, and supports an empty catalog", async () => {
		const harness = new CuaAgentHarness({ ...(await harnessServices()), browser, client, model: "openai:gpt-5.5", tools: [] });
		expect(harness).not.toBeInstanceOf(AgentHarness);
		expect(harness.getTools()).toEqual([]);
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
		expect(harness.getTools()[0]?.identity).toBe("provider.anthropic.native.browser.20260701");
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
});
