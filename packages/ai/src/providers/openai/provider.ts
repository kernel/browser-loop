import {
	type Context,
	type OpenAIResponsesOptions as PiOpenAIResponsesOptions,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import {
	stream as piStreamOpenAIResponses,
	streamSimple as piStreamSimpleOpenAIResponses,
} from "@earendil-works/pi-ai/api/openai-responses";
import {
	type CuaSimpleStreamOptions,
	type ResponsesThreadingOptions,
	threadResponsesRequest,
} from "../common";

export const OPENAI_CUA_RESPONSES_API = "openai-cua-responses";

/** Stream options for the cua OpenAI Responses provider: pi-ai's options plus threading control. */
export interface OpenAIResponsesOptions extends PiOpenAIResponsesOptions, ResponsesThreadingOptions {}

/** Prepare a request for the OpenAI Responses transport with stored response state. */
export function threadRequest(context: Context, options: ResponsesThreadingOptions | undefined) {
	const { context: threadedContext, onPayload } = threadResponsesRequest(context, OPENAI_CUA_RESPONSES_API, options);
	return { context: threadedContext, onPayload };
}

// pi-ai's builtin stream fns are typed to the "openai-responses" api; we reuse them under our routed api, hence `as never` on the model.
export const streamOpenAIResponses: StreamFunction<typeof OPENAI_CUA_RESPONSES_API, OpenAIResponsesOptions> = (model, context, options) => {
	const threaded = threadRequest(context, options);
	return piStreamOpenAIResponses(model as never, threaded.context, { ...options, onPayload: threaded.onPayload });
};

export const streamSimpleOpenAIResponses: StreamFunction<typeof OPENAI_CUA_RESPONSES_API, CuaSimpleStreamOptions> = (model, context, options) => {
	const threaded = threadRequest(context, options);
	return piStreamSimpleOpenAIResponses(model as never, threaded.context, { ...options, onPayload: threaded.onPayload });
};
