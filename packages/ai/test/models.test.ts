import { describe, expect, it } from "vitest";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
	CUA_MODEL_ANNOTATIONS,
	CUA_PROVIDERS,
	type CuaModelRef,
	cuaOverrideModels,
	findCuaAnnotation,
	formatCuaModelRef,
	getCuaModel,
	listCuaModels,
	parseCuaModelRef,
} from "../src/index";

describe("CUA model refs", () => {
	it("parses and formats provider-qualified refs", () => {
		expect(parseCuaModelRef("openai:gpt-5.5")).toEqual({ provider: "openai", model: "gpt-5.5" });
		expect(formatCuaModelRef("meta", "muse-spark-1.1")).toBe("meta:muse-spark-1.1");
	});

	it("rejects unqualified and unsupported refs", () => {
		expect(() => getCuaModel("gpt-5.5" as never)).toThrow(/provider-qualified/);
		expect(() => getCuaModel("bogus:model" as never)).toThrow(/unsupported CUA provider/);
		expect(() => getCuaModel("openai:gpt-3.5" as never)).toThrow(/unsupported CUA model/);
	});

	it("names the valid providers in the unsupported-provider error", () => {
		expect(() => parseCuaModelRef("bogus:model")).toThrow(
			'unsupported CUA provider "bogus" (expected one of: openai, anthropic, google, meta, xai, moonshotai, openrouter)',
		);
	});

	it("accepts gemini: as an alias for google:", () => {
		expect(parseCuaModelRef("gemini:gemini-3.6-flash")).toEqual({
			provider: "google",
			model: "gemini-3.6-flash",
		});
		const model = getCuaModel("gemini:gemini-3.6-flash" as never);
		expect(model.provider).toBe("google");
		expect(model.id).toBe("gemini-3.6-flash");
	});

	it("lists curated model refs without a default", () => {
		const models = listCuaModels();
		expect(models.some((model) => model.ref === "openai:gpt-5.6-sol")).toBe(true);
		expect(models.some((model) => model.ref === "openai:gpt-5.5")).toBe(true);
		expect(models.some((model) => model.ref === "anthropic:claude-opus-5")).toBe(true);
		expect(models.every((model) => model.ref.includes(":"))).toBe(true);
		expect(models.some((model) => "default" in model)).toBe(false);
		expect(models.some((model) => "origin" in model)).toBe(false);
	});

	it("returns override models for refs missing from pi-ai", () => {
		const opus = getCuaModel("anthropic:claude-opus-5");
		expect(cuaOverrideModels("anthropic")).toEqual([]);
		expect(opus).toMatchObject({
			provider: "anthropic",
			api: "anthropic-messages",
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		});
		expect(opus.compat).toMatchObject({ forceAdaptiveThinking: true, supportsTemperature: false });

		expect(cuaOverrideModels("google")).toEqual([]);
		expect(getCuaModel("google:gemini-3.6-flash")).toMatchObject({
			provider: "google",
			api: "google-generative-ai",
			contextWindow: 1_048_576,
		});

		const muse = getCuaModel("meta:muse-spark-1.1");
		expect(muse.provider).toBe("meta");
		expect(muse.api).toBe("openai-responses");
		expect(muse.baseUrl).toBe("https://api.meta.ai/v1");
		expect(muse.contextWindow).toBe(1_048_576);
		expect(muse.maxTokens).toBe(128_000);
		expect(muse.thinkingLevelMap?.off).toBeNull();
	});

	it("returns pi-ai's Grok catalog entry unmodified", () => {
		expect(cuaOverrideModels("xai")).toEqual([]);
		const grok = getCuaModel("xai:grok-4.5");
		expect(grok.provider).toBe("xai");
		expect(grok.api).toBe("openai-responses");
		expect(grok.baseUrl).toBe("https://api.x.ai/v1");
		expect(grok.contextWindow).toBe(500_000);
		expect(grok.maxTokens).toBe(500_000);
		// pi's registry data is used as-is: no CUA-owned thinking-level, cost, or
		// compat patching survives model resolution.
		expect(grok.thinkingLevelMap).toEqual(getBuiltinModel("xai", "grok-4.5").thinkingLevelMap);
		expect(grok.cost.tiers).toBeUndefined();
	});

	it("uses pi-ai's Kimi catalog entries for both transports", () => {
		const direct = getCuaModel("moonshotai:kimi-k3");
		const routed = getCuaModel("openrouter:moonshotai/kimi-k3");
		expect(direct).toMatchObject({ provider: "moonshotai", id: "kimi-k3", api: "openai-completions" });
		expect(routed).toMatchObject({ provider: "openrouter", id: "moonshotai/kimi-k3", api: "openai-completions" });
		expect(listCuaModels("openrouter").map((model) => model.ref)).toContain("openrouter:moonshotai/kimi-k3");
	});

	it("uses pi-ai's Kimi catalog entry without CUA routing overrides", () => {
		expect(cuaOverrideModels("moonshotai")).toEqual([]);
		const kimi = getCuaModel("moonshotai:kimi-k3");
		expect(kimi.provider).toBe("moonshotai");
		expect(kimi.api).toBe("openai-completions");
		expect(kimi.baseUrl).toBe("https://api.moonshot.ai/v1");
		expect(kimi.input).toContain("image");
		expect(kimi.contextWindow).toBe(1_048_576);
		expect(kimi.maxTokens).toBe(131_072);
		// Pi's K3 metadata maps low/high/max and clamps the rest away.
		expect(kimi.thinkingLevelMap?.low).toBe("low");
		expect(kimi.thinkingLevelMap?.high).toBe("high");
		expect(kimi.thinkingLevelMap?.max).toBe("max");
		expect(kimi.thinkingLevelMap?.medium).toBeNull();
	});

	it("accepts the moonshot: alias for moonshotai refs", () => {
		expect(parseCuaModelRef("moonshot:kimi-k3")).toEqual({ provider: "moonshotai", model: "kimi-k3" });
		expect(getCuaModel("moonshot:kimi-k3" as CuaModelRef).id).toBe("kimi-k3");
	});

	it("resolves every model to its ordinary registry transport, independent of tool selection", () => {
		// getCuaModel() never derives a tool-driven transport: OPENAI_CUA_COMPUTER_API
		// and GOOGLE_CUA_INTERACTIONS_API are only ever carried by a model that
		// compileCuaToolCatalog compiled with the matching native tool selected
		// (see tool-catalog.test.ts's transport derivation coverage).
		expect(getCuaModel("openai:gpt-5.6-sol").api).toBe("openai-responses");
		expect(getCuaModel("openai:gpt-5.5").api).toBe("openai-responses");
		expect(getCuaModel("openai:gpt-5.4-mini").api).toBe("openai-responses");
		expect(getCuaModel("google:gemini-3.6-flash").api).toBe("google-generative-ai");
		expect(getCuaModel("meta:muse-spark-1.1").api).toBe("openai-responses");
		expect(getCuaModel("xai:grok-4.5").api).toBe("openai-responses");
	});

	it("rejects supported model IDs that are not in pi-ai or overrides", () => {
		// Dated snapshots match the family annotation but pi-ai's registry
		// (generated from models.dev) only carries family roots.
		expect(() => getCuaModel("openai:gpt-5.5-2026-04-23")).toThrow(
			/not registered/,
		);
	});
});

describe("CUA support annotations", () => {
	it("covers every provider", () => {
		for (const provider of CUA_PROVIDERS) {
			expect(CUA_MODEL_ANNOTATIONS[provider].length).toBeGreaterThan(0);
		}
	});

	it("cites an official source for every annotation", () => {
		for (const provider of CUA_PROVIDERS) {
			for (const annotation of CUA_MODEL_ANNOTATIONS[provider]) {
				expect(annotation.source).toMatch(/^https?:\/\//);
			}
		}
	});

	it("matches family roots, dated snapshots, and numeric revisions", () => {
		expect(findCuaAnnotation("openai", "gpt-5.5")?.match).toEqual({ kind: "family", family: "gpt-5.5" });
		expect(findCuaAnnotation("openai", "gpt-5.5-2026-04-23")?.match).toEqual({ kind: "family", family: "gpt-5.5" });
		expect(findCuaAnnotation("openai", "gpt-5.4-mini")?.match).toEqual({ kind: "family", family: "gpt-5.4-mini" });
		expect(findCuaAnnotation("openai", "gpt-5.4-mini-2026-03-17")?.match).toEqual({ kind: "family", family: "gpt-5.4-mini" });
		expect(findCuaAnnotation("anthropic", "claude-opus-4-7")).toBeDefined();
		expect(findCuaAnnotation("anthropic", "claude-opus-5")?.match).toEqual({ kind: "family", family: "claude-opus-5" });
		expect(findCuaAnnotation("anthropic", "claude-opus-5-20260724")?.match).toEqual({ kind: "family", family: "claude-opus-5" });
		expect(findCuaAnnotation("anthropic", "claude-3-7-sonnet-20250219")).toBeDefined();
	});

	it("does not match adjacent families", () => {
		expect(findCuaAnnotation("openai", "gpt-5.55-foo")).toBeUndefined();
		expect(findCuaAnnotation("openai", "gpt-5.6")).toBeUndefined();
		expect(findCuaAnnotation("anthropic", "claude-3-5-sonnet")).toBeUndefined();
	});

	it("does not match named sibling variants of a family", () => {
		expect(findCuaAnnotation("openai", "gpt-5.4-nano")).toBeUndefined();
		expect(findCuaAnnotation("openai", "gpt-5.4-pro")).toBeUndefined();
		expect(findCuaAnnotation("openai", "gpt-5.5-pro")).toBeUndefined();
		const openaiModels = listCuaModels("openai").map((model) => model.model);
		expect(openaiModels).not.toContain("gpt-5.4-nano");
		expect(openaiModels).not.toContain("gpt-5.4-pro");
		expect(openaiModels).toContain("gpt-5.5");
	});

	it("matches exact-id annotations", () => {
		expect(findCuaAnnotation("openai", "gpt-5.6-sol")?.match).toEqual({ kind: "exact", id: "gpt-5.6-sol" });
		expect(findCuaAnnotation("openai", "gpt-5.6-sol-20260728")).toBeUndefined();
		expect(findCuaAnnotation("google", "gemini-3.6-flash")).toBeDefined();
		expect(findCuaAnnotation("meta", "muse-spark-1.1")).toBeDefined();
		expect(findCuaAnnotation("xai", "grok-4.5")).toBeDefined();
		expect(findCuaAnnotation("xai", "grok-4.5-latest")).toBeUndefined();
		expect(findCuaAnnotation("xai", "grok-4.3")).toBeUndefined();
		expect(findCuaAnnotation("moonshotai", "kimi-k3")).toBeDefined();
		expect(findCuaAnnotation("moonshotai", "kimi-k2.5")).toBeUndefined();
		expect(findCuaAnnotation("moonshotai", "kimi-latest")).toBeUndefined();
		expect(findCuaAnnotation("google", "gemini-3.5-flash-lite")).toBeDefined();
	});

	it("advertises only Google's current documented computer-use models", () => {
		expect(listCuaModels("google").map((model) => model.model)).toEqual([
			"gemini-3.5-flash",
			"gemini-3.5-flash-lite",
			"gemini-3.6-flash",
		]);
		for (const retired of [
			"gemini-2.5-computer-use-preview-10-2025",
			"gemini-3-flash-preview",
			"gemini-3.1-flash-lite",
			"gemini-3-pro-preview",
		]) {
			expect(findCuaAnnotation("google", retired)).toBeUndefined();
			expect(() => getCuaModel(`google:${retired}` as CuaModelRef)).toThrow(/unsupported CUA model/);
		}
	});
});
