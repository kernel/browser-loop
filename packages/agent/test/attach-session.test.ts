import { describe, expect, it } from "vitest";
import {
	createAssistantMessageEventStream,
	createCuaModels,
	cua,
	getCuaModel,
	GOOGLE_CUA_INTERACTIONS_API,
	type AssistantMessage,
	type Context,
	type Model,
	type Models,
} from "@onkernel/cua-ai";
import type Kernel from "@onkernel/sdk";
import {
	Agent,
	AgentHarness,
	attach,
	InMemorySessionRepo,
	type AgentMessage,
	type AgentTool,
	type CuaHarnessTool,
	type CuaModelInput,
	type KernelBrowser,
	type Session,
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
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
	};
}

function scriptedStream(turns: Array<(model: Model<string>) => AssistantMessage>, contexts: Context[] = []): StreamFn {
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

function callerTool(name: string, execute?: AgentTool["execute"]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: { type: "object", properties: {}, additionalProperties: false } as never,
		execute: execute ?? (async () => ({ content: [{ type: "text", text: "ok" }], details: {} })),
	};
}

function modelsFromStream(streamFn: StreamFn, provider = "openai"): Models {
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

/**
 * What a consumer does with a handle: compile a pair, hand it to a stock pi
 * harness, and recompile-then-apply to change it. The CLI's `CuaCliCatalog` is
 * this same shape.
 */
async function openSession(options: {
	model: CuaModelInput;
	tools: readonly CuaHarnessTool<undefined>[];
	models?: Models;
}): Promise<{
	harness: AgentHarness;
	session: Session;
	select: (model: CuaModelInput, tools: readonly CuaHarnessTool<undefined>[]) => Promise<void>;
}> {
	const session = await new InMemorySessionRepo().create();
	const handle = attach({ browser, client, models: options.models });
	const compiled = handle.compile({ model: options.model, tools: options.tools });
	const harness = new AgentHarness({
		session,
		model: compiled.model,
		models: compiled.models,
		tools: [...compiled.tools],
		activeToolNames: compiled.tools.map((tool) => tool.name),
	});
	compiled.activate(harness);
	return {
		harness,
		session,
		select: async (model, tools) => {
			const next = handle.compile({ model, tools });
			await next.apply(harness);
		},
	};
}

describe("compiling a pair", () => {
	it("compiles exact native-only, native-plus-CUA, Playwright-only, and browser-act-only catalogs", () => {
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
		const handle = attach({ browser, client });
		for (const entry of cases) {
			expect(handle.compile({ model: entry.model, tools: entry.tools }).tools.map((tool) => tool.name)).toEqual(entry.names);
		}
	});

	it("resolves a ref through the supplied collection, falling back to the registry", () => {
		const models = createCuaModels();
		const openai = models.getProvider("openai")!;
		const first = { ...getCuaModel("openai:gpt-5.5"), baseUrl: "https://first.example" };
		const second = { ...getCuaModel("openai:gpt-5.6-sol"), baseUrl: "https://second.example" };
		models.setProvider({ ...openai, getModels: () => [first, second] });
		const handle = attach({ browser, client, models });

		expect(handle.compile({ model: "openai:gpt-5.5", tools: [] }).model).toBe(first);
		expect(handle.compile({ model: "openai:gpt-5.6-sol", tools: [] }).model).toBe(second);
		// A ref the supplied collection does not carry falls back to the registry
		// rather than being refused: the provider decides what exists.
		expect(handle.compile({ model: "openai:gpt-5.4", tools: [] }).model.id).toBe("gpt-5.4");
	});

	it("refuses a native tool the model cannot take, before anything is applied", async () => {
		const keep = callerTool("keep");
		const { harness, select } = await openSession({ model: "openai:gpt-5.5", tools: [keep] });

		await expect(select("openai:gpt-5.5", [cua.providers.anthropic.tools.browser()])).rejects.toThrow(/requires a anthropic model/);
		expect(harness.getModel().id).toBe("gpt-5.5");
		expect(harness.getTools().map((tool) => tool.name)).toEqual(["keep"]);
	});

	it("retains protocol-required OpenAI native computer screenshot results outside the image replay limit", async () => {
		const contexts: Context[] = [];
		const model = getCuaModel("openai:gpt-5.5");
		const image = { type: "image" as const, data: "c2NyZWVuc2hvdA==", mimeType: "image/png" };
		const messages: AgentMessage[] = [
			assistant(model, [{ type: "toolCall", id: "native-shot", name: "computer", arguments: { action: { type: "screenshot" } } }], "toolUse"),
			{ role: "toolResult", toolCallId: "native-shot", toolName: "computer", content: [image], isError: false, timestamp: 1 },
			assistant(model, [{ type: "toolCall", id: "ordinary-shot", name: "ordinary", arguments: {} }], "toolUse"),
			{ role: "toolResult", toolCallId: "ordinary-shot", toolName: "ordinary", content: [image], isError: false, timestamp: 2 },
		];
		const handle = attach({
			browser,
			client,
			toolResultImageReplayLimit: 0,
			models: modelsFromStream(scriptedStream([(selected) => assistant(selected)], contexts)),
		});
		const compiled = handle.compile({ model, tools: [cua.providers.openai.tools.computer(), callerTool("ordinary")] });
		const agent = new Agent({
			streamFn: (selected, context, options) => compiled.models.streamSimple(selected, context, options),
			initialState: { model: compiled.model, tools: [...compiled.agentTools], messages },
		});

		await agent.prompt("continue");

		const results = contexts[0]!.messages.filter((message) => message.role === "toolResult");
		expect(results[0]!.content).toEqual([image]);
		expect(results[1]!.content).toEqual([{ type: "text", text: "[stale tool-result images omitted]" }]);
	});
});

describe("applying a pair to a live harness", () => {
	it("streams the transport the selection derives", async () => {
		const streamedApis: string[] = [];
		const script = scriptedStream([(selected) => assistant(selected)]);
		const { harness, select } = await openSession({
			model: "google:gemini-3.6-flash",
			tools: [cua.tools.browser.snapshot()],
			models: modelsFromStream((model, context, options) => {
				streamedApis.push(model.api);
				return script(model, context, options);
			}, "google"),
		});
		expect(harness.getModel().api).toBe("google-generative-ai");

		await select("google:gemini-3.6-flash", cua.providers.google.toolsets.browser());
		expect(harness.getModel().api).toBe(GOOGLE_CUA_INTERACTIONS_API);

		await harness.prompt("go");
		expect(streamedApis).toEqual([GOOGLE_CUA_INTERACTIONS_API]);
	});

	it("records no model change when the derived transport is unchanged", async () => {
		const { session, select } = await openSession({ model: "openai:gpt-5.5", tools: [callerTool("first")] });

		await select("openai:gpt-5.5", [callerTool("second")]);

		expect((await session.getBranch()).filter((entry) => entry.type === "model_change")).toEqual([]);
	});

	it("records one model change for a switch that moves both the model and its transport", async () => {
		const { harness, session, select } = await openSession({
			model: "google:gemini-3.6-flash",
			tools: cua.providers.google.toolsets.browser(),
		});
		expect(harness.getModel().api).toBe(GOOGLE_CUA_INTERACTIONS_API);

		await select("openai:gpt-5.5", [cua.tools.browser.snapshot()]);
		expect(harness.getModel().api).toBe("openai-responses");

		expect((await session.getBranch()).filter((entry) => entry.type === "model_change")).toHaveLength(1);
	});

	it("ignores a release from a pair that is no longer live", async () => {
		const seen: Model<string>[] = [];
		const script = scriptedStream([(selected) => assistant(selected)]);
		const models = modelsFromStream((model, context, options) => {
			seen.push(model);
			return script(model, context, options);
		}, "google");
		const session = await new InMemorySessionRepo().create();
		const handle = attach({ browser, client, models });
		const first = handle.compile({ model: "google:gemini-3.6-flash", tools: [cua.tools.browser.snapshot()] });
		const harness = new AgentHarness({
			session,
			model: first.model,
			models: first.models,
			tools: [...first.tools],
			activeToolNames: first.tools.map((tool) => tool.name),
		});
		const releaseFirst = first.activate(harness);

		// Count what each activation registers on the harness and what it takes
		// back, so a leaked pair of handlers is visible.
		let live = 0;
		const on = harness.on.bind(harness);
		harness.on = ((type: never, handler: never) => {
			live += 1;
			const off = on(type, handler);
			return () => {
				live -= 1;
				off();
			};
		}) as typeof harness.on;
		const subscribe = harness.subscribe.bind(harness);
		harness.subscribe = ((listener: never) => {
			live += 1;
			const off = subscribe(listener);
			return () => {
				live -= 1;
				off();
			};
		}) as typeof harness.subscribe;

		await handle.compile({ model: "google:gemini-3.6-flash", tools: cua.providers.google.toolsets.browser() }).apply(harness);
		const afterSwap = live;
		// The caller still holds the first pair's release. Calling it must neither
		// strand `models` with no live catalog nor drop the handle's grip on the
		// pair that *is* live — otherwise the next activation cannot release it.
		releaseFirst();
		await handle.compile({ model: "google:gemini-3.6-flash", tools: [cua.tools.browser.snapshot()] }).apply(harness);
		expect(live).toBe(afterSwap);

		await harness.prompt("go");
		expect(seen.map((model) => model.api)).toEqual(["google-generative-ai"]);
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
		const { harness } = await openSession({
			model: "anthropic:claude-opus-5",
			tools: [cua.providers.anthropic.tools.browser(), failing, succeeding],
			models: modelsFromStream(scriptedStream([
				(model) => assistant(model, [{ type: "toolCall", id: "fail", name: "failing", arguments: {} }], "toolUse"),
				(model) => assistant(model, [{ type: "toolCall", id: "succeed", name: "succeeding", arguments: {} }], "toolUse"),
				(model) => assistant(model, [{ type: "text", text: "done" }]),
			]), "anthropic"),
		});
		harness.on("tool_result", (event) => (event.toolName === "failing" ? { terminate: true } : undefined));

		await harness.prompt("fail once");
		await harness.prompt("try again");

		expect(successfulCalls).toBe(1);
	});
});
