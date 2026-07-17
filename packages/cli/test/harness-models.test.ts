import { describe, expect, it } from "vitest";
import { DEFAULT_CUA_MODEL_REF, listSupportedModels, resolveCuaModelRef } from "../src/harness-models";

describe("resolveCuaModelRef", () => {
	it("defaults to openai:gpt-5.5", () => {
		expect(resolveCuaModelRef(undefined)).toBe(DEFAULT_CUA_MODEL_REF);
		expect(resolveCuaModelRef("")).toBe(DEFAULT_CUA_MODEL_REF);
	});

	it("passes provider-qualified refs through", () => {
		expect(resolveCuaModelRef("openai:gpt-5.5")).toBe("openai:gpt-5.5");
		expect(resolveCuaModelRef("meta:muse-spark-1.1")).toBe("meta:muse-spark-1.1");
		expect(resolveCuaModelRef("xai:grok-4.5")).toBe("xai:grok-4.5");
		expect(resolveCuaModelRef("moonshotai:kimi-k3")).toBe("moonshotai:kimi-k3");
		expect(resolveCuaModelRef("moonshot:kimi-k3")).toBe("moonshotai:kimi-k3");
	});

	it("accepts bare ids when they match exactly one catalog entry", () => {
		expect(resolveCuaModelRef("gpt-5.5")).toBe("openai:gpt-5.5");
		expect(resolveCuaModelRef("muse-spark-1.1")).toBe("meta:muse-spark-1.1");
		expect(resolveCuaModelRef("grok-4.5")).toBe("xai:grok-4.5");
		expect(resolveCuaModelRef("kimi-k3")).toBe("moonshotai:kimi-k3");
	});

	it("throws on unknown bare ids", () => {
		expect(() => resolveCuaModelRef("does-not-exist")).toThrow(/unknown model/);
	});

	it("filters custom provider catalogs", () => {
		expect(listSupportedModels("meta").map((model) => model.ref)).toEqual(["meta:muse-spark-1.1"]);
		expect(listSupportedModels("xai").map((model) => model.ref)).toEqual(["xai:grok-4.5"]);
		expect(listSupportedModels("moonshotai").map((model) => model.ref)).toEqual(["moonshotai:kimi-k3"]);
		expect(listSupportedModels("moonshot").map((model) => model.ref)).toEqual(["moonshotai:kimi-k3"]);
	});

	it("treats 'gemini' as an alias for google when filtering", () => {
		const fromGemini = listSupportedModels("gemini");
		const fromGoogle = listSupportedModels("google");
		expect(fromGemini.map((m) => m.ref)).toEqual(fromGoogle.map((m) => m.ref));
		expect(fromGoogle.length).toBeGreaterThan(0);
	});
});
