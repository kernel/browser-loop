import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

/** Providers with curated computer-use model support. */
export type CuaProvider = "openai" | "anthropic" | "google" | "xai" | "moonshotai" | "openrouter";

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
export const CUA_PROVIDERS: readonly CuaProvider[] = ["openai", "anthropic", "google", "xai", "moonshotai", "openrouter"];

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

// Muse Spark accepts the full CUA schema set; OpenRouter's provider-level
// defaults are conservative because the proxy fronts many model families.
const MUSE_SPARK_CAPABILITIES: CuaModelCapabilities = Object.freeze({
	acceptsComplexSchemas: true,
	acceptsLargeSchemas: true,
	serializesStateMutations: true,
});

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
		{ match: { kind: "exact", id: "meta/muse-spark-1.1" }, source: "https://openrouter.ai/meta/muse-spark-1.1", capabilities: MUSE_SPARK_CAPABILITIES },
	],
};

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
	if (fromRegistry) return fromRegistry;
	throw new Error(`CUA model "${ref}" is supported but not carried by pi-ai's registry`);
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
	const acceptsComplexSchemas = ["openai", "anthropic", "xai", "moonshotai"].includes(model.provider);
	return {
		acceptsComplexSchemas,
		acceptsLargeSchemas: acceptsComplexSchemas && model.provider !== "moonshotai",
		serializesStateMutations: ["xai", "moonshotai"].includes(model.provider),
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

function compareCuaModels(a: CuaModelInfo, b: CuaModelInfo): number {
	if (a.provider !== b.provider) return CUA_PROVIDERS.indexOf(a.provider) - CUA_PROVIDERS.indexOf(b.provider);
	return a.model.localeCompare(b.model);
}
