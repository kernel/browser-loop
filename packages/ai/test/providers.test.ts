import { describe, expect, it } from "vitest";
import { createCuaModels, cuaModels } from "../src/index";

describe("createCuaModels", () => {
	it("registers the CUA-only providers alongside pi's builtins", () => {
		const models = createCuaModels();
		for (const id of ["openai", "anthropic", "google", "meta", "xai", "moonshotai", "openrouter"]) {
			const provider = models.getProvider(id);
			expect(provider, id).toBeDefined();
			expect(provider?.stream).toBeTypeOf("function");
			expect(provider?.streamSimple).toBeTypeOf("function");
		}
	});

	it("lists CUA provider catalogs", () => {
		const models = createCuaModels();
		expect(models.getModel("meta", "muse-spark-1.1")?.api).toBe("openai-responses");
		expect(models.getModel("xai", "grok-4.5")?.api).toBe("openai-responses");
		expect(models.getModel("moonshotai", "kimi-k3")?.api).toBe("openai-completions");
		expect(models.getModel("openrouter", "moonshotai/kimi-k3")?.api).toBe("openai-completions");
		expect(models.getProvider("openrouter")?.baseUrl).toBe("https://openrouter.ai/api/v1");
		expect(models.getModels("meta").map((m) => m.id)).toContain("muse-spark-1.1");
		expect(models.getProvider("meta")?.baseUrl).toBe("https://api.meta.ai/v1");
	});

	it("keeps builtin catalogs on wrapped providers", () => {
		const models = createCuaModels();
		const openaiIds = models.getModels("openai").map((m) => m.id);
		expect(openaiIds).toContain("gpt-5.4");
		// OpenAI models keep pi's builtin "openai-responses" api id on both the
		// collection and getCuaModel(); the wrapped provider only intercepts a
		// model carrying OPENAI_CUA_COMPUTER_API or a namespace round-trip (see
		// requiresCuaOpenAINamespaceAdapter).
		expect(models.getModel("openai", "gpt-5.4")?.api).toBe("openai-responses");

		const xaiIds = models.getModels("xai").map((m) => m.id);
		expect(xaiIds).toContain("grok-4.3");
		expect(xaiIds).toContain("grok-4.5");
	});

	it("returns independent collections", () => {
		const a = createCuaModels();
		const b = createCuaModels();
		a.deleteProvider("meta");
		expect(a.getProvider("meta")).toBeUndefined();
		expect(b.getProvider("meta")).toBeDefined();
	});
});

describe("cuaModels", () => {
	it("memoizes the default collection", () => {
		expect(cuaModels()).toBe(cuaModels());
		expect(cuaModels().getProvider("meta")).toBeDefined();
	});
});
