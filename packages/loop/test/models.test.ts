import { describe, expect, it } from "vitest";
import {
	COMPUTER_USE_NATIVE_SURFACES,
	computerUseNativeSurfaces,
	formatLoopModelRef,
	getLoopModel,
	listLoopModels,
	LOOP_MODEL_QUIRKS,
	loopModelCapabilities,
	type LoopModelRef,
	loopProviders,
	parseLoopModelRef,
} from "../src/pi/index";

describe("Loop model refs", () => {
	it("parses and formats provider-qualified refs", () => {
		expect(parseLoopModelRef("openai:gpt-5.5")).toEqual({ provider: "openai", model: "gpt-5.5" });
		expect(formatLoopModelRef("openrouter", "meta/muse-spark-1.1")).toBe("openrouter:meta/muse-spark-1.1");
	});

	it("rejects unqualified refs and unknown providers, but not unknown models", () => {
		expect(() => getLoopModel("gpt-5.5" as never)).toThrow(/provider-qualified/);
		expect(() => getLoopModel("bogus:model" as never)).toThrow(/unknown provider/);
		// A model id pi-ai's registry has not caught up with still resolves: the
		// provider decides whether it exists, not a table in this package.
		expect(getLoopModel("openai:gpt-3.5" as never).id).toBe("gpt-3.5");
	});

	it("names pi-ai's providers in the unknown-provider error", () => {
		expect(() => parseLoopModelRef("bogus:model")).toThrow(/unknown provider "bogus" \(pi-ai carries: /);
	});

	it("accepts gemini: as an alias for google:", () => {
		expect(parseLoopModelRef("gemini:gemini-3.6-flash")).toEqual({
			provider: "google",
			model: "gemini-3.6-flash",
		});
		const model = getLoopModel("gemini:gemini-3.6-flash" as never);
		expect(model.provider).toBe("google");
		expect(model.id).toBe("gemini-3.6-flash");
	});

	it("lists curated model refs without a default", () => {
		const models = listLoopModels();
		expect(models.some((model) => model.ref === "openai:gpt-5.6-sol")).toBe(true);
		expect(models.some((model) => model.ref === "openai:gpt-5.5")).toBe(true);
		expect(models.some((model) => model.ref === "anthropic:claude-opus-5")).toBe(true);
		expect(models.every((model) => model.ref.includes(":"))).toBe(true);
		expect(models.some((model) => "default" in model)).toBe(false);
		expect(models.some((model) => "origin" in model)).toBe(false);
	});

	it("returns pi-ai registry entries verbatim", () => {
		const opus = getLoopModel("anthropic:claude-opus-5");
		expect(opus).toMatchObject({
			provider: "anthropic",
			api: "anthropic-messages",
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		});
		expect(opus.compat).toMatchObject({ forceAdaptiveThinking: true, supportsTemperature: false });

		expect(getLoopModel("google:gemini-3.6-flash")).toMatchObject({
			provider: "google",
			api: "google-generative-ai",
			contextWindow: 1_048_576,
		});

		const muse = getLoopModel("openrouter:meta/muse-spark-1.1");
		expect(muse.provider).toBe("openrouter");
		expect(muse.baseUrl).toBe("https://openrouter.ai/api/v1");
	});

	it("returns pi-ai's Grok catalog entry", () => {
		const grok = getLoopModel("xai:grok-4.5");
		expect(grok.provider).toBe("xai");
		expect(grok.api).toBe("openai-responses");
		expect(grok.baseUrl).toBe("https://api.x.ai/v1");
		expect(grok.contextWindow).toBe(500_000);
		expect(grok.maxTokens).toBe(500_000);
	});

	it("uses pi-ai's Kimi catalog entries for both transports", () => {
		const direct = getLoopModel("moonshotai:kimi-k3");
		const routed = getLoopModel("openrouter:moonshotai/kimi-k3");
		expect(direct).toMatchObject({ provider: "moonshotai", id: "kimi-k3", api: "openai-completions" });
		expect(routed).toMatchObject({ provider: "openrouter", id: "moonshotai/kimi-k3", api: "openai-completions" });
		expect(listLoopModels("openrouter").map((model) => model.ref)).toContain("openrouter:moonshotai/kimi-k3");
	});

	it("uses pi-ai's Kimi catalog entry", () => {
		const kimi = getLoopModel("moonshotai:kimi-k3");
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
		expect(parseLoopModelRef("moonshot:kimi-k3")).toEqual({ provider: "moonshotai", model: "kimi-k3" });
		expect(getLoopModel("moonshot:kimi-k3" as LoopModelRef).id).toBe("kimi-k3");
	});

	it("resolves every model to its ordinary registry transport, independent of tool selection", () => {
		// getLoopModel() never derives a tool-driven transport: OPENAI_COMPUTER_USE_API
		// and GOOGLE_INTERACTIONS_API are only ever carried by a model that
		// compileLoopToolCatalog compiled with the matching native tool selected
		// (see tool-catalog.test.ts's transport derivation coverage).
		expect(getLoopModel("openai:gpt-5.6-sol").api).toBe("openai-responses");
		expect(getLoopModel("openai:gpt-5.5").api).toBe("openai-responses");
		expect(getLoopModel("openai:gpt-5.4-mini").api).toBe("openai-responses");
		expect(getLoopModel("google:gemini-3.6-flash").api).toBe("google-generative-ai");
		expect(getLoopModel("xai:grok-4.5").api).toBe("openai-responses");
	});

	it("synthesizes models pi-ai's registry does not carry", () => {
		// pi-ai's registry (generated from models.dev) carries family roots, not
		// dated snapshots, and lags a provider's newest ids. Both still resolve,
		// inheriting the transport and base URL from the provider's other models.
		const snapshot = getLoopModel("openai:gpt-5.5-2026-04-23");
		expect(snapshot.id).toBe("gpt-5.5-2026-04-23");
		expect(snapshot.provider).toBe("openai");
		expect(snapshot.api).toBe(getLoopModel("openai:gpt-5.5").api);
		expect(snapshot.baseUrl).toBe(getLoopModel("openai:gpt-5.5").baseUrl);

		// The motivating case: a model the provider has shipped and models.dev
		// has not picked up yet.
		expect(getLoopModel("xai:grok-4.6").id).toBe("grok-4.6");
	});

	it("synthesizes from the nearest, newest sibling", () => {
		// xAI carries grok-4.3 on chat completions and grok-4.5 on Responses, so
		// picking the wrong sibling would send a new Grok to the wrong transport.
		expect(getLoopModel("xai:grok-4.5").api).toBe("openai-responses");
		expect(getLoopModel("xai:grok-4.6").api).toBe("openai-responses");
		expect(getLoopModel("xai:grok-4.6").baseUrl).toBe(getLoopModel("xai:grok-4.5").baseUrl);
		expect(getLoopModel("anthropic:claude-opus-6").api).toBe("anthropic-messages");
	});
});

describe("native surfaces", () => {
	it("cites first-party documentation for every entry", () => {
		for (const entry of COMPUTER_USE_NATIVE_SURFACES) {
			expect(entry.source).toMatch(/^https?:\/\//);
			expect(entry.surfaces.length).toBeGreaterThan(0);
		}
	});

	it("matches family roots, dated snapshots, and numeric revisions", () => {
		expect(computerUseNativeSurfaces(getLoopModel("openai:gpt-5.5"))).toEqual(["computer"]);
		expect(computerUseNativeSurfaces(getLoopModel("openai:gpt-5.5-2026-04-23"))).toEqual(["computer"]);
		expect(computerUseNativeSurfaces(getLoopModel("openai:gpt-5.4-mini"))).toEqual(["computer"]);
		expect(computerUseNativeSurfaces(getLoopModel("anthropic:claude-opus-5"))).toEqual(["computer", "browser"]);
		expect(computerUseNativeSurfaces(getLoopModel("anthropic:claude-opus-5-20260724"))).toEqual(["computer", "browser"]);
	});

	it("does not match adjacent families or named sibling variants", () => {
		expect(computerUseNativeSurfaces(getLoopModel("openai:gpt-5.4-nano"))).toEqual([]);
		expect(computerUseNativeSurfaces(getLoopModel("openai:gpt-5.4-pro"))).toEqual([]);
		expect(computerUseNativeSurfaces(getLoopModel("anthropic:claude-3-5-sonnet"))).toEqual([]);
	});

	it("reports no native surface for models that have none, without refusing them", () => {
		expect(computerUseNativeSurfaces(getLoopModel("moonshotai:kimi-k3"))).toEqual([]);
		expect(computerUseNativeSurfaces(getLoopModel("xai:grok-4.5"))).toEqual([]);
		// A model with no native surface still resolves and runs on Loop's own tools.
		expect(getLoopModel("xai:grok-4.5").provider).toBe("xai");
	});

	it("surfaces the flag on catalog listings", () => {
		const google = listLoopModels("google");
		const flash = google.find((model) => model.model === "gemini-3.6-flash");
		expect(flash?.nativeSurfaces).toEqual(["browser"]);
		expect(flash?.vision).toBe(true);
		expect(google.some((model) => model.nativeSurfaces.length === 0)).toBe(true);
	});
});

describe("model quirks", () => {
	it("explains why every quirk exists", () => {
		for (const quirk of LOOP_MODEL_QUIRKS) {
			expect(quirk.reason.length).toBeGreaterThan(20);
			expect(Object.keys(quirk.capabilities).length).toBeGreaterThan(0);
		}
	});

	it("defaults to permissive for a model with no quirk", () => {
		expect(loopModelCapabilities(getLoopModel("openai:gpt-5.6-sol"))).toEqual({
			acceptsComplexSchemas: true,
			acceptsLargeSchemas: true,
			serializesStateMutations: false,
		});
		// Including a model pi-ai's registry does not carry.
		expect(loopModelCapabilities(getLoopModel("xai:grok-4.6")).acceptsComplexSchemas).toBe(true);
	});

	it("keeps the limits we have evidence for", () => {
		// Google no longer carries a schema quirk. What the Gemini API rejects is two
		// JSON Schema keywords it does not know — `const` and `additionalProperties` —
		// and the catalog narrows both for it, so the same declarations every other
		// provider gets are accepted. Verified live against the Gemini API.
		expect(loopModelCapabilities(getLoopModel("google:gemini-3.6-flash")).acceptsComplexSchemas).toBe(true);
		expect(loopModelCapabilities(getLoopModel("google:gemini-3.6-flash")).acceptsLargeSchemas).toBe(true);
		// Observed live: Kimi K3 rejects the request once browser_act is attached.
		expect(loopModelCapabilities(getLoopModel("moonshotai:kimi-k3")).acceptsLargeSchemas).toBe(false);
		expect(loopModelCapabilities(getLoopModel("openrouter:moonshotai/kimi-k3")).acceptsLargeSchemas).toBe(false);
		// Muse Spark accepts the large schema but serializes state mutations.
		const muse = loopModelCapabilities(getLoopModel("openrouter:meta/muse-spark-1.1"));
		expect(muse.acceptsLargeSchemas).toBe(true);
		expect(muse.serializesStateMutations).toBe(true);
	});

	it("applies a provider-wide quirk to every model from that provider", () => {
		expect(loopModelCapabilities(getLoopModel("xai:grok-4.5")).serializesStateMutations).toBe(true);
		expect(loopModelCapabilities(getLoopModel("xai:grok-4.6")).serializesStateMutations).toBe(true);
	});
});

describe("catalog passthrough", () => {
	it("exposes every provider pi-ai carries", () => {
		expect(loopProviders().length).toBeGreaterThan(20);
		expect(loopProviders()).toContain("openai");
		expect(loopProviders()).toContain("groq");
		expect(loopProviders()).toContain("zai");
	});

	it("lists models no Loop table mentions", () => {
		const all = listLoopModels();
		expect(all.length).toBeGreaterThan(100);
		// Previously refused for want of a table entry.
		expect(all.some((model) => model.ref === "xai:grok-4.3")).toBe(true);
		expect(all.some((model) => model.provider === "groq")).toBe(true);
	});
});
