import type {
	Api,
	AssistantMessage,
	Message,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { LoopIncomingToolPlan } from "../../core/tool-catalog";

/** pi stream options plus Loop adapter request controls. */
export interface LoopSimpleStreamOptions extends SimpleStreamOptions, ResponseThreadingOptions {
	/** @internal Identity-addressed native call dispatch for custom providers. */
	loopIncomingToolPlan?: LoopIncomingToolPlan;
}

/** Per-request control for Responses API continuation. */
export interface ResponseThreadingOptions {
	disableResponseThreading?: boolean;
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

export type LoopPayloadHook = (payload: unknown, model: Model<Api>) => unknown | Promise<unknown>;
