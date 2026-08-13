import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { GOOGLE_CUA_INTERACTIONS_API } from "./providers/google/provider";
import { META_RESPONSES_API } from "./providers/meta/provider";
import { XAI_CUA_RESPONSES_API } from "./providers/xai/provider";

/** Providers with curated computer-use model support. */
export type CuaProvider = "openai" | "anthropic" | "google" | "meta" | "xai" | "moonshotai" | "openrouter" | "tzafon" | "yutori";

/** Provider-qualified model reference, e.g. `"openai:gpt-5.6-sol"` or `"google:gemini-3.6-flash"`. */
export type CuaModelRef = `${CuaProvider}:${string}`;

/** One entry returned by {@link listCuaModels}. */
export interface CuaModelInfo {
	/** Provider-qualified ref accepted by {@link getCuaModel}. */
	ref: CuaModelRef;
	provider: CuaProvider;
	/** Provider-native model id (the part after the colon). */
	model: string;
	/** Human-readable model name. */
	name: string;
}

/** All providers this package curates computer-use models for. */
export const CUA_PROVIDERS: readonly CuaProvider[] = ["openai", "anthropic", "google", "meta", "xai", "moonshotai", "openrouter", "tzafon", "yutori"];

/**
 * How a {@link CuaModelAnnotation} matches model ids.
 *
 * - `exact`: `id === match.id`
 * - `family`: `id === match.family`, or `match.family` plus hyphen-separated
 *   numeric segments (revisions and dated snapshots, e.g. "claude-opus-4-7",
 *   "gpt-5.5-2026-04-23"). Named variants like "gpt-5.4-mini" are distinct
 *   models and need their own entry.
 */
export type CuaModelMatch =
	| { readonly kind: "exact"; readonly id: string }
	| { readonly kind: "family"; readonly family: string };

/** CUA tool-catalog capabilities for a concrete model. */
export interface CuaModelCapabilities {
	readonly acceptsComplexSchemas: boolean;
	readonly acceptsLargeSchemas: boolean;
	readonly serializesStateMutations: boolean;
}

/** One CUA-support annotation: a model-id match plus the official source documenting support. */
export interface CuaModelAnnotation {
	readonly match: CuaModelMatch;
	/** URL of the provider documentation establishing computer-use support. */
	readonly source: string;
	/** Optional tool-catalog capabilities that describe which CUA schemas and state mutations the model supports. */
	readonly capabilities?: CuaModelCapabilities;
}

const KIMI_K3_CAPABILITIES: CuaModelCapabilities = Object.freeze({
	acceptsComplexSchemas: true,
	acceptsLargeSchemas: false,
	serializesStateMutations: true,
});

/**
 * Per-provider computer-use support annotations.
 *
 * pi-ai's model registry is generated from models.dev (see
 * node_modules/@earendil-works/pi-ai/scripts/generate-models.ts) and lists every
 * model a provider offers. Only some of those models support computer-use, so
 * this table layers per-provider CUA-support annotations on top of the
 * registry. Each entry cites the official source documenting CUA support.
 *
 * To verify support and add new entries, follow the `update-models` skill at
 * .agents/skills/update-models/SKILL.md.
 */
export const CUA_MODEL_ANNOTATIONS: Record<CuaProvider, readonly CuaModelAnnotation[]> = {
	openai: [
		{ match: { kind: "exact", id: "gpt-5.6-sol" }, source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol" },
		{ match: { kind: "family", family: "gpt-5.4" }, source: "https://developers.openai.com/api/docs/models/gpt-5.4" },
		{ match: { kind: "family", family: "gpt-5.4-mini" }, source: "https://developers.openai.com/api/docs/models/gpt-5.4-mini" },
		{ match: { kind: "family", family: "gpt-5.5" }, source: "https://developers.openai.com/api/docs/models/gpt-5.5" },
	],
	anthropic: [
		{ match: { kind: "family", family: "claude-3-7-sonnet" }, source: "https://docs.anthropic.com/en/docs/build-with-claude/computer-use" },
		{ match: { kind: "family", family: "claude-opus-4" }, source: "https://docs.anthropic.com/en/docs/build-with-claude/computer-use" },
		{ match: { kind: "family", family: "claude-opus-5" }, source: "https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool" },
		{ match: { kind: "family", family: "claude-sonnet-4" }, source: "https://docs.anthropic.com/en/docs/build-with-claude/computer-use" },
		{ match: { kind: "family", family: "claude-sonnet-5" }, source: "https://docs.anthropic.com/en/docs/build-with-claude/computer-use" },
		{ match: { kind: "family", family: "claude-haiku-4" }, source: "https://docs.anthropic.com/en/docs/build-with-claude/computer-use" },
		{ match: { kind: "family", family: "claude-fable-5" }, source: "https://docs.anthropic.com/en/docs/build-with-claude/computer-use" },
	],
	google: [
		{ match: { kind: "exact", id: "gemini-3.6-flash" }, source: "https://ai.google.dev/gemini-api/docs/computer-use" },
		{ match: { kind: "exact", id: "gemini-3.5-flash-lite" }, source: "https://ai.google.dev/gemini-api/docs/computer-use" },
		{ match: { kind: "exact", id: "gemini-3.5-flash" }, source: "https://ai.google.dev/gemini-api/docs/computer-use" },
	],
	meta: [
		{ match: { kind: "exact", id: "muse-spark-1.1" }, source: "https://dev.meta.ai/docs/getting-started/cookbook/computer-use-macos" },
	],
	xai: [
		{ match: { kind: "exact", id: "grok-4.5" }, source: "https://docs.x.ai/developers/grok-4-5" },
	],
	// Kimi computer use is custom-function-tool support over Moonshot's
	// OpenAI-compatible API, not a provider-native computer tool. K3 ships
	// native vision plus screenshot-grounded agentic tool use.
	moonshotai: [
		{ match: { kind: "exact", id: "kimi-k3" }, source: "https://www.kimi.com/blog/kimi-k3", capabilities: KIMI_K3_CAPABILITIES },
	],
	openrouter: [
		{ match: { kind: "exact", id: "moonshotai/kimi-k3" }, source: "https://openrouter.ai/moonshotai/kimi-k3", capabilities: KIMI_K3_CAPABILITIES },
	],
	tzafon: [
		{ match: { kind: "exact", id: "tzafon.northstar-cua-fast" }, source: "https://huggingface.co/Tzafon/Northstar-CUA-Fast" },
		{ match: { kind: "exact", id: "tzafon.northstar-cua-fast-1.6" }, source: "https://huggingface.co/Tzafon/Northstar-CUA-Fast" },
		{ match: { kind: "exact", id: "tzafon.northstar-cua-fast-1.7-experiment" }, source: "https://huggingface.co/Tzafon/Northstar-CUA-Fast" },
	],
	yutori: [
		{ match: { kind: "exact", id: "n1-latest" }, source: "https://docs.yutori.com/reference/navigator" },
		{ match: { kind: "exact", id: "n1-20260203" }, source: "https://docs.yutori.com/reference/navigator" },
		{ match: { kind: "exact", id: "n1.5-latest" }, source: "https://docs.yutori.com/reference/navigator" },
		{ match: { kind: "exact", id: "n1.5-20260428" }, source: "https://docs.yutori.com/reference/navigator" },
	],
};

// Models that CUA supports which pi-ai's registry does not yet carry. Each
// entry is a complete Model<Api> so getCuaModel() can return it directly
// without synthesizing fields at call time. Add an entry here when a provider
// ships a new model before pi-ai picks it up — and add a matching annotation
// in CUA_MODEL_ANNOTATIONS above so the support filter recognizes it.
const CUA_MODEL_OVERRIDES: Record<CuaProvider, readonly Model<Api>[]> = {
	openai: [],
	anthropic: [],
	google: [],
	// pi-ai still lacks Meta's models.dev catalog entry.
	meta: [cuaModel("meta", "muse-spark-1.1", "Muse Spark 1.1")],
	xai: [],
	moonshotai: [],
	openrouter: [],
	tzafon: [
		cuaModel("tzafon", "tzafon.northstar-cua-fast", "Tzafon Northstar CUA Fast"),
		cuaModel("tzafon", "tzafon.northstar-cua-fast-1.6", "Tzafon Northstar CUA Fast 1.6"),
		cuaModel("tzafon", "tzafon.northstar-cua-fast-1.7-experiment", "Tzafon Northstar CUA Fast 1.7 (experiment)"),
	],
	yutori: [
		cuaModel("yutori", "n1.5-latest", "Yutori Navigator n1.5"),
		cuaModel("yutori", "n1.5-20260428", "Yutori Navigator n1.5 (2026-04-28)"),
		cuaModel("yutori", "n1-latest", "Yutori Navigator n1"),
		cuaModel("yutori", "n1-20260203", "Yutori Navigator n1 (2026-02-03)"),
	],
};

/** Models CUA supports that pi-ai's registry does not carry for a provider. */
export function cuaOverrideModels(provider: CuaProvider): readonly Model<Api>[] {
	return CUA_MODEL_OVERRIDES[provider];
}

/**
 * Split a provider-qualified ref like `"openai:gpt-5.6-sol"` into its parts.
 *
 * `"gemini:"` is accepted as an alias for the canonical `"google:"` prefix
 * and normalizes to provider `"google"`; `"moonshot:"` likewise normalizes
 * to `"moonshotai"`. Throws when the ref is unqualified or names an
 * unsupported provider.
 */
export function parseCuaModelRef(ref: string): { provider: CuaProvider; model: string } {
	const idx = ref.indexOf(":");
	if (idx <= 0 || idx === ref.length - 1) {
		throw new Error(`CUA model ref must be provider-qualified as "<provider>:<model>"; got "${ref}"`);
	}
	const prefix = ref.slice(0, idx);
	const provider = prefix === "gemini" ? "google" : prefix === "moonshot" ? "moonshotai" : prefix;
	const model = ref.slice(idx + 1);
	if (!isCuaProvider(provider)) {
		throw new Error(`unsupported CUA provider "${prefix}" (expected one of: ${CUA_PROVIDERS.join(", ")})`);
	}
	return { provider, model };
}

/** Join a provider and model id into a {@link CuaModelRef}. */
export function formatCuaModelRef(provider: CuaProvider, model: string): CuaModelRef {
	return `${provider}:${model}` as CuaModelRef;
}

/**
 * List the computer-use-capable models this package curates, optionally
 * filtered to one provider. Merges pi-ai's registry with local overrides and
 * keeps only models annotated in {@link CUA_MODEL_ANNOTATIONS}.
 */
export function listCuaModels(provider?: CuaProvider): CuaModelInfo[] {
	const providers = provider ? [provider] : [...CUA_PROVIDERS];
	const byRef = new Map<CuaModelRef, CuaModelInfo>();

	for (const p of providers) {
		for (const model of CUA_MODEL_OVERRIDES[p]) {
			const ref = formatCuaModelRef(p, model.id);
			byRef.set(ref, { ref, provider: p, model: model.id, name: model.name });
		}
		for (const model of getBuiltinModels(p as never) as Model<Api>[]) {
			if (!supportsCuaProvider(p, model.id)) continue;
			const ref = formatCuaModelRef(p, model.id);
			if (byRef.has(ref)) continue;
			byRef.set(ref, {
				ref,
				provider: p,
				model: model.id,
				name: model.name,
			});
		}
	}

	return [...byRef.values()].sort(compareCuaModels);
}

/**
 * Resolve a {@link CuaModelRef} to a concrete pi-ai model.
 *
 * Throws when the ref is unqualified, names an unsupported provider, or names
 * a model without a CUA-support annotation. `"gemini:"` refs are accepted as
 * an alias for `"google:"` (see {@link parseCuaModelRef}).
 */
export function getCuaModel(ref: CuaModelRef): Model<Api> {
	const { provider, model: modelId } = parseCuaModelRef(ref);
	if (!supportsCuaProvider(provider, modelId)) {
		throw new Error(`unsupported CUA model "${ref}"`);
	}
	const fromRegistry = getBuiltinModel(provider as never, modelId as never) as Model<Api> | undefined;
	if (fromRegistry) return routeCuaApi(fromRegistry);
	const override = CUA_MODEL_OVERRIDES[provider].find((m) => m.id === modelId);
	if (override) return routeCuaApi(override);
	throw new Error(`CUA model "${ref}" is supported but not registered. Add it to pi-ai (models.dev) or CUA_MODEL_OVERRIDES.`);
}

// Route CUA models to provider-specific transports. OpenAI keeps pi-ai's
// builtin "openai-responses" api and streams through its automatic prompt
// caching; the CUA adapter dispatches on request shape (see
// requiresCuaOpenAIAdapter), not on a rerouted api id. Other registry-resolved
// models otherwise carry pi-ai's builtin API ids too.
export function routeCuaApi(model: Model<Api>): Model<Api> {
	if (model.provider === "google" && model.api !== GOOGLE_CUA_INTERACTIONS_API) {
		return { ...model, api: GOOGLE_CUA_INTERACTIONS_API };
	}
	if (model.provider === "meta" && model.api !== META_RESPONSES_API) {
		return { ...model, api: META_RESPONSES_API };
	}
	if (model.provider === "xai" && model.id === "grok-4.5") {
		return {
			...model,
			api: XAI_CUA_RESPONSES_API,
			thinkingLevelMap: { off: "low", minimal: "low", xhigh: "high" },
			cost: {
				...model.cost,
				tiers: [{ inputTokensAbove: 200_000, input: 4, output: 12, cacheRead: 1, cacheWrite: 0 }],
			},
			compat: { supportsDeveloperRole: false, sessionAffinityFormat: "openai-nosession", supportsLongCacheRetention: false },
		};
	}
	return model;
}

/** Return the {@link CuaProvider} for a concrete model, or throw when it is not a CUA provider. */
export function providerForModel(model: Model<Api>): CuaProvider {
	if (!isCuaProvider(model.provider)) {
		throw new Error(`unsupported CUA model provider "${model.provider}" (expected one of: ${CUA_PROVIDERS.join(", ")})`);
	}
	return model.provider;
}

/** Narrow an arbitrary string to {@link CuaProvider}. */
export function isCuaProvider(value: string): value is CuaProvider {
	return (CUA_PROVIDERS as readonly string[]).includes(value);
}

function supportsCuaProvider(provider: CuaProvider, modelId: string): boolean {
	return findCuaAnnotation(provider, modelId) !== undefined;
}

/** Return tool-catalog capabilities for a model, using annotation or provider defaults. */
export function cuaModelCapabilities(model: Model<Api>): CuaModelCapabilities {
	const annotation = isCuaProvider(model.provider) ? findCuaAnnotation(model.provider, model.id) : undefined;
	if (annotation?.capabilities) return annotation.capabilities;
	const acceptsComplexSchemas = ["openai", "anthropic", "meta", "xai", "moonshotai"].includes(model.provider);
	return {
		acceptsComplexSchemas,
		acceptsLargeSchemas: acceptsComplexSchemas && model.provider !== "moonshotai",
		serializesStateMutations: ["meta", "xai", "moonshotai"].includes(model.provider),
	};
}

/** Find the CUA-support annotation covering a model id, if any. */
export function findCuaAnnotation(provider: CuaProvider, modelId: string): CuaModelAnnotation | undefined {
	const id = modelId.toLowerCase();
	for (const annotation of CUA_MODEL_ANNOTATIONS[provider]) {
		if (annotation.match.kind === "exact") {
			if (id === annotation.match.id.toLowerCase()) return annotation;
		} else if (isCuaFamilyMatch(id, annotation.match.family.toLowerCase())) {
			return annotation;
		}
	}
	return undefined;
}

// A family annotation covers its root id plus suffixes made of
// hyphen-separated numeric segments: revisions like "claude-opus-4-7" and
// dated snapshots like "gpt-5.5-2026-04-23" or "claude-3-7-sonnet-20250219".
// Named sibling variants ("gpt-5.4-mini") may not support computer use and
// must be annotated explicitly.
function isCuaFamilyMatch(id: string, family: string): boolean {
	if (id === family) return true;
	if (!id.startsWith(`${family}-`)) return false;
	return id
		.slice(family.length + 1)
		.split("-")
		.every((segment) => /^\d+$/.test(segment));
}

function cuaModel(provider: "meta" | "tzafon" | "yutori", id: string, name: string): Model<Api> {
	const base = {
		id,
		name,
		provider,
		reasoning: provider === "meta",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} satisfies Partial<Model<Api>>;

	switch (provider) {
		case "meta":
			// Meta documents the 1,048,576-token context window, and its
			// computer-use cookbook configures 128,000 maximum output tokens.
			return {
				...base,
				api: META_RESPONSES_API,
				baseUrl: "https://api.meta.ai/v1",
				thinkingLevelMap: { off: null, xhigh: "xhigh" },
				cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 128_000,
				compat: { supportsDeveloperRole: true, sessionAffinityFormat: "openai-nosession", supportsLongCacheRetention: true },
			} as Model<Api>;
		case "tzafon":
			return { ...base, api: "tzafon-responses", baseUrl: "https://api.tzafon.ai", contextWindow: 128_000, maxTokens: 4_096 } as Model<Api>;
		case "yutori":
			return { ...base, api: "yutori-chat-completions", baseUrl: "https://api.yutori.com/v1", contextWindow: 128_000, maxTokens: 4_096 } as Model<Api>;
	}
}

function compareCuaModels(a: CuaModelInfo, b: CuaModelInfo): number {
	if (a.provider !== b.provider) return CUA_PROVIDERS.indexOf(a.provider) - CUA_PROVIDERS.indexOf(b.provider);
	return a.model.localeCompare(b.model);
}
