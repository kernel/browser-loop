import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { supportsAnthropicNativeBrowser, supportsAnthropicNativeComputer } from "./providers/anthropic/capabilities";

/** A pi-ai provider id. Any provider pi-ai carries can be selected. */
export type LoopProvider = string;

/** Provider-qualified model reference, e.g. `"openai:gpt-5.6-sol"` or `"google:gemini-3.6-flash"`. */
export type LoopModelRef = `${string}:${string}`;

/** A provider-native tool surface Loop can offer for a model. */
export type ComputerUseNativeSurface = "computer" | "browser";

/** One entry returned by {@link listLoopModels}. */
export interface LoopModelInfo {
	/** Provider-qualified ref accepted by {@link getLoopModel}. */
	ref: LoopModelRef;
	provider: LoopProvider;
	/** Provider-native model id (the part after the colon). */
	model: string;
	/** Human-readable model name. */
	name: string;
	/** Provider-native tool surfaces available for this model, if any. */
	nativeSurfaces: readonly ComputerUseNativeSurface[];
	/** Whether the model accepts image input, i.e. whether screenshot-based tools are usable. */
	vision: boolean;
}

/**
 * How a model-id table entry matches.
 *
 * - `exact`: `id === match.id`
 * - `family`: `id === match.family`, or `match.family` plus hyphen-separated
 *   numeric segments (revisions and dated snapshots, e.g. "claude-opus-4-7",
 *   "gpt-5.5-2026-04-23"). Named variants like "gpt-5.4-mini" are distinct
 *   models and need their own entry.
 */
export type LoopModelMatch =
	| { readonly kind: "exact"; readonly id: string }
	| { readonly kind: "family"; readonly family: string };

/** Loop tool-catalog capabilities for a concrete model. */
export interface LoopModelCapabilities {
	readonly acceptsComplexSchemas: boolean;
	readonly acceptsLargeSchemas: boolean;
	readonly serializesStateMutations: boolean;
}

/**
 * A model or provider whose request handling differs from the permissive
 * default, with the evidence for it. Entries exist to prevent a request the
 * provider would reject — never to express a preference.
 */
export interface LoopModelQuirk {
	readonly provider: LoopProvider;
	/** Omit to apply the quirk to every model from the provider. */
	readonly match?: LoopModelMatch;
	readonly capabilities: Partial<LoopModelCapabilities>;
	/** Why this quirk exists: the documented limit or the observed failure. */
	readonly reason: string;
}

/**
 * Models with a provider-native computer or browser tool, and the first-party
 * documentation for it. This table answers "can Loop offer a native tool for
 * this model", not "may this model run" — every model pi-ai carries runs, with
 * Loop's own CDP browser tools.
 *
 * Anthropic is absent deliberately: its native surfaces are version-gated in
 * `providers/anthropic/capabilities.ts`, which {@link computerUseNativeSurfaces} reads.
 */
export const COMPUTER_USE_NATIVE_SURFACES: readonly {
	readonly provider: LoopProvider;
	readonly match: LoopModelMatch;
	readonly surfaces: readonly ComputerUseNativeSurface[];
	readonly source: string;
}[] = [
	{ provider: "openai", match: { kind: "exact", id: "gpt-5.6-sol" }, surfaces: ["computer"], source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol" },
	{ provider: "openai", match: { kind: "family", family: "gpt-5.4" }, surfaces: ["computer"], source: "https://developers.openai.com/api/docs/models/gpt-5.4" },
	{ provider: "openai", match: { kind: "family", family: "gpt-5.4-mini" }, surfaces: ["computer"], source: "https://developers.openai.com/api/docs/models/gpt-5.4-mini" },
	{ provider: "openai", match: { kind: "family", family: "gpt-5.5" }, surfaces: ["computer"], source: "https://developers.openai.com/api/docs/models/gpt-5.5" },
	{ provider: "google", match: { kind: "exact", id: "gemini-3.6-flash" }, surfaces: ["browser"], source: "https://ai.google.dev/gemini-api/docs/computer-use" },
	{ provider: "google", match: { kind: "exact", id: "gemini-3.5-flash" }, surfaces: ["browser"], source: "https://ai.google.dev/gemini-api/docs/computer-use" },
	{ provider: "google", match: { kind: "exact", id: "gemini-3.5-flash-lite" }, surfaces: ["browser"], source: "https://ai.google.dev/gemini-api/docs/computer-use" },
	{ provider: "google", match: { kind: "exact", id: "gemini-2.5-computer-use-preview-10-2025" }, surfaces: ["browser"], source: "https://ai.google.dev/gemini-api/docs/computer-use" },
];

/**
 * Known request-shape limits. Anything absent from this table gets the
 * permissive default and is allowed to try; a provider-side error is the
 * feedback. Every entry below is a limit we have documentation for or have
 * observed against the live API.
 */
export const LOOP_MODEL_QUIRKS: readonly LoopModelQuirk[] = [
	{
		provider: "moonshotai",
		capabilities: { acceptsLargeSchemas: false },
		reason: "Moonshot answers 400 \"schema exceeds maximum allowed size\" once browser_act's schema is attached; observed on kimi-k2.5 and kimi-k3.",
	},
	{
		provider: "moonshotai",
		match: { kind: "exact", id: "kimi-k3" },
		capabilities: { serializesStateMutations: true },
		reason: "Kimi K3 serializes state mutations.",
	},
	{
		provider: "openrouter",
		match: { kind: "exact", id: "moonshotai/kimi-k3" },
		capabilities: { acceptsLargeSchemas: false, serializesStateMutations: true },
		reason: "Same Kimi K3 limits, reached through OpenRouter.",
	},
	{
		provider: "openrouter",
		match: { kind: "exact", id: "meta/muse-spark-1.1" },
		capabilities: { serializesStateMutations: true },
		reason: "Muse Spark's computer-use cookbook disables parallel tool calls.",
	},
	{
		provider: "xai",
		capabilities: { serializesStateMutations: true },
		reason: "Grok's computer-use guidance disables parallel tool calls for state-mutating catalogs.",
	},
];

const PERMISSIVE_CAPABILITIES: LoopModelCapabilities = Object.freeze({
	acceptsComplexSchemas: true,
	acceptsLargeSchemas: true,
	serializesStateMutations: false,
});

/** Provider prefixes accepted as aliases for a pi-ai provider id. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = { gemini: "google", moonshot: "moonshotai" };

/**
 * Split a provider-qualified ref like `"openai:gpt-5.6-sol"` into its parts.
 *
 * `"gemini:"` is accepted as an alias for the canonical `"google:"` prefix and
 * `"moonshot:"` for `"moonshotai"`. Throws when the ref is unqualified or names
 * a provider pi-ai does not carry.
 */
export function parseLoopModelRef(ref: string): { provider: LoopProvider; model: string } {
	const idx = ref.indexOf(":");
	if (idx <= 0 || idx === ref.length - 1) {
		throw new Error(`Loop model ref must be provider-qualified as "<provider>:<model>"; got "${ref}"`);
	}
	const prefix = ref.slice(0, idx);
	const provider = PROVIDER_ALIASES[prefix] ?? prefix;
	const model = ref.slice(idx + 1);
	if (!loopProviders().includes(provider)) {
		throw new Error(`unknown provider "${prefix}" (pi-ai carries: ${loopProviders().join(", ")})`);
	}
	return { provider, model };
}

/** Join a provider and model id into a {@link LoopModelRef}. */
export function formatLoopModelRef(provider: LoopProvider, model: string): LoopModelRef {
	return `${provider}:${model}` as LoopModelRef;
}

/** Every provider id pi-ai carries. */
export function loopProviders(): readonly LoopProvider[] {
	return getBuiltinProviders();
}

/**
 * List the models pi-ai carries, optionally filtered to one provider, each
 * annotated with the provider-native surfaces Loop can offer for it.
 */
export function listLoopModels(provider?: LoopProvider): LoopModelInfo[] {
	const providers = provider ? [PROVIDER_ALIASES[provider] ?? provider] : [...loopProviders()];
	const byRef = new Map<LoopModelRef, LoopModelInfo>();

	for (const p of providers) {
		for (const model of getBuiltinModels(p as never) as Model<Api>[]) {
			const ref = formatLoopModelRef(p, model.id);
			if (byRef.has(ref)) continue;
			byRef.set(ref, {
				ref,
				provider: p,
				model: model.id,
				name: model.name,
				nativeSurfaces: computerUseNativeSurfaces(model),
				vision: model.input.includes("image"),
			});
		}
	}

	return [...byRef.values()].sort(compareLoopModels);
}

/**
 * Resolve a {@link LoopModelRef} to a concrete pi-ai model.
 *
 * A ref pi-ai's registry does not carry is synthesized from the provider's
 * other models, so a model id works the day the provider ships it rather than
 * when models.dev catches up. Throws only for an unqualified ref or a provider
 * pi-ai does not carry.
 */
export function getLoopModel(ref: LoopModelRef): Model<Api> {
	const { provider, model: modelId } = parseLoopModelRef(ref);
	const fromRegistry = getBuiltinModel(provider as never, modelId as never) as Model<Api> | undefined;
	if (fromRegistry) return fromRegistry;
	return synthesizeLoopModel(provider, modelId);
}

/**
 * Build a model entry for an id pi-ai's registry does not carry, using another
 * model from the same provider for the transport, base URL, and compatibility
 * fields it cannot know from the id alone.
 *
 * The template is the sibling sharing the longest id prefix, and the latest
 * such sibling when several tie. Providers migrate transports mid-generation —
 * xAI carries grok-4.3 on chat completions and grok-4.5 on Responses — so a new
 * id should follow its nearest, newest relative rather than whichever model
 * happens to come first.
 */
function synthesizeLoopModel(provider: LoopProvider, modelId: string): Model<Api> {
	const siblings = getBuiltinModels(provider as never) as Model<Api>[];
	if (siblings.length === 0) {
		throw new Error(`provider "${provider}" carries no models to infer "${modelId}" from`);
	}
	let template = siblings[0]!;
	let bestPrefix = -1;
	siblings.forEach((sibling, index) => {
		const prefix = sharedPrefixLength(sibling.id.toLowerCase(), modelId.toLowerCase());
		if (prefix >= bestPrefix) {
			bestPrefix = prefix;
			template = siblings[index]!;
		}
	});
	return { ...template, id: modelId, name: modelId };
}

function sharedPrefixLength(a: string, b: string): number {
	let length = 0;
	while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
	return length;
}

/** Return the provider id for a concrete model. */
export function providerForModel(model: Model<Api>): LoopProvider {
	return model.provider;
}

/** Provider-native tool surfaces available for a model, if any. */
export function computerUseNativeSurfaces(model: Model<Api>): readonly ComputerUseNativeSurface[] {
	if (model.provider === "anthropic") {
		const surfaces: ComputerUseNativeSurface[] = [];
		if (supportsAnthropicNativeComputer(model.id)) surfaces.push("computer");
		if (supportsAnthropicNativeBrowser(model.id)) surfaces.push("browser");
		return surfaces;
	}
	for (const entry of COMPUTER_USE_NATIVE_SURFACES) {
		if (entry.provider === model.provider && matchesModelId(model.id, entry.match)) return entry.surfaces;
	}
	return [];
}

/**
 * Tool-catalog capabilities for a model: permissive unless a quirk says
 * otherwise. Provider-wide quirks apply first, then model-specific ones.
 */
export function loopModelCapabilities(model: Model<Api>): LoopModelCapabilities {
	let capabilities = PERMISSIVE_CAPABILITIES;
	for (const quirk of LOOP_MODEL_QUIRKS) {
		if (quirk.provider !== model.provider) continue;
		if (quirk.match && !matchesModelId(model.id, quirk.match)) continue;
		capabilities = { ...capabilities, ...quirk.capabilities };
	}
	return capabilities;
}

/** Find the quirks that apply to a model, for diagnostics and menu hints. */
export function loopModelQuirks(model: Model<Api>): readonly LoopModelQuirk[] {
	return LOOP_MODEL_QUIRKS.filter(
		(quirk) => quirk.provider === model.provider && (!quirk.match || matchesModelId(model.id, quirk.match)),
	);
}

function matchesModelId(modelId: string, match: LoopModelMatch): boolean {
	const id = modelId.toLowerCase();
	return match.kind === "exact" ? id === match.id.toLowerCase() : isFamilyMatch(id, match.family.toLowerCase());
}

// A family entry covers its root id plus suffixes made of hyphen-separated
// numeric segments: revisions like "claude-opus-4-7" and dated snapshots like
// "gpt-5.5-2026-04-23". Named sibling variants ("gpt-5.4-mini") are distinct
// models and need their own entry.
function isFamilyMatch(id: string, family: string): boolean {
	if (id === family) return true;
	if (!id.startsWith(`${family}-`)) return false;
	return id
		.slice(family.length + 1)
		.split("-")
		.every((segment) => /^\d+$/.test(segment));
}

function compareLoopModels(a: LoopModelInfo, b: LoopModelInfo): number {
	if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
	return a.model.localeCompare(b.model);
}
