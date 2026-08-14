import { describe, expect, it } from "vitest";
import {
	createAssistantMessageEventStream,
	createCuaModels,
	cua,
	GOOGLE_CUA_INTERACTIONS_API,
	type AssistantMessage,
	type Context,
	type Model,
} from "@onkernel/cua-ai";
import type Kernel from "@onkernel/sdk";
import { Agent, AgentHarness, attach, InMemorySessionRepo, type KernelBrowser, type StreamFn } from "../src/index";

const browser = { session_id: "browser_123", viewport: { width: 1440, height: 900 } } as KernelBrowser;
const client = {} as Kernel;

function assistant(model: Model<string>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function recordingStream(seen: { model: Model<string>; context: Context }[]): StreamFn {
	return (model, context) => {
		seen.push({ model, context: { ...context, tools: context.tools?.slice() } });
		const stream = createAssistantMessageEventStream();
		const message = assistant(model);
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};
}

describe("attach", () => {
	it("compiles a (model, tools) pair into plain pi objects", () => {
		const handle = attach({ browser, client });
		const compiled = handle.compile({
			model: "openai:gpt-5.5",
			tools: [cua.tools.browser.snapshot(), cua.tools.browser.click()],
		});

		expect(compiled.model.api).toBe("openai-responses");
		expect(compiled.tools.map((tool) => tool.name)).toEqual(["browser_snapshot", "browser_click"]);
		expect(compiled.agentTools.every((tool) => typeof tool.execute === "function")).toBe(true);
		expect(typeof compiled.models.streamSimple).toBe("function");
	});

	it("derives the transport from the selected tools", () => {
		const handle = attach({ browser, client });
		const cdp = handle.compile({ model: "google:gemini-3.6-flash", tools: [cua.tools.browser.snapshot()] });
		const native = handle.compile({ model: "google:gemini-3.6-flash", tools: cua.providers.google.toolsets.browser() });

		expect(cdp.model.api).toBe("google-generative-ai");
		expect(native.model.api).toBe(GOOGLE_CUA_INTERACTIONS_API);
	});

	it("materializes a spec once per handle, across compiles", () => {
		const handle = attach({ browser, client });
		const snapshot = cua.tools.browser.snapshot();
		handle.compile({ model: "openai:gpt-5.5", tools: [snapshot] });
		handle.compile({ model: "openai:gpt-5.5", tools: [snapshot, cua.tools.browser.click()] });

		// The executable is cached per pool and per spec. Each compile wraps it to
		// install the execution scope, so the wrapper differs while the tool
		// underneath — and the implementation identity pi keys cache decisions on —
		// stays stable.
		expect(handle.resources.materialize(snapshot)).toBe(handle.resources.materialize(snapshot));
	});

	it("drives a plain pi Agent with no CUA agent class", async () => {
		const seen: { model: Model<string>; context: Context }[] = [];
		const handle = attach({ browser, client });
		const compiled = handle.compile({ model: "openai:gpt-5.5", tools: [cua.tools.browser.snapshot()] });

		const agent = new Agent({
			streamFn: recordingStream(seen),
			initialState: { model: compiled.model, tools: [...compiled.agentTools], systemPrompt: "" },
		});
		await agent.prompt("go");

		expect(seen).toHaveLength(1);
		expect(seen[0]!.model.api).toBe("openai-responses");
		expect(seen[0]!.context.tools?.map((tool) => tool.name)).toEqual(["browser_snapshot"]);
	});

	it("drives a plain pi AgentHarness, with CUA's behaviors installed", async () => {
		const seen: { model: Model<string>; context: Context }[] = [];
		const handle = attach({ browser, client, models: modelsFromStream(recordingStream(seen)) });
		const compiled = handle.compile({ model: "openai:gpt-5.5", tools: [cua.tools.browser.snapshot()] });
		const session = await new InMemorySessionRepo().create();

		const harness = new AgentHarness({
			session,
			model: compiled.model,
			models: compiled.models,
			tools: [...compiled.tools],
			activeToolNames: compiled.tools.map((tool) => tool.name),
		} as never);
		const uninstall = compiled.install(harness);

		await harness.prompt("go");
		expect(seen).toHaveLength(1);
		expect(seen[0]!.context.tools?.map((tool) => tool.name)).toEqual(["browser_snapshot"]);
		expect(typeof uninstall).toBe("function");
		uninstall();
	});

	it("disposes the shared execution pool once, not per compile", async () => {
		const handle = attach({ browser, client });
		handle.compile({ model: "openai:gpt-5.5", tools: [] });
		handle.compile({ model: "anthropic:claude-opus-5", tools: [] });
		await expect(handle.dispose()).resolves.toBeUndefined();
	});
});

function modelsFromStream(streamFn: StreamFn) {
	const models = createCuaModels();
	models.setProvider({
		id: "openai",
		name: "scripted",
		auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "test" } }) } },
		getModels: () => [],
		stream: streamFn,
		streamSimple: streamFn,
	} as never);
	return models;
}
