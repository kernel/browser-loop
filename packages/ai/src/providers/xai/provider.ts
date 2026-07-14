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

export const XAI_CUA_RESPONSES_API = "xai-cua-responses";

/**
 * Stream options for xAI's OpenAI-compatible Responses API.
 */
export interface XaiResponsesOptions extends PiOpenAIResponsesOptions, ResponsesThreadingOptions {}

/**
 * Apply xAI's serial computer-use constraints on top of shared Responses threading.
 */
export function threadXaiRequest(context: Context, options: ResponsesThreadingOptions | undefined) {
	const callerOnPayload = options?.onPayload;
	const threaded = threadResponsesRequest(context, XAI_CUA_RESPONSES_API, {
		...options,
		onPayload: async (payload, model) => {
			const constrained = { ...(payload as Record<string, unknown>), parallel_tool_calls: false };
			return callerOnPayload ? ((await callerOnPayload(constrained, model)) ?? constrained) : constrained;
		},
	});
	const onPayload: typeof threaded.onPayload = async (payload, model) => {
		const prepared = await threaded.onPayload(payload, model);
		const constrained: Record<string, unknown> = {
			...(prepared as Record<string, unknown>),
			store: true,
			parallel_tool_calls: false,
		};
		delete constrained.previous_response_id;
		if (threaded.previousResponseId) constrained.previous_response_id = threaded.previousResponseId;
		return constrained;
	};
	return { context: threaded.context, onPayload };
}

export const streamXaiResponses: StreamFunction<typeof XAI_CUA_RESPONSES_API, XaiResponsesOptions> = (model, context, options) => {
	const threaded = threadXaiRequest(context, options);
	return piStreamOpenAIResponses(model as never, threaded.context, { ...options, onPayload: threaded.onPayload });
};

export const streamSimpleXaiResponses: StreamFunction<typeof XAI_CUA_RESPONSES_API, CuaSimpleStreamOptions> = (model, context, options) => {
	const threaded = threadXaiRequest(context, options);
	return piStreamSimpleOpenAIResponses(model as never, threaded.context, { ...options, onPayload: threaded.onPayload });
};
