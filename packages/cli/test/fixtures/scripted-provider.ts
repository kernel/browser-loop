import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	createCuaModels,
	type CuaSimpleStreamOptions,
	type Model,
	type MutableModels,
} from "@onkernel/cua-ai";

/** One scripted step replayed when the harness asks the provider for a turn. */
export type ScriptedStep =
	| { type: "text"; text: string; chunkSize?: number; chunkMs?: number }
	| { type: "tool_call"; toolName: string; args: Record<string, unknown>; id?: string }
	| { type: "wait_abort" }
	| { type: "error"; message: string };

export interface ScriptedTurn {
	steps: ScriptedStep[];
	/**
	 * Stop reason for the turn. Defaults to "stop" when there are no tool
	 * calls and to "toolUse" otherwise.
	 */
	stopReason?: "stop" | "toolUse" | "length";
}

export interface ScriptedProviderHandle {
	/** pi `Models` collection whose named provider replays the scripted turns. */
	models: MutableModels;
	/** Reset the turn cursor; the next provider call replays the first turn. */
	reset(): void;
	/** Number of provider calls dispatched so far. */
	callCount(): number;
	/** Latest context the provider was called with (assistant-side mock). */
	lastContext(): Context | undefined;
	/** Every provider context in dispatch order. */
	contexts(): readonly Context[];
	/** Latest stream options the provider was called with. */
	lastStreamOptions(): CuaSimpleStreamOptions | undefined;
}

/**
 * Build a CUA `Models` collection whose named provider is replaced with a
 * scripted double that replays one `ScriptedTurn` per provider call,
 * regardless of the model's api id. Pass `handle.models` to
 * `buildCuaHarness`; nothing global is mutated.
 */
export function createScriptedCuaModels(providerId: string, turns: ScriptedTurn[]): ScriptedProviderHandle {
	const state = {
		index: 0,
		lastContext: undefined as Context | undefined,
		contexts: [] as Context[],
		lastStreamOptions: undefined as CuaSimpleStreamOptions | undefined,
	};
	const dispatch = (model: Model<Api>, context: Context, options?: CuaSimpleStreamOptions) => {
		state.lastContext = context;
		state.contexts.push(context);
		state.lastStreamOptions = options;
		const turn = turns[state.index];
		state.index += 1;
		return buildStream(model, turn, options?.signal);
	};
	const models = createCuaModels();
	models.setProvider({
		id: providerId,
		name: `Scripted ${providerId}`,
		auth: { apiKey: { name: "scripted test key", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
		getModels: () => [],
		stream: (model, context, options) => dispatch(model, context, options),
		streamSimple: (model, context, options) => dispatch(model, context, options),
	});
	return {
		models,
		reset(): void {
			state.index = 0;
			state.lastContext = undefined;
			state.contexts = [];
			state.lastStreamOptions = undefined;
		},
		callCount(): number {
			return state.index;
		},
		lastContext(): Context | undefined {
			return state.lastContext;
		},
		contexts(): readonly Context[] {
			return state.contexts;
		},
		lastStreamOptions(): CuaSimpleStreamOptions | undefined {
			return state.lastStreamOptions;
		},
	};
}

function buildStream(model: Model<Api>, turn: ScriptedTurn | undefined, signal?: AbortSignal) {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const message = baseAssistantMessage(model);
		if (!turn) {
			message.stopReason = "stop";
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return;
		}

		stream.push({ type: "start", partial: message });

		let hasToolCall = false;
		let errorStep: { message: string } | undefined;
		let contentIndex = 0;
		let aborted = false;

		for (const step of turn.steps) {
			if (signal?.aborted) {
				aborted = true;
				break;
			}
			if (step.type === "text") {
				const chunkSize = Math.max(1, step.chunkSize ?? step.text.length);
				const chunkMs = step.chunkMs ?? 0;
				const aggregated = { text: "" };
				stream.push({ type: "text_start", contentIndex, partial: message });
				for (const chunk of chunkText(step.text, chunkSize)) {
					if (signal?.aborted) {
						aborted = true;
						break;
					}
					aggregated.text += chunk;
					// Append text to message progressively so the final assistant
					// message reflects the full streamed value when consumers
					// inspect partials.
					if (message.content[contentIndex]?.type === "text") {
						(message.content[contentIndex] as { text: string }).text = aggregated.text;
					} else {
						message.content.push({ type: "text", text: aggregated.text });
					}
					stream.push({ type: "text_delta", contentIndex, delta: chunk, partial: message });
					if (chunkMs > 0) await delay(chunkMs, signal);
				}
				if (!aborted) {
					stream.push({ type: "text_end", contentIndex, content: aggregated.text, partial: message });
					contentIndex += 1;
				}
			} else if (step.type === "tool_call") {
				hasToolCall = true;
				const id = step.id ?? `call_${contentIndex + 1}`;
				message.content.push({
					type: "toolCall",
					id,
					name: step.toolName,
					arguments: step.args,
				});
				stream.push({ type: "toolcall_start", contentIndex, partial: message });
				stream.push({
					type: "toolcall_end",
					contentIndex,
					toolCall: { id, name: step.toolName, arguments: step.args },
					partial: message,
				});
				contentIndex += 1;
			} else if (step.type === "wait_abort") {
				await waitForAbort(signal);
				aborted = true;
				break;
			} else if (step.type === "error") {
				errorStep = { message: step.message };
				break;
			}
		}

		if (errorStep) {
			message.stopReason = "error";
			message.errorMessage = errorStep.message;
			stream.push({ type: "error", reason: "error", error: message });
			stream.end(message);
			return;
		}

		if (aborted) {
			message.stopReason = "aborted";
			message.errorMessage = "aborted";
			stream.push({ type: "error", reason: "aborted", error: message });
			stream.end(message);
			return;
		}

		const stopReason = turn.stopReason ?? (hasToolCall ? "toolUse" : "stop");
		message.stopReason = stopReason;
		stream.push({ type: "done", reason: stopReason, message });
		stream.end(message);
	})();
	return stream;
}

function chunkText(text: string, chunkSize: number): string[] {
	const chunks: string[] = [];
	for (let index = 0; index < text.length; index += chunkSize) {
		chunks.push(text.slice(index, index + chunkSize));
	}
	return chunks.length > 0 ? chunks : [""];
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted || ms <= 0) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitForAbort(signal?: AbortSignal): Promise<void> {
	if (!signal) return;
	if (signal.aborted) return;
	await new Promise<void>((resolve) => {
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

function baseAssistantMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
