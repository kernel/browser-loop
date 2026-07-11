import { describe, expect, it } from "vitest";
import { anthropic, CUA_COMPUTER_ACTION_TYPES, CUA_PROVIDERS, type CuaProvider, gemini, meta, openai, tzafon, yutori } from "../src/index";
import type { CuaProviderModule } from "../src/providers/common";

const MODULES: Record<CuaProvider, { providerModule: CuaProviderModule }> = {
	openai,
	anthropic,
	google: gemini,
	meta,
	tzafon,
	yutori,
};

const NAMESPACES: Record<CuaProvider, { namespace: Record<string, unknown>; prefix: string }> = {
	openai: { namespace: openai, prefix: "OPENAI" },
	anthropic: { namespace: anthropic, prefix: "ANTHROPIC" },
	google: { namespace: gemini, prefix: "GEMINI" },
	meta: { namespace: meta, prefix: "META" },
	tzafon: { namespace: tzafon, prefix: "TZAFON" },
	yutori: { namespace: yutori, prefix: "YUTORI" },
};

describe("provider modules satisfy the uniform contract", () => {
	for (const provider of CUA_PROVIDERS) {
		it(`${provider} conforms to CuaProviderModule`, () => {
			const mod = MODULES[provider].providerModule;

			expect(mod.toolDefinitions).toBeTypeOf("function");
			expect(mod.toolExecutors).toBeTypeOf("function");
			expect(mod.coordinateSystem).toBeTypeOf("function");
			expect(mod.buildSystemPrompt).toBeTypeOf("function");

			expect(Array.isArray(mod.toolDefinitions())).toBe(true);

			const executors = mod.toolExecutors();
			expect(Array.isArray(executors)).toBe(true);
			expect(executors.length).toBeGreaterThan(0);

			const coordinates = mod.coordinateSystem();
			if (coordinates.type === "pixel") {
				expect(coordinates).toEqual({ type: "pixel" });
			} else {
				expect(coordinates.type).toBe("normalized");
				expect(coordinates.range).toHaveLength(2);
				expect(coordinates.range[0]).toBeTypeOf("number");
				expect(coordinates.range[1]).toBeTypeOf("number");
			}

			expect(mod.buildSystemPrompt()).toBeTypeOf("string");
		});
	}

	it("yutori sends no model-facing tool definitions", () => {
		expect(yutori.providerModule.toolDefinitions()).toEqual([]);
	});

	it("meta currently restricts its normalized coordinate contract to computer mode", () => {
		expect(() => meta.providerModule.toolDefinitions({ mode: "browser" })).toThrow(/computer only/);
		expect(() => meta.providerModule.toolDefinitions({ mode: "hybrid" })).toThrow(/computer only/);
	});
});

describe("provider namespaces export a uniform surface", () => {
	for (const provider of CUA_PROVIDERS) {
		it(`${provider} follows the namespace export conventions`, () => {
			const { namespace, prefix } = NAMESPACES[provider];

			const actionTypes = namespace[`${prefix}_CUA_ACTION_TYPES`];
			expect(Array.isArray(actionTypes), `${prefix}_CUA_ACTION_TYPES must be exported`).toBe(true);
			expect((actionTypes as unknown[]).length).toBeGreaterThan(0);
			for (const action of actionTypes as string[]) {
				expect(CUA_COMPUTER_ACTION_TYPES).toContain(action);
			}

			expect(namespace[`${prefix}_COMPUTER_INSTRUCTIONS`], `${prefix}_COMPUTER_INSTRUCTIONS must be exported`).toBeTypeOf(
				"string",
			);
			expect(namespace.computerTools).toBeTypeOf("function");
			expect(namespace.computerToolExecutors).toBeTypeOf("function");
			expect(namespace.createActionSchema).toBeTypeOf("function");
			expect(namespace.coordinateSystem).toBeTypeOf("function");
			expect(namespace.providerModule).toBeTypeOf("object");
		});
	}
});
