import type { Api, Model } from "@earendil-works/pi-ai";
import { parseCuaModelRef, providerForModel, type CuaModelRef, type CuaProvider } from "./models";

/**
 * Environment variables accepted for each CUA provider.
 *
 * This mirrors pi-ai's approach: model lookup is pure, while auth is resolved
 * when streaming. These helpers let callers share one readable convention for
 * explicit `getApiKey` wiring (especially useful for `google` vs `gemini`).
 */
const CUA_PROVIDER_API_KEY_ENV_VARS: Record<CuaProvider, readonly string[]> = {
	openai: ["OPENAI_API_KEY"],
	anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
	google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
	meta: ["META_API_KEY"],
	xai: ["XAI_API_KEY"],
	moonshotai: ["MOONSHOT_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
};

/**
 * List the environment variables checked for a provider's API key, in
 * precedence order. Accepts `"gemini"` as an alias for `"google"` and
 * `"moonshot"` as an alias for `"moonshotai"`; returns an empty list for
 * unknown providers.
 */
export function cuaApiKeyEnvVarsForProvider(provider: string): readonly string[] {
	if (provider === "gemini") {
		return CUA_PROVIDER_API_KEY_ENV_VARS.google;
	}
	if (provider === "moonshot") {
		return CUA_PROVIDER_API_KEY_ENV_VARS.moonshotai;
	}
	return CUA_PROVIDER_API_KEY_ENV_VARS[provider as keyof typeof CUA_PROVIDER_API_KEY_ENV_VARS] ?? [];
}

/** Read a provider's API key from the environment, or return undefined when unset. */
export function getCuaEnvApiKey(provider: string): string | undefined {
	for (const envVar of cuaApiKeyEnvVarsForProvider(provider)) {
		const value = process.env[envVar];
		if (value?.trim()) return value;
	}
	return undefined;
}

/** Read a provider's API key from the environment, or throw naming the variables to set. */
export function requireCuaEnvApiKey(provider: string): string {
	const apiKey = getCuaEnvApiKey(provider);
	if (apiKey) return apiKey;
	const envVars = cuaApiKeyEnvVarsForProvider(provider);
	if (envVars.length === 0) {
		throw new Error(`No known API key environment variables for provider "${provider}"`);
	}
	throw new Error(`Missing API key for "${provider}". Set one of: ${envVars.join(", ")}`);
}

/** {@link getCuaEnvApiKey} keyed by a model ref or concrete model instead of a provider name. */
export function getCuaEnvApiKeyForModel(input: CuaModelRef | Model<Api>): string | undefined {
	const provider = typeof input === "string" ? parseCuaModelRef(input).provider : providerForModel(input);
	return getCuaEnvApiKey(provider);
}

/** {@link requireCuaEnvApiKey} keyed by a model ref or concrete model instead of a provider name. */
export function requireCuaEnvApiKeyForModel(input: CuaModelRef | Model<Api>): string {
	const provider = typeof input === "string" ? parseCuaModelRef(input).provider : providerForModel(input);
	return requireCuaEnvApiKey(provider);
}
