import {
	type Context,
	type OpenAIResponsesOptions as PiOpenAIResponsesOptions,
	type SimpleStreamOptions,
	type StreamFunction,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import {
	stream as piStreamOpenAIResponses,
	streamSimple as piStreamSimpleOpenAIResponses,
} from "@earendil-works/pi-ai/api/openai-responses";
import { responseThreadingDelta, responseThreadingEnabled, type ResponseThreadingOptions } from "../common";

export const OPENAI_CUA_RESPONSES_API = "openai-cua-responses";

/** Stream options for the cua OpenAI Responses provider: pi-ai's options plus threading control. */
export interface OpenAIResponsesOptions extends PiOpenAIResponsesOptions, ResponseThreadingOptions {}

type OnPayload = NonNullable<StreamOptions["onPayload"]>;

/**
 * Prepare a request for pi-ai's builtin OpenAI Responses stream so it threads
 * `previous_response_id`. The public Responses API requires `store: true` to
 * chain, so the payload always stores; when a prior assistant `responseId`
 * exists, only the delta messages are sent with `previous_response_id` set.
 * Any caller `onPayload` runs on top of the threaded payload.
 */
export function threadRequest(
	context: Context,
	options: (ResponseThreadingOptions & { onPayload?: OnPayload }) | undefined,
): { context: Context; onPayload: OnPayload } {
	const delta = responseThreadingEnabled(options) ? responseThreadingDelta(context.messages, OPENAI_CUA_RESPONSES_API) : undefined;
	const previousResponseId = delta?.previousResponseId;
	const messages = previousResponseId && delta ? delta.deltaMessages : context.messages;
	const onPayload: OnPayload = async (payload, model) => {
		const threaded = {
			...(payload as Record<string, unknown>),
			store: true,
			...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
		};
		return options?.onPayload ? ((await options.onPayload(threaded, model)) ?? threaded) : threaded;
	};
	return { context: messages === context.messages ? context : { ...context, messages }, onPayload };
}

// pi-ai's builtin stream fns are typed to the "openai-responses" api; we reuse them under our routed api, hence `as never` on the model.
export const streamOpenAIResponses: StreamFunction<typeof OPENAI_CUA_RESPONSES_API, OpenAIResponsesOptions> = (model, context, options) => {
	const threaded = threadRequest(context, options);
	return piStreamOpenAIResponses(model as never, threaded.context, { ...options, onPayload: threaded.onPayload });
};

export const streamSimpleOpenAIResponses: StreamFunction<typeof OPENAI_CUA_RESPONSES_API, SimpleStreamOptions> = (model, context, options) => {
	const threaded = threadRequest(context, options);
	return piStreamSimpleOpenAIResponses(model as never, threaded.context, { ...options, onPayload: threaded.onPayload });
};
