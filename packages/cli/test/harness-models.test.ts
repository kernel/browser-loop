import { describe, expect, it } from "vitest";
import { DEFAULT_CUA_MODEL_REF, listSupportedModels, resolveCuaModelRef } from "../src/harness-models";

describe("resolveCuaModelRef", () => {
	it("defaults to openai:gpt-5.6-sol", () => {
		expect(resolveCuaModelRef(undefined)).toBe(DEFAULT_CUA_MODEL_REF);
		expect(resolveCuaModelRef("")).toBe(DEFAULT_CUA_MODEL_REF);
	});

	it("passes provider-qualified refs through", () => {
		expect(resolveCuaModelRef("openai:gpt-5.6-sol")).toBe("openai:gpt-5.6-sol");
		expect(resolveCuaModelRef("openai:gpt-5.5")).toBe("openai:gpt-5.5");
		expect(resolveCuaModelRef("anthropic:claude-opus-5")).toBe("anthropic:claude-opus-5");
		expect(resolveCuaModelRef("openrouter:meta/muse-spark-1.1")).toBe("openrouter:meta/muse-spark-1.1");
		expect(resolveCuaModelRef("xai:grok-4.5")).toBe("xai:grok-4.5");
		expect(resolveCuaModelRef("moonshotai:kimi-k3")).toBe("moonshotai:kimi-k3");
		expect(resolveCuaModelRef("moonshot:kimi-k3")).toBe("moonshotai:kimi-k3");
	});

	it("accepts bare ids when they match exactly one catalog entry", () => {
		expect(resolveCuaModelRef("gpt-5.6-sol")).toBe("openai:gpt-5.6-sol");
		expect(resolveCuaModelRef("gpt-5.5")).toBe("openai:gpt-5.5");
		expect(resolveCuaModelRef("claude-opus-5")).toBe("anthropic:claude-opus-5");
		expect(resolveCuaModelRef("meta/muse-spark-1.1")).toBe("openrouter:meta/muse-spark-1.1");
		expect(resolveCuaModelRef("grok-4.5")).toBe("xai:grok-4.5");
		expect(resolveCuaModelRef("kimi-k3")).toBe("moonshotai:kimi-k3");
	});

	it("throws on unknown bare ids", () => {
		expect(() => resolveCuaModelRef("does-not-exist")).toThrow(/unknown model/);
	});

	it("filters to a provider's whole catalog", () => {
		// No allowlist: every model the provider carries is listed, including the
		// ones no CUA table mentions.
		const xai = listSupportedModels("xai").map((model) => model.ref);
		expect(xai).toContain("xai:grok-4.5");
		expect(xai).toContain("xai:grok-4.3");
		expect(listSupportedModels("moonshotai").map((model) => model.ref)).toContain("moonshotai:kimi-k3");
		expect(listSupportedModels("moonshot").map((model) => model.ref)).toContain("moonshotai:kimi-k3");
		expect(listSupportedModels("openrouter").map((model) => model.ref)).toContain("openrouter:meta/muse-spark-1.1");
		expect(resolveCuaModelRef("openrouter:moonshotai/kimi-k3")).toBe("openrouter:moonshotai/kimi-k3");
	});

	it("rejects a provider pi-ai does not carry", () => {
		expect(() => listSupportedModels("bogus")).toThrow(/unknown provider "bogus"/);
	});

	it("treats 'gemini' as an alias for google when filtering", () => {
		const fromGemini = listSupportedModels("gemini");
		const fromGoogle = listSupportedModels("google");
		expect(fromGemini.map((m) => m.ref)).toEqual(fromGoogle.map((m) => m.ref));
		expect(fromGoogle.length).toBeGreaterThan(0);
	});
});
