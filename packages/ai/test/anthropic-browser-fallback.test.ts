import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type Provider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	compileCuaToolCatalog,
	cua,
	getCuaModel,
	type CuaSimpleStreamOptions,
	type CuaToolCatalogResources,
	type CuaToolSpec,
} from "../src/index";
import { withAnthropicBrowserFallback } from "../src/providers/anthropic/browser-fallback";

const resources: CuaToolCatalogResources = {
	viewport: { width: 1440, height: 900 },
	materialize(spec: CuaToolSpec): AgentTool {
		return {
			...spec.declaration,
			label: spec.name,
			executionMode: "sequential",
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
	},
	async osScreenshot() {
		return { data: Buffer.from("image"), mimeType: "image/png" };
	},
};

const context: Context = {
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "Use the browser." }], timestamp: 1 }],
	tools: [],
};

describe("Anthropic native browser access fallback", () => {
	it("retries with the equivalent function tool and remembers the credential", async () => {
		const model = getCuaModel("anthropic:claude-opus-5");
		const catalog = compileCuaToolCatalog({
			model,
			requestedTools: [cua.providers.anthropic.tools.browser()],
			resources,
		});
		const payloads: Array<{ tools: unknown[]; headers: SimpleStreamOptions["headers"] }> = [];
		let calls = 0;
		const base = fakeProvider(async (selectedModel, options) => {
			calls += 1;
			const raw = { tools: [{ name: "browser", input_schema: {} }] };
			const payload = (await options?.onPayload?.(raw, selectedModel) ?? raw) as { tools: unknown[] };
			payloads.push({ tools: payload.tools, headers: options?.headers });
			return calls === 1
				? message(selectedModel, "error", "API key does not have access to browser_20260701")
				: message(selectedModel, "toolUse");
		});
		const provider = withAnthropicBrowserFallback(base);
		const options: CuaSimpleStreamOptions = {
			apiKey: "fallback-test-key",
			headers: catalog.headers.merge({ "anthropic-beta": "other-beta" }),
			cuaIncomingToolPlan: catalog.incoming,
			onPayload: (payload) => catalog.payload.apply(payload, model),
		};

		await expect(provider.streamSimple(model, { ...context, tools: catalog.agentTools }, options).result()).resolves.toMatchObject({ stopReason: "toolUse" });
		expect(calls).toBe(2);
		expect(payloads[0]?.tools[0]).toMatchObject({ type: "browser_20260701" });
		expect(payloads[0]?.headers).toMatchObject({ "anthropic-beta": "other-beta,browser-use-2026-07-01" });
		expect(payloads[1]?.tools[0]).toMatchObject({ name: "browser", input_schema: { anyOf: expect.any(Array) } });
		expect(payloads[1]?.tools[0]).not.toHaveProperty("type");
		expect(payloads[1]?.headers).toEqual({ "anthropic-beta": "other-beta" });

		await provider.streamSimple(model, { ...context, tools: catalog.agentTools }, options).result();
		expect(calls).toBe(3);
		expect(payloads[2]?.tools[0]).not.toHaveProperty("type");
	});

	it("does not hide unrelated provider errors", async () => {
		const model = getCuaModel("anthropic:claude-opus-5");
		const catalog = compileCuaToolCatalog({
			model,
			requestedTools: [cua.providers.anthropic.tools.browser()],
			resources,
		});
		let calls = 0;
		const provider = withAnthropicBrowserFallback(fakeProvider(async (selectedModel) => {
			calls += 1;
			return message(selectedModel, "error", "rate limit exceeded");
		}));

		const result = await provider.streamSimple(model, { ...context, tools: catalog.agentTools }, {
			apiKey: "non-access-error-test-key",
			cuaIncomingToolPlan: catalog.incoming,
		}).result();

		expect(calls).toBe(1);
		expect(result).toMatchObject({ stopReason: "error", errorMessage: "rate limit exceeded" });
	});
});

function fakeProvider(
	respond: (model: Model<Api>, options?: SimpleStreamOptions) => Promise<AssistantMessage>,
): Provider {
	const streamSimple = (model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
		const stream = createAssistantMessageEventStream();
		void (async () => {
			const response = await respond(model, options);
			if (response.stopReason === "error") stream.push({ type: "error", reason: "error", error: response });
			else {
				stream.push({ type: "start", partial: response });
				stream.push({ type: "done", reason: response.stopReason, message: response });
			}
			stream.end(response);
		})();
		return stream;
	};
	return {
		id: "anthropic",
		name: "Anthropic",
		stream: streamSimple,
		streamSimple,
	} as unknown as Provider;
}

function message(model: Model<Api>, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
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
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: 1,
	};
}
