import {
	type CuaModelInfo,
	type CuaModelRef,
	type CuaProvider,
	formatCuaModelRef,
	getCuaModel,
	isCuaProvider,
	listCuaModels,
	parseCuaModelRef,
} from "@onkernel/cua-ai";

/** Default model used by the CLI harness. */
export const DEFAULT_CUA_MODEL_REF: CuaModelRef = "openai:gpt-5.6-sol";

/**
 * Resolve a model ref from CLI input. Accepts either a provider-qualified
 * `provider:model` ref or a bare model id when it matches exactly one
 * catalog entry. Throws when bare ids are ambiguous or unknown.
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
		const refs = matches.map((m) => m.ref).join(", ");
		throw new Error(`ambiguous model "${value}" (matches: ${refs}); pass a provider-qualified ref like "openai:${value}"`);
	}
	return matches[0]!.ref;
}

/**
 * List supported models, optionally filtered to a provider. Accepts the
 * canonical `"google"`/`"moonshotai"` ids or the CLI-friendly `"gemini"`/
 * `"moonshot"` aliases.
 */
export function listSupportedModels(provider?: string): CuaModelInfo[] {
	if (!provider) return listCuaModels();
	const normalized = provider === "gemini" ? "google" : provider === "moonshot" ? "moonshotai" : provider;
	if (!isCuaProvider(normalized)) {
		throw new Error(`unknown provider "${provider}"`);
	}
	return listCuaModels(normalized as CuaProvider);
}
