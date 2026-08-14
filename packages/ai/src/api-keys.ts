import type { Api, Model } from "@earendil-works/pi-ai";
import { parseCuaModelRef, providerForModel, type CuaModelRef } from "./models";

/**
 * Environment variables for the providers CUA documents, in precedence order.
 *
 * Every provider pi-ai carries is selectable, and pi resolves each one's own
 * credential when streaming. This table exists only so callers and the CLI can
 * name the variable to set up front; a provider absent from it is not
 * unsupported, it just has no CUA-side preflight. pi-ai does not export its
 * own env-var registry, or this would read from that.
 */
const CUA_PROVIDER_API_KEY_ENV_VARS: Readonly<Record<string, readonly string[]>> = {
	openai: ["OPENAI_API_KEY"],
	anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
	google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
	xai: ["XAI_API_KEY"],
	moonshotai: ["MOONSHOT_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
};

/** Provider prefixes accepted as aliases for a pi-ai provider id. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = { gemini: "google", moonshot: "moonshotai" };

/**
 * List the environment variables checked for a provider's API key, in
 * precedence order. Returns an empty list for a provider CUA does not document,
 * whose credential pi resolves at request time instead.
 */
export function cuaApiKeyEnvVarsForProvider(provider: string): readonly string[] {
	return CUA_PROVIDER_API_KEY_ENV_VARS[PROVIDER_ALIASES[provider] ?? provider] ?? [];
}

/** Read a provider's API key from the environment, or return undefined when unset. */
export function getCuaEnvApiKey(provider: string): string | undefined {
	for (const envVar of cuaApiKeyEnvVarsForProvider(provider)) {
		const value = process.env[envVar];
		if (value?.trim()) return value;
	}
	return undefined;
}

/**
 * Read a provider's API key from the environment, or throw naming the variables
 * to set. Throws for a provider CUA documents no variables for — callers that
 * accept any pi-ai provider should use {@link cuaApiKeyEnvVarsForProvider} to
 * decide whether a preflight is possible at all.
 */
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
