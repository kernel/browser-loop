import {
	createProvider,
	envApiKeyAuth,
	type Api,
	type Context,
	type CreateModelsOptions,
	type Model,
	type MutableModels,
	type Provider,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { cuaApiKeyEnvVarsForProvider } from "./api-keys";
import { cuaOverrideModels } from "./models";
import { OPENAI_CUA_RESPONSES_API, streamOpenAIResponses, streamSimpleOpenAIResponses } from "./providers/openai/provider";
import { streamSimpleTzafonResponses, streamTzafonResponses, TZAFON_RESPONSES_API } from "./providers/tzafon/provider";
import { streamSimpleYutori, streamYutori, YUTORI_CHAT_COMPLETIONS_API } from "./providers/yutori/provider";

/**
 * Build the pi `Models` collection CUA streams through: pi's builtin
 * providers, adjusted for CUA:
 *
 * - `openai` intercepts the `openai-cua-responses` api that
 *   {@link getCuaModel} routes OpenAI models to, threading
 *   `previous_response_id`; every other api falls through to pi's builtin
 *   provider.
 * - `google` resolves its API key from `GOOGLE_API_KEY` or `GEMINI_API_KEY`
 *   (pi's builtin only reads `GEMINI_API_KEY`).
 * - `tzafon` and `yutori` are CUA-only providers pi does not ship.
 *
 * Each call returns an independent collection; register additional providers
 * or credentials on it freely. Use {@link cuaModels} for the shared default.
 */
export function createCuaModels(options?: CreateModelsOptions): MutableModels {
	const models = builtinModels(options);
	const openai = models.getProvider("openai");
	if (openai) models.setProvider(withOpenAICuaResponses(openai));
	const google = models.getProvider("google");
	if (google) models.setProvider(withGoogleEnvKeys(google));
	models.setProvider(tzafonProvider());
	models.setProvider(yutoriProvider());
	return models;
}

let defaultCuaModels: MutableModels | undefined;

/**
 * Shared default {@link createCuaModels} collection, created on first use.
 *
 * `CuaAgent` and `CuaAgentHarness` stream through this instance unless given
 * another one. Auth resolves from the documented CUA env-var convention (see
 * `cuaApiKeyEnvVarsForProvider`); pass an explicit `options.apiKey` per
 * request to override.
 */
export function cuaModels(): MutableModels {
	return (defaultCuaModels ??= createCuaModels());
}

// pi's builtin openai provider only streams its own api ids. CUA routes
// OpenAI models to OPENAI_CUA_RESPONSES_API (see routeCuaApi), so the
// registered provider must dispatch that api to cua's threading stream fns.
function withOpenAICuaResponses(base: Provider): Provider {
	return {
		...base,
		stream: (model: Model<Api>, context: Context, options?: StreamOptions) =>
			model.api === OPENAI_CUA_RESPONSES_API
				? streamOpenAIResponses(model as never, context, options)
				: base.stream(model, context, options),
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			model.api === OPENAI_CUA_RESPONSES_API
				? streamSimpleOpenAIResponses(model as never, context, options)
				: base.streamSimple(model, context, options),
	};
}

function withGoogleEnvKeys(base: Provider): Provider {
	return { ...base, auth: { ...base.auth, apiKey: envApiKeyAuth("Google API key", cuaApiKeyEnvVarsForProvider("google")) } };
}

function tzafonProvider(): Provider {
	return createProvider({
		id: "tzafon",
		name: "Tzafon",
		baseUrl: "https://api.lightcone.ai",
		auth: { apiKey: envApiKeyAuth("Tzafon API key", cuaApiKeyEnvVarsForProvider("tzafon")) },
		models: cuaOverrideModels("tzafon"),
		api: { stream: streamTzafonResponses, streamSimple: streamSimpleTzafonResponses },
	});
}

function yutoriProvider(): Provider {
	return createProvider({
		id: "yutori",
		name: "Yutori",
		baseUrl: "https://api.yutori.com/v1",
		auth: { apiKey: envApiKeyAuth("Yutori API key", cuaApiKeyEnvVarsForProvider("yutori")) },
		models: cuaOverrideModels("yutori"),
		api: { stream: streamYutori, streamSimple: streamSimpleYutori },
	});
}

export { OPENAI_CUA_RESPONSES_API, streamOpenAIResponses, streamSimpleOpenAIResponses };
export { TZAFON_RESPONSES_API, streamSimpleTzafonResponses, streamTzafonResponses };
export { YUTORI_CHAT_COMPLETIONS_API, streamSimpleYutori, streamYutori };
