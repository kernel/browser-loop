import { describe, expect, it } from "vitest";
import { createCuaModels, cuaModels, tzafon, yutori } from "../src/index";
import { OPENAI_CUA_RESPONSES_API } from "../src/providers/openai/provider";

const TZAFON_RESPONSES_API = tzafon.TZAFON_RESPONSES_API;
const YUTORI_CHAT_COMPLETIONS_API = yutori.YUTORI_CHAT_COMPLETIONS_API;

describe("createCuaModels", () => {
	it("registers the CUA-only providers alongside pi's builtins", () => {
		const models = createCuaModels();
		for (const id of ["openai", "anthropic", "google", "meta", "xai", "tzafon", "yutori"]) {
			const provider = models.getProvider(id);
			expect(provider, id).toBeDefined();
			expect(provider?.stream).toBeTypeOf("function");
			expect(provider?.streamSimple).toBeTypeOf("function");
		}
	});

	it("lists CUA provider catalogs", () => {
		const models = createCuaModels();
		expect(models.getModel("meta", "muse-spark-1.1")?.api).toBe("meta-responses");
		expect(models.getModel("xai", "grok-4.5")?.api).toBe("openai-completions");
		const tzafonIds = models.getModels("tzafon").map((m) => m.id);
		expect(tzafonIds).toContain("tzafon.northstar-cua-fast");
		const yutoriIds = models.getModels("yutori").map((m) => m.id);
		expect(yutoriIds).toContain("n1.5-latest");
		expect(models.getModel("tzafon", "tzafon.northstar-cua-fast")?.api).toBe(TZAFON_RESPONSES_API);
		expect(models.getModel("yutori", "n1.5-latest")?.api).toBe(YUTORI_CHAT_COMPLETIONS_API);
	});

	it("keeps builtin catalogs on wrapped providers", () => {
		const models = createCuaModels();
		const openaiIds = models.getModels("openai").map((m) => m.id);
		expect(openaiIds).toContain("gpt-5.4");
		// The catalog keeps pi's api ids; getCuaModel() routes to
		// openai-cua-responses, which the wrapped provider dispatches.
		expect(models.getModel("openai", "gpt-5.4")?.api).not.toBe(OPENAI_CUA_RESPONSES_API);

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
