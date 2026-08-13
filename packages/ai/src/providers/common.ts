import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	StreamOptions,
} from "@earendil-works/pi-ai";
import type { CuaIncomingToolPlan } from "../tool-catalog";

/** Prefix a bare hostname/path before browser navigation. */
export function normalizeGotoUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const url = value.trim();
	if (!url) return undefined;
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

/** pi stream options plus CUA adapter request controls. */
export interface CuaSimpleStreamOptions extends SimpleStreamOptions, ResponseThreadingOptions {
	/** @internal Identity-addressed native call dispatch for custom providers. */
	cuaIncomingToolPlan?: CuaIncomingToolPlan;
}

/** Per-request control for Responses API continuation. */
export interface ResponseThreadingOptions {
	disableResponseThreading?: boolean;
}

type ResponsesOnPayload = NonNullable<StreamOptions["onPayload"]>;

export interface ResponsesThreadingOptions extends ResponseThreadingOptions {
	onPayload?: ResponsesOnPayload;
}

/** Prepare a Responses request using the latest valid stored response id. */
export function threadResponsesRequest(
	context: Context,
	api: Api,
	options: ResponsesThreadingOptions | undefined,
): { context: Context; onPayload: ResponsesOnPayload; previousResponseId?: string } {
	const delta = responseThreadingEnabled(options) ? responseThreadingDelta(context.messages, api) : undefined;
	const previousResponseId = delta?.previousResponseId;
	const messages = previousResponseId && delta ? delta.deltaMessages : context.messages;
	const onPayload: ResponsesOnPayload = async (payload, model) => {
		const threaded = {
			...(payload as Record<string, unknown>),
			store: true,
			...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
		};
		return options?.onPayload ? ((await options.onPayload(threaded, model)) ?? threaded) : threaded;
	};
	return { context: messages === context.messages ? context : { ...context, messages }, onPayload, previousResponseId };
}

export function responseThreadingEnabled(options?: ResponseThreadingOptions): boolean {
	return options?.disableResponseThreading !== true;
}

export interface ResponseThreadingDelta {
	previousResponseId?: string;
	deltaMessages: Message[];
}

/** Find the latest valid assistant response id and the messages after it. */
export function responseThreadingDelta(messages: readonly Message[], api: Api): ResponseThreadingDelta {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]!;
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		const failed = assistant.stopReason === "error" || assistant.stopReason === "aborted";
		const responseId = failed || assistant.api !== api ? undefined : assistant.responseId;
		return responseId
			? { previousResponseId: responseId, deltaMessages: messages.slice(index + 1) }
			: { deltaMessages: [...messages] };
	}
	return { deltaMessages: [...messages] };
}

export type CuaPayloadHook = (payload: unknown, model: Model<Api>) => unknown | Promise<unknown>;
