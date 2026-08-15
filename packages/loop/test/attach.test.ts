import { describe, expect, it } from "vitest";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import {
	Agent,
	AgentHarness,
	attach,
	createLoopModels,
	GOOGLE_INTERACTIONS_API,
	InMemorySessionRepo,
	type LoopSimpleStreamOptions,
	OPENAI_COMPUTER_USE_API,
	type StreamFn,
} from "../src/pi/index";
import { type KernelBrowser, loop } from "../src/index";
import type Kernel from "@onkernel/sdk";
import { installLoopBehaviors } from "../src/pi/attach";

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

function recordingStream(seen: { model: Model<string>; context: Context; options?: LoopSimpleStreamOptions }[]): StreamFn {
	return (model, context, options) => {
		seen.push({ model, context: { ...context, tools: context.tools?.slice() }, options: options as LoopSimpleStreamOptions });
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
			tools: [loop.tools.browser.snapshot(), loop.tools.browser.click()],
		});

		expect(compiled.model.api).toBe("openai-responses");
		expect(compiled.tools.map((tool) => tool.name)).toEqual(["browser_snapshot", "browser_click"]);
		expect(compiled.agentTools.every((tool) => typeof tool.execute === "function")).toBe(true);
		expect(typeof compiled.models.streamSimple).toBe("function");
	});

	it("derives the transport from the selected tools", () => {
		const handle = attach({ browser, client });
		const cdp = handle.compile({ model: "google:gemini-3.6-flash", tools: [loop.tools.browser.snapshot()] });
		const native = handle.compile({ model: "google:gemini-3.6-flash", tools: loop.providers.google.toolsets.browser() });

		expect(cdp.model.api).toBe("google-generative-ai");
		expect(native.model.api).toBe(GOOGLE_INTERACTIONS_API);
	});

	it("materializes a spec once per handle, across compiles", () => {
		const handle = attach({ browser, client });
		const snapshot = loop.tools.browser.snapshot();
		handle.compile({ model: "openai:gpt-5.5", tools: [snapshot] });
		handle.compile({ model: "openai:gpt-5.5", tools: [snapshot, loop.tools.browser.click()] });

		// The executable is cached per pool and per spec. Each compile wraps it to
		// install the execution scope, so the wrapper differs while the tool
		// underneath — and the implementation identity pi keys cache decisions on —
		// stays stable.
		expect(handle.resources.materialize(snapshot)).toBe(handle.resources.materialize(snapshot));
	});

	it("drives a plain pi Agent with no Loop agent class", async () => {
		const seen: { model: Model<string>; context: Context; options?: LoopSimpleStreamOptions }[] = [];
		const handle = attach({ browser, client });
		const compiled = handle.compile({ model: "openai:gpt-5.5", tools: [loop.tools.browser.snapshot()] });

		const agent = new Agent({
			streamFn: recordingStream(seen),
			initialState: { model: compiled.model, tools: [...compiled.agentTools], systemPrompt: "" },
		});
		await agent.prompt("go");

		expect(seen).toHaveLength(1);
		expect(seen[0]!.model.api).toBe("openai-responses");
		expect(seen[0]!.context.tools?.map((tool) => tool.name)).toEqual(["browser_snapshot"]);
	});

	it("drives a plain pi AgentHarness, with Loop's behaviors installed", async () => {
		const seen: { model: Model<string>; context: Context; options?: LoopSimpleStreamOptions }[] = [];
		const handle = attach({ browser, client, models: modelsFromStream(recordingStream(seen)) });
		const compiled = handle.compile({ model: "openai:gpt-5.5", tools: [loop.tools.browser.snapshot()] });
		const session = await new InMemorySessionRepo().create();

		const harness = new AgentHarness({
			session,
			model: compiled.model,
			models: compiled.models,
			tools: [...compiled.tools],
			activeToolNames: compiled.tools.map((tool) => tool.name),
		});
		const release = compiled.activate(harness);

		await harness.prompt("go");
		expect(seen).toHaveLength(1);
		expect(seen[0]!.context.tools?.map((tool) => tool.name)).toEqual(["browser_snapshot"]);
		expect(typeof release).toBe("function");
		release();
	});

	it("streams the live catalog's tool plan after a swap, not the one the harness was built with", async () => {
		const seen: { model: Model<string>; context: Context; options?: LoopSimpleStreamOptions }[] = [];
		const handle = attach({ browser, client, models: modelsFromStream(recordingStream(seen)) });
		const first = handle.compile({ model: "openai:gpt-5.5", tools: [loop.tools.browser.snapshot()] });
		const session = await new InMemorySessionRepo().create();

		const harness = new AgentHarness({
			session,
			model: first.model,
			models: first.models,
			tools: [...first.tools],
			activeToolNames: first.tools.map((tool) => tool.name),
		});
		first.activate(harness);

		const second = handle.compile({ model: "openai:gpt-5.5", tools: [loop.providers.openai.tools.computer()] });
		await second.apply(harness);
		await harness.prompt("go");

		// pi fixes `models` at construction while the headers, payload transforms
		// and tool plan it carries are per-catalog, so a per-compile collection
		// would keep sending the first catalog's plan for the rest of the session.
		expect(seen).toHaveLength(1);
		expect(seen[0]!.options?.loopIncomingToolPlan?.openaiComputerName).toBe("computer");
		expect(seen[0]!.model.api).toBe(OPENAI_COMPUTER_USE_API);
	});

	it("runs the handle's onPayload even when the request carries its own", async () => {
		const seen: { model: Model<string>; context: Context; options?: LoopSimpleStreamOptions }[] = [];
		const applied: string[] = [];
		const handle = attach({
			browser,
			client,
			models: modelsFromStream(recordingStream(seen)),
			onPayload: (payload) => {
				applied.push("handle");
				return payload as Record<string, unknown>;
			},
		});
		const compiled = handle.compile({ model: "openai:gpt-5.5", tools: [loop.tools.browser.snapshot()] });
		const session = await new InMemorySessionRepo().create();
		const harness = new AgentHarness({
			session,
			model: compiled.model,
			models: compiled.models,
			tools: [...compiled.tools],
			activeToolNames: compiled.tools.map((tool) => tool.name),
		});
		compiled.activate(harness);
		await harness.prompt("go");

		// pi's harness always sets its own onPayload, so the handle's hook only
		// survives if both run.
		await seen[0]!.options?.onPayload?.({}, compiled.model);
		expect(applied).toEqual(["handle"]);
	});

	it("spends an empty-response retry only when the follow-up is queued", async () => {
		const attempted: string[] = [];
		let reject = true;
		let emit!: (event: unknown, signal?: AbortSignal) => Promise<void>;
		const stub = {
			on: () => () => {},
			subscribe: (handler: (event: unknown, signal?: AbortSignal) => Promise<void>) => {
				emit = handler;
				return () => {};
			},
			followUp: async (message: string) => {
				attempted.push(message);
				if (reject) throw new Error("queue closed");
			},
		};
		const manager = { catalog: { entries: [] }, specFor: () => undefined };
		installLoopBehaviors(stub as never, manager as never, { followUp: "continue", maxAttempts: 1 });

		const emptyTurn = { type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [] } };
		await expect(emit(emptyTurn)).rejects.toThrow("queue closed");
		reject = false;
		await emit(emptyTurn);
		// The rejected queue left the turn untouched, so it must not have spent the
		// single attempt; the second follow-up does, and a third is refused.
		await emit(emptyTurn);

		expect(attempted).toEqual(["continue", "continue"]);
	});

	it("disposes the shared execution pool once, not per compile", async () => {
		const handle = attach({ browser, client });
		handle.compile({ model: "openai:gpt-5.5", tools: [] });
		handle.compile({ model: "anthropic:claude-opus-5", tools: [] });
		await expect(handle.dispose()).resolves.toBeUndefined();
	});
});

function modelsFromStream(streamFn: StreamFn) {
	const models = createLoopModels();
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
