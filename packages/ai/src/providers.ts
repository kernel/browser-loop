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
import { withAnthropicBrowserFallback } from "./providers/anthropic/browser-fallback";
import { GOOGLE_CUA_INTERACTIONS_API, streamGoogleInteractions, streamSimpleGoogleInteractions } from "./providers/google/provider";
import { META_RESPONSES_API, streamMetaResponses, streamSimpleMetaResponses } from "./providers/meta/provider";
import { OPENAI_CUA_RESPONSES_API, streamOpenAIResponses, streamSimpleOpenAIResponses } from "./providers/openai/provider";
import { streamSimpleTzafonResponses, streamTzafonResponses, TZAFON_RESPONSES_API } from "./providers/tzafon/provider";
import { streamSimpleXaiResponses, streamXaiResponses, XAI_CUA_RESPONSES_API } from "./providers/xai/provider";
import { streamSimpleYutori, streamYutori, YUTORI_CHAT_COMPLETIONS_API } from "./providers/yutori/provider";

/**
 * Build the pi `Models` collection CUA streams through: pi's builtin
 * providers, adjusted for CUA:
 *
 * - `anthropic` retries an inaccessible native browser beta through the
 *   selected tool's equivalent function declaration.
 * - `openai` intercepts the `openai-cua-responses` api that
 *   {@link getCuaModel} routes OpenAI models to, threading
 *   `previous_response_id`; every other api falls through to pi's builtin
 *   provider.
 * - `google` intercepts `google-cua-interactions` for current native computer
 *   use and resolves API keys from `GOOGLE_API_KEY` or `GEMINI_API_KEY`.
 * - `xai` intercepts `xai-cua-responses` so Grok can use stateful Responses
 *   tool loops while preserving pi's builtin xAI auth and catalog.
 * - `moonshotai` is pi's builtin provider untouched: Kimi streams through the
 *   plain OpenAI-compatible chat completions transport with `MOONSHOT_API_KEY`.
 * - `meta`, `tzafon`, and `yutori` are CUA-only providers pi does not ship.
 *
 * Each call returns an independent collection; register additional providers
 * or credentials on it freely. Use {@link cuaModels} for the shared default.
 */
export function createCuaModels(options?: CreateModelsOptions): MutableModels {
	const models = builtinModels(options);
	const anthropic = models.getProvider("anthropic");
	if (anthropic) models.setProvider(withAnthropicBrowserFallback(anthropic));
	const openai = models.getProvider("openai");
	if (openai) models.setProvider(withOpenAICuaResponses(openai));
	const google = models.getProvider("google");
	if (google) models.setProvider(withGoogleCuaInteractions(google));
	const xai = models.getProvider("xai");
	if (xai) models.setProvider(withXaiCuaResponses(xai));
	models.setProvider(metaProvider());
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

function withGoogleCuaInteractions(base: Provider): Provider {
	return {
		...base,
		auth: { ...base.auth, apiKey: envApiKeyAuth("Google API key", cuaApiKeyEnvVarsForProvider("google")) },
		stream: (model: Model<Api>, context: Context, options?: StreamOptions) =>
			model.api === GOOGLE_CUA_INTERACTIONS_API
				? streamGoogleInteractions(model as never, context, options)
				: base.stream(model, context, options),
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			model.api === GOOGLE_CUA_INTERACTIONS_API
				? streamSimpleGoogleInteractions(model as never, context, options)
				: base.streamSimple(model, context, options),
	};
}

function withXaiCuaResponses(base: Provider): Provider {
	return {
		...base,
		stream: (model: Model<Api>, context: Context, options?: StreamOptions) =>
			model.api === XAI_CUA_RESPONSES_API
				? streamXaiResponses(model as never, context, options)
				: base.stream(model, context, options),
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			model.api === XAI_CUA_RESPONSES_API
				? streamSimpleXaiResponses(model as never, context, options)
				: base.streamSimple(model, context, options),
	};
}

function metaProvider(): Provider {
	return createProvider({
		id: "meta",
		name: "Meta",
		baseUrl: "https://api.meta.ai/v1",
		auth: { apiKey: envApiKeyAuth("Meta Model API key", cuaApiKeyEnvVarsForProvider("meta")) },
		models: cuaOverrideModels("meta"),
		api: { stream: streamMetaResponses, streamSimple: streamSimpleMetaResponses },
	});
}

function tzafonProvider(): Provider {
	return createProvider({
		id: "tzafon",
		name: "Tzafon",
		baseUrl: "https://api.tzafon.ai",
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

export { GOOGLE_CUA_INTERACTIONS_API, streamGoogleInteractions, streamSimpleGoogleInteractions };
export { META_RESPONSES_API, streamMetaResponses, streamSimpleMetaResponses };
export { OPENAI_CUA_RESPONSES_API, streamOpenAIResponses, streamSimpleOpenAIResponses };
export { TZAFON_RESPONSES_API, streamSimpleTzafonResponses, streamTzafonResponses };
export { XAI_CUA_RESPONSES_API, streamSimpleXaiResponses, streamXaiResponses };
export { YUTORI_CHAT_COMPLETIONS_API, streamSimpleYutori, streamYutori };
