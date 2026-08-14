import {
	type CuaModelInfo,
	type CuaModelRef,
	type CuaProvider,
	formatCuaModelRef,
	getCuaModel,
	cuaProviders,
	listCuaModels,
	parseCuaModelRef,
} from "@onkernel/cua-ai";

/** Default model used by the CLI harness. */
export const DEFAULT_CUA_MODEL_REF: CuaModelRef = "openai:gpt-5.6-sol";

/**
 * Providers preferred when a bare model id is carried by several of them, in
 * order. Gateways and aggregators resell the same ids as the provider that
 * trained the model, so `-m gpt-5.5` should mean OpenAI's.
 *
 * This is a disambiguation preference for bare ids only. It never decides
 * whether a model may run, and any provider is still reachable by passing a
 * qualified `provider:model` ref.
 */
const BARE_ID_PROVIDER_PREFERENCE: readonly string[] = ["openai", "anthropic", "google", "xai", "moonshotai", "openrouter"];

/**
 * Resolve a model ref from CLI input. Accepts a provider-qualified
 * `provider:model` ref, or a bare model id when exactly one provider carries it
 * or one of the preferred providers does. Throws when a bare id is unknown, or
 * ambiguous among providers none of which is preferred.
 */
export function resolveCuaModelRef(input: string | undefined): CuaModelRef {
	if (!input || !input.trim()) return DEFAULT_CUA_MODEL_REF;
	const value = input.trim();
	if (value.includes(":")) {
		const { provider, model } = parseCuaModelRef(value);
		const ref = formatCuaModelRef(provider, model);
		// Validate the ref resolves to a concrete model so failures surface early.
		getCuaModel(ref);
		return ref;
	}
	const matches = listCuaModels().filter((m) => m.model === value);
	if (matches.length === 0) {
		throw new Error(`unknown model "${value}" (run \`cua models\` to list supported -m/--model values)`);
	}
	if (matches.length > 1) {
		const preferred = BARE_ID_PROVIDER_PREFERENCE.map((provider) => matches.find((m) => m.provider === provider)).find(Boolean);
		if (preferred) return preferred.ref;
		const refs = matches.map((m) => m.ref).join(", ");
		throw new Error(`ambiguous model "${value}" (matches: ${refs}); pass a provider-qualified ref`);
	}
	return matches[0]!.ref;
}

/**
 * List selectable models, optionally filtered to a provider. Accepts any
 * provider pi-ai carries, plus the CLI-friendly `"gemini"`/`"moonshot"`
 * aliases.
 */
export function listSupportedModels(provider?: string): CuaModelInfo[] {
	if (!provider) return listCuaModels();
	const normalized = provider === "gemini" ? "google" : provider === "moonshot" ? "moonshotai" : provider;
	if (!cuaProviders().includes(normalized)) {
		throw new Error(`unknown provider "${provider}" (pi-ai carries: ${cuaProviders().join(", ")})`);
	}
	return listCuaModels(normalized);
}
