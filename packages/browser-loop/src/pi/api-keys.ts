import type { Api, Model } from "@earendil-works/pi-ai";
import { parseLoopModelRef, providerForModel, type LoopModelRef } from "./models";

/**
 * Environment variables for the providers Loop documents, in precedence order.
 *
 * Every provider pi-ai carries is selectable, and pi resolves each one's own
 * credential when streaming. This table exists only so callers can name the
 * variable to set up front; a provider absent from it is not
 * unsupported, it just has no Loop-side preflight. pi-ai does not export its
 * own env-var registry, or this would read from that.
 */
const LOOP_PROVIDER_API_KEY_ENV_VARS: Readonly<Record<string, readonly string[]>> = {
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
 * precedence order. Returns an empty list for a provider Loop does not document,
 * whose credential pi resolves at request time instead.
 */
export function loopApiKeyEnvVarsForProvider(provider: string): readonly string[] {
	return LOOP_PROVIDER_API_KEY_ENV_VARS[PROVIDER_ALIASES[provider] ?? provider] ?? [];
}

/** Read a provider's API key from the environment, or return undefined when unset. */
export function getLoopEnvApiKey(provider: string): string | undefined {
	for (const envVar of loopApiKeyEnvVarsForProvider(provider)) {
		const value = process.env[envVar];
		if (value?.trim()) return value;
	}
	return undefined;
}

/**
 * Read a provider's API key from the environment, or throw naming the variables
 * to set. Throws for a provider Loop documents no variables for — callers that
 * accept any pi-ai provider should use {@link loopApiKeyEnvVarsForProvider} to
 * decide whether a preflight is possible at all.
 */
export function requireLoopEnvApiKey(provider: string): string {
	const apiKey = getLoopEnvApiKey(provider);
	if (apiKey) return apiKey;
	const envVars = loopApiKeyEnvVarsForProvider(provider);
	if (envVars.length === 0) {
		throw new Error(`No known API key environment variables for provider "${provider}"`);
	}
	throw new Error(`Missing API key for "${provider}". Set one of: ${envVars.join(", ")}`);
}

/** {@link getLoopEnvApiKey} keyed by a model ref or concrete model instead of a provider name. */
export function getLoopEnvApiKeyForModel(input: LoopModelRef | Model<Api>): string | undefined {
	const provider = typeof input === "string" ? parseLoopModelRef(input).provider : providerForModel(input);
	return getLoopEnvApiKey(provider);
}

/** {@link requireLoopEnvApiKey} keyed by a model ref or concrete model instead of a provider name. */
export function requireLoopEnvApiKeyForModel(input: LoopModelRef | Model<Api>): string {
	const provider = typeof input === "string" ? parseLoopModelRef(input).provider : providerForModel(input);
	return requireLoopEnvApiKey(provider);
}
