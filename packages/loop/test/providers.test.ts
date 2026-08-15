import { describe, expect, it } from "vitest";
import { createLoopModels, loopModels } from "../src/pi/index";

describe("createLoopModels", () => {
	it("registers a streamable provider for every Loop provider", () => {
		const models = createLoopModels();
		for (const id of ["openai", "anthropic", "google", "xai", "moonshotai", "openrouter"]) {
			const provider = models.getProvider(id);
			expect(provider, id).toBeDefined();
			expect(provider?.stream).toBeTypeOf("function");
			expect(provider?.streamSimple).toBeTypeOf("function");
		}
	});

	it("lists Loop provider catalogs", () => {
		const models = createLoopModels();
		expect(models.getModel("xai", "grok-4.5")?.api).toBe("openai-responses");
		expect(models.getModel("moonshotai", "kimi-k3")?.api).toBe("openai-completions");
		expect(models.getModel("openrouter", "moonshotai/kimi-k3")?.api).toBe("openai-completions");
		expect(models.getModel("openrouter", "meta/muse-spark-1.1")?.api).toBe("openai-completions");
		expect(models.getProvider("openrouter")?.baseUrl).toBe("https://openrouter.ai/api/v1");
	});

	it("keeps builtin catalogs on wrapped providers", () => {
		const models = createLoopModels();
		const openaiIds = models.getModels("openai").map((m) => m.id);
		expect(openaiIds).toContain("gpt-5.4");
		// OpenAI models keep pi's builtin "openai-responses" api id on both the
		// collection and getLoopModel(); the wrapped provider only intercepts a
		// model carrying OPENAI_COMPUTER_USE_API or a namespace round-trip (see
		// requiresOpenAINamespaceAdapter).
		expect(models.getModel("openai", "gpt-5.4")?.api).toBe("openai-responses");

		const xaiIds = models.getModels("xai").map((m) => m.id);
		expect(xaiIds).toContain("grok-4.3");
		expect(xaiIds).toContain("grok-4.5");
	});

	it("returns independent collections", () => {
		const a = createLoopModels();
		const b = createLoopModels();
		a.deleteProvider("google");
		expect(a.getProvider("google")).toBeUndefined();
		expect(b.getProvider("google")).toBeDefined();
	});
});

describe("loopModels", () => {
	it("memoizes the default collection", () => {
		expect(loopModels()).toBe(loopModels());
		expect(loopModels().getProvider("openai")).toBeDefined();
	});
});
