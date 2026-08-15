/** The model fields Loop's core consults for per-model availability. */
export interface LoopModelIdentity {
	readonly provider: string;
	readonly id: string;
}

/**
 * Framework-neutral view of a compiled catalog's model: identity, the
 * transport the catalog derives, and provider compatibility flags. A pi-ai
 * `Model` satisfies this shape structurally; core never sees more of it.
 */
export interface LoopCatalogModel extends LoopModelIdentity {
	readonly api: string;
	readonly compat?: unknown;
}

/** A provider-native tool surface Loop can offer for a model. */
export type ComputerUseNativeSurface = "computer" | "browser";

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
	readonly provider: string;
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
 * Anthropic is absent deliberately: its native surfaces are version-gated by
 * the family tables below, which {@link computerUseNativeSurfaces} reads.
 */
export const COMPUTER_USE_NATIVE_SURFACES: readonly {
	readonly provider: string;
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

/** Provider-native tool surfaces available for a model, if any. */
export function computerUseNativeSurfaces(model: LoopModelIdentity): readonly ComputerUseNativeSurface[] {
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
export function loopModelCapabilities(model: LoopModelIdentity): LoopModelCapabilities {
	let capabilities = PERMISSIVE_CAPABILITIES;
	for (const quirk of LOOP_MODEL_QUIRKS) {
		if (quirk.provider !== model.provider) continue;
		if (quirk.match && !matchesModelId(model.id, quirk.match)) continue;
		capabilities = { ...capabilities, ...quirk.capabilities };
	}
	return capabilities;
}

/** Find the quirks that apply to a model, for diagnostics and menu hints. */
export function loopModelQuirks(model: LoopModelIdentity): readonly LoopModelQuirk[] {
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

const NATIVE_BROWSER_FAMILIES = ["claude-opus-4-8", "claude-opus-5", "claude-sonnet-5"] as const;
const NATIVE_COMPUTER_FAMILIES = ["claude-fable-5", ...NATIVE_BROWSER_FAMILIES] as const;

/** Return whether an Anthropic model ID supports the July 2026 native browser tool. */
export function supportsAnthropicNativeBrowser(modelId: string): boolean {
	return NATIVE_BROWSER_FAMILIES.some((family) => isFamilyMatch(modelId.toLowerCase(), family));
}

/** Return whether an Anthropic model ID supports the July 2026 native computer tool. */
export function supportsAnthropicNativeComputer(modelId: string): boolean {
	return NATIVE_COMPUTER_FAMILIES.some((family) => isFamilyMatch(modelId.toLowerCase(), family));
}
