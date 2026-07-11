import {
	type Context,
	type OpenAIResponsesOptions as PiOpenAIResponsesOptions,
	type StreamFunction,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import {
	stream as piStreamOpenAIResponses,
	streamSimple as piStreamSimpleOpenAIResponses,
} from "@earendil-works/pi-ai/api/openai-responses";
import {
	type CuaSimpleStreamOptions,
	responseThreadingDelta,
	responseThreadingEnabled,
	type ResponseThreadingOptions,
} from "../common";

export const META_RESPONSES_API = "meta-responses";

/** Stream options for Meta's OpenAI-compatible Responses API. */
export interface MetaResponsesOptions extends PiOpenAIResponsesOptions, ResponseThreadingOptions {}

type OnPayload = NonNullable<StreamOptions["onPayload"]>;

/**
 * Prepare a Meta Responses request with server-managed conversation state.
 * Meta rejects reasoning.encrypted_content when previous_response_id is set,
 * so threaded turns remove that include while retaining reasoning server-side.
 */
export function threadMetaRequest(
	context: Context,
	options: (ResponseThreadingOptions & { onPayload?: OnPayload }) | undefined,
): { context: Context; onPayload: OnPayload } {
	const delta = responseThreadingEnabled(options) ? responseThreadingDelta(context.messages, META_RESPONSES_API) : undefined;
	const previousResponseId = delta?.previousResponseId;
	const messages = previousResponseId && delta ? delta.deltaMessages : context.messages;
	const onPayload: OnPayload = async (payload, model) => {
		const threaded = applyMetaPayloadDefaults(payload, previousResponseId);
		const transformed = options?.onPayload ? ((await options.onPayload(threaded, model)) ?? threaded) : threaded;
		return applyMetaPayloadDefaults(transformed, previousResponseId);
	};
	return { context: messages === context.messages ? context : { ...context, messages }, onPayload };
}

function applyMetaPayloadDefaults(payload: unknown, previousResponseId?: string): Record<string, unknown> {
	const next: Record<string, unknown> = {
		...(payload as Record<string, unknown>),
		store: true,
		parallel_tool_calls: false,
		...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
	};
	if (!previousResponseId || !Array.isArray(next.include)) return next;

	const include = next.include.filter((value: unknown) => value !== "reasoning.encrypted_content");
	if (include.length > 0) next.include = include;
	else delete next.include;
	return next;
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
