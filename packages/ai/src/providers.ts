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
import { withAnthropicBrowserFallback } from "./providers/anthropic/browser-fallback";
import { GOOGLE_CUA_INTERACTIONS_API, streamGoogleInteractions, streamSimpleGoogleInteractions } from "./providers/google/provider";
import { OPENAI_CUA_COMPUTER_API, requiresCuaOpenAINamespaceAdapter, streamOpenAICuaComputer, streamOpenAIResponses, streamSimpleOpenAIResponses } from "./providers/openai/provider";

/**
 * Build the pi `Models` collection CUA streams through: pi's builtin
 * providers, adjusted for CUA:
 *
 * - `anthropic` retries an inaccessible native browser beta through the
 *   selected tool's equivalent function declaration.
 * - `openai` streams through pi's builtin `openai-responses` transport and its
 *   automatic prompt caching by default; a model compiled with OpenAI's native
 *   computer tool carries `openai-cua-computer` instead, which this wrapper
 *   routes to the CUA adapter. The one dispatch that cannot be derived from
 *   `model.api` is a transcript carrying a deferred tool-search addition or a
 *   replayed function-call namespace (see {@link requiresCuaOpenAINamespaceAdapter}).
 * - `google` intercepts `google-cua-interactions` — carried only by a model
 *   compiled with Google's native computer-use toolset — for current native
 *   computer use, and resolves API keys from `GOOGLE_API_KEY` or `GEMINI_API_KEY`.
 *   A Google model compiled without that toolset streams through pi's builtin
 *   Google transport instead.
 * - `xai` is pi's builtin provider untouched: Grok streams through pi's
 *   Responses transport, and the catalog supplies its serial-tool-call field.
 * - `moonshotai` is pi's builtin provider untouched: Kimi streams through the
 *   plain OpenAI-compatible chat completions transport with `MOONSHOT_API_KEY`.
 * - `meta` is a CUA-only provider pi does not ship. It speaks the OpenAI
 *   Responses wire protocol, so it registers pi's builtin transport against
 *   Meta's base URL and credentials.
 *
 * Each call returns an independent collection; register additional providers
 * or credentials on it freely. Use {@link cuaModels} for the shared default.
 */
export function createCuaModels(options?: CreateModelsOptions): MutableModels {
	const models = builtinModels(options);
	const anthropic = models.getProvider("anthropic");
	if (anthropic) models.setProvider(withAnthropicBrowserFallback(anthropic));
	const openai = models.getProvider("openai");
	if (openai) models.setProvider(withOpenAICuaAdapter(openai));
	const google = models.getProvider("google");
	if (google) models.setProvider(withGoogleCuaInteractions(google));
	return models;
}

let defaultCuaModels: MutableModels | undefined;

/**
 * Shared default {@link createCuaModels} collection, created on first use.
 *
 * cua-agent streams through this instance unless given
 * another one. Auth resolves from the documented CUA env-var convention (see
 * `cuaApiKeyEnvVarsForProvider`); pass an explicit `options.apiKey` per
 * request to override.
 */
export function cuaModels(): MutableModels {
	return (defaultCuaModels ??= createCuaModels());
}

// The compiled catalog's model.api decides dispatch: OPENAI_CUA_COMPUTER_API
// routes to the CUA adapter, everything else falls through to pi's builtin
// "openai-responses" provider. requiresCuaOpenAINamespaceAdapter is the one
// exception that cannot be derived from the model — see its doc comment.
function withOpenAICuaAdapter(base: Provider): Provider {
	return {
		...base,
		stream: (model: Model<Api>, context: Context, options?: StreamOptions) =>
			model.api === OPENAI_CUA_COMPUTER_API
				? streamOpenAICuaComputer(model as never, context, options)
				: requiresCuaOpenAINamespaceAdapter(context)
					? streamOpenAIResponses(model as never, context, options)
					: base.stream(model, context, options),
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			model.api === OPENAI_CUA_COMPUTER_API
				? streamOpenAICuaComputer(model as never, context, options)
				: requiresCuaOpenAINamespaceAdapter(context)
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



export { GOOGLE_CUA_INTERACTIONS_API, streamGoogleInteractions, streamSimpleGoogleInteractions };
export { OPENAI_CUA_COMPUTER_API, streamOpenAIResponses, streamSimpleOpenAIResponses };
