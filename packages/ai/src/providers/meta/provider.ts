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

export const META_RESPONSES_API = "meta-responses";

/** Stream options for Meta's OpenAI-compatible Responses API. */
export interface MetaResponsesOptions extends PiOpenAIResponsesOptions, ResponsesThreadingOptions {}

/** Apply Meta's computer-use payload constraints on top of shared Responses threading. */
export function threadMetaRequest(context: Context, options: ResponsesThreadingOptions | undefined) {
	const callerOnPayload = options?.onPayload;
	const threaded = threadResponsesRequest(context, META_RESPONSES_API, {
		...options,
		onPayload: async (payload, model) => {
			const constrained: Record<string, unknown> = { ...(payload as Record<string, unknown>), parallel_tool_calls: false };
			delete constrained.include;
			return callerOnPayload ? ((await callerOnPayload(constrained, model)) ?? constrained) : constrained;
		},
	});
	const onPayload: typeof threaded.onPayload = async (payload, model) => {
		const prepared = await threaded.onPayload(payload, model);
		const sanitized = { ...(prepared as Record<string, unknown>) };
		// CUA uses stored response state instead of stateless encrypted reasoning replay.
		delete sanitized.include;
		return sanitized;
	};
	return { context: threaded.context, onPayload };
}

// Meta implements the OpenAI Responses wire protocol. The model carries a
// distinct api id so response ids can never be threaded across providers.
export const streamMetaResponses: StreamFunction<typeof META_RESPONSES_API, MetaResponsesOptions> = (model, context, options) => {
	const threaded = threadMetaRequest(context, options);
	return piStreamOpenAIResponses(model as never, threaded.context, { ...options, onPayload: threaded.onPayload });
};

export const streamSimpleMetaResponses: StreamFunction<typeof META_RESPONSES_API, CuaSimpleStreamOptions> = (model, context, options) => {
	const threaded = threadMetaRequest(context, options);
	return piStreamSimpleOpenAIResponses(model as never, threaded.context, { ...options, onPayload: threaded.onPayload });
};
