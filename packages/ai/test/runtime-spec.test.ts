import { describe, expect, it } from "vitest";
import { CUA_NAVIGATION_TOOL_NAME, CUA_PROVIDERS, getCuaModel, listCuaModels, meta, openai, resolveCuaRuntimeSpec, xai } from "../src/index";

describe("resolveCuaRuntimeSpec", () => {
	it("resolves a runtime spec for every CUA provider", () => {
		for (const provider of CUA_PROVIDERS) {
			const model = listCuaModels(provider)[0];
			expect(model, `no CUA model configured for provider ${provider}`).toBeDefined();

			const spec = resolveCuaRuntimeSpec(model!.ref);
			expect(spec.provider).toBe(provider);
			expect(spec.model.id).toBe(model!.model);
			expect(typeof spec.defaultSystemPrompt).toBe("string");
			expect(spec.coordinateSystem).toBeDefined();
			expect(spec.toolExecutors.length).toBeGreaterThan(0);
			expect(spec.toolDefinitions.map((tool) => tool.name)).not.toContain(CUA_NAVIGATION_TOOL_NAME);
			if (provider === "anthropic") {
				expect(spec.toolDefinitions.map((tool) => tool.name)).toContain("computer_batch");
				expect(spec.toolExecutors.map((executor) => executor.definition.name)).toContain("computer_batch");
			}
			if (provider === "yutori") {
				expect(spec.toolDefinitions).toEqual([]);
				expect(spec.defaultSystemPrompt).toBe("");
				expect(spec.screenshot).toEqual({
					appendToLatestMessage: true,
					transform: { width: 1280, height: 800, format: "webp", quality: 90 },
				});
			} else {
				expect(spec.defaultSystemPrompt.length).toBeGreaterThan(0);
			}
		}
	});

	it("only sets payload middleware for providers that need it", () => {
		const yutoriSpec = resolveCuaRuntimeSpec("yutori:n1.5-latest");
		const openaiSpec = resolveCuaRuntimeSpec("openai:gpt-5.5");
		const xaiSpec = resolveCuaRuntimeSpec("xai:grok-4.5");
		const tzafonSpec = resolveCuaRuntimeSpec("tzafon:tzafon.northstar-cua-fast");
		const anthropicSpec = resolveCuaRuntimeSpec("anthropic:claude-opus-4-7");
		expect(yutoriSpec.onPayload).toBeTypeOf("function");
		expect(tzafonSpec.onPayload).toBeTypeOf("function");
		// OpenAI and xAI need no runtime payload middleware: their Responses
		// transports apply threading constraints. Anthropic uses middleware to
		// adapt newer adaptive-thinking models without changing callers.
		expect(openaiSpec.onPayload).toBeUndefined();
		expect(xaiSpec.onPayload).toBeUndefined();
		expect(anthropicSpec.onPayload).toBeTypeOf("function");
	});

	it("routes concrete Responses models to provider-specific APIs", () => {
		const openaiModel = { ...getCuaModel("openai:gpt-5.5"), api: "openai-responses" } as Parameters<typeof resolveCuaRuntimeSpec>[0];
		expect(resolveCuaRuntimeSpec(openaiModel).model.api).toBe(openai.OPENAI_CUA_RESPONSES_API);

		const metaModel = { ...getCuaModel("meta:muse-spark-1.1"), api: "openai-responses" } as Parameters<typeof resolveCuaRuntimeSpec>[0];
		expect(resolveCuaRuntimeSpec(metaModel).model.api).toBe(meta.META_RESPONSES_API);

		const xaiModel = { ...getCuaModel("xai:grok-4.5"), api: "openai-completions" } as Parameters<typeof resolveCuaRuntimeSpec>[0];
		expect(resolveCuaRuntimeSpec(xaiModel).model.api).toBe(xai.XAI_CUA_RESPONSES_API);
	});

	it("threads tool options through to the provider module", () => {
		const openaiSpec = resolveCuaRuntimeSpec("openai:gpt-5.5", { actions: ["click"] });
		expect(openaiSpec.toolDefinitions.map((tool) => tool.name)).toEqual(["click"]);
		expect(openaiSpec.toolExecutors.map((executor) => executor.definition.name)).toEqual(["click"]);

		const anthropicSpec = resolveCuaRuntimeSpec("anthropic:claude-opus-4-7", { actions: ["click"] });
		expect(anthropicSpec.toolDefinitions.map((tool) => tool.name)).toEqual(["click", "computer_batch"]);

		const yutoriSpec = resolveCuaRuntimeSpec("yutori:n1.5-latest", { actions: ["click"] });
		expect(yutoriSpec.toolDefinitions).toEqual([]);
		expect(yutoriSpec.toolExecutors.map((executor) => executor.definition.name)).toEqual(["click"]);
	});
});
