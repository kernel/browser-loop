import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	isRetryableAssistantError,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type Models,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const MAX_ATTEMPTS = 4;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type RetryStreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export function withProviderRetry(streamFn: StreamFn): RetryStreamFn {
	return (model, context, options) => {
		const output = createAssistantMessageEventStream();
		void (async () => {
			for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
				if (options?.signal?.aborted) {
					replayAborted(output, model);
					return;
				}

				const input = await streamFn(model, context, options);
				const events: AssistantMessageEvent[] = [];
				for await (const event of input) events.push(structuredClone(event));
				const terminal = events.at(-1);
				const message = terminalMessage(terminal);
				if (
					!message ||
					message.stopReason !== "error" ||
					!isRetryableAssistantError(message) ||
					attempt === MAX_ATTEMPTS - 1
				) {
					replay(output, events, message);
					return;
				}

				const providerDelay = parseProviderDelay(message.errorMessage);
				const cap = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
				if (providerDelay !== undefined && cap > 0 && providerDelay > cap) {
					replay(output, events, message);
					return;
				}
				const delay = Math.max(2_000 * 2 ** attempt, providerDelay ?? 0);
				if (!(await wait(delay, options?.signal))) {
					replayAborted(output, model);
					return;
				}
			}
		})();
		return output;
	};
}

export function withProviderRetryModels(models: Models): Models {
	const streamSimple = withProviderRetry((model, context, options) => models.streamSimple(model, context, options));
	return {
		getProviders: () => models.getProviders(),
		getProvider: (id) => models.getProvider(id),
		getModels: (provider) => models.getModels(provider),
		getModel: (provider, id) => models.getModel(provider, id),
		refresh: (provider) => models.refresh(provider),
		getAuth: (model) => models.getAuth(model),
		// AgentHarness uses the simple paths; generic API dispatch remains untouched.
		stream: (model, context, options) => models.stream(model, context, options),
		complete: (model, context, options) => models.complete(model, context, options),
		streamSimple,
		completeSimple: (model, context, options) => streamSimple(model, context, options).result(),
	};
}

function terminalMessage(event: AssistantMessageEvent | undefined): AssistantMessage | undefined {
	if (event?.type === "done") return event.message;
	if (event?.type === "error") return event.error;
	return undefined;
}

function replay(
	output: ReturnType<typeof createAssistantMessageEventStream>,
	events: AssistantMessageEvent[],
	message: AssistantMessage | undefined,
): void {
	for (const event of events) output.push(event);
	if (message) output.end(message);
	else output.end();
}

function replayAborted(output: ReturnType<typeof createAssistantMessageEventStream>, model: Model<Api>): void {
	const message: AssistantMessage = {
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
		stopReason: "aborted",
		errorMessage: "Request aborted",
		timestamp: Date.now(),
	};
	output.push({ type: "start", partial: structuredClone(message) });
	output.push({ type: "error", reason: "aborted", error: message });
	output.end(message);
}

function parseProviderDelay(message: string | undefined): number | undefined {
	if (!message) return undefined;
	const match = /(?:retry\s+in|retry\s+delay(?:\s+of|\s*:)?)[\s:]*(-?(?:\d+(?:\.\d*)?|\.\d+|infinity))\s*(ms|s)\b/i.exec(
		message,
	);
	if (!match) return undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value < 0) return undefined;
	const delay = value * (match[2].toLowerCase() === "s" ? 1_000 : 1);
	return Number.isFinite(delay) ? delay : undefined;
}

async function wait(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
	let remaining = delayMs;
	while (remaining > 0) {
		const chunk = Math.min(remaining, MAX_TIMER_DELAY_MS);
		if (!(await waitChunk(chunk, signal))) return false;
		remaining -= chunk;
	}
	return !signal?.aborted;
}

function waitChunk(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
