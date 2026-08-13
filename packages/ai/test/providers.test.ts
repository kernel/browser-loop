import { describe, expect, it } from "vitest";
import {
	createCuaModels,
	cuaModels,
	TZAFON_RESPONSES_API,
	YUTORI_CHAT_COMPLETIONS_API,
} from "../src/index";

describe("createCuaModels", () => {
	it("registers the CUA-only providers alongside pi's builtins", () => {
		const models = createCuaModels();
		for (const id of ["openai", "anthropic", "google", "meta", "xai", "moonshotai", "openrouter", "tzafon", "yutori"]) {
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
		const tzafonIds = models.getModels("tzafon").map((m) => m.id);
		expect(tzafonIds).toContain("tzafon.northstar-cua-fast");
		const yutoriIds = models.getModels("yutori").map((m) => m.id);
		expect(yutoriIds).toContain("n1.5-latest");
		expect(models.getProvider("tzafon")?.baseUrl).toBe("https://api.tzafon.ai");
		expect(models.getModel("tzafon", "tzafon.northstar-cua-fast")).toMatchObject({
			api: TZAFON_RESPONSES_API,
			baseUrl: "https://api.tzafon.ai",
		});
		expect(models.getModel("yutori", "n1.5-latest")?.api).toBe(YUTORI_CHAT_COMPLETIONS_API);
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
		a.deleteProvider("tzafon");
		expect(a.getProvider("tzafon")).toBeUndefined();
		expect(b.getProvider("tzafon")).toBeDefined();
	});
});

describe("cuaModels", () => {
	it("memoizes the default collection", () => {
		expect(cuaModels()).toBe(cuaModels());
		expect(cuaModels().getProvider("yutori")).toBeDefined();
	});
});
