import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Model,
	type Models,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	resolveProviderRetryPolicy,
	withProviderRetry,
	withProviderRetryModels,
} from "../src/provider-retry";

const model = {
	id: "test",
	provider: "google",
	api: "google-generative-ai",
	contextWindow: 128_000,
} as Model<Api>;
const context = { messages: [] };

const enabled = resolveProviderRetryPolicy({ enabled: true });

afterEach(() => vi.useRealTimers());

describe("provider retry policy", () => {
	it("is disabled by default and preserves stream and Models identity", () => {
		const streamFn = (() => textStream("ok")) as StreamFn;
		const models = {} as Models;
		expect(withProviderRetry(streamFn, resolveProviderRetryPolicy())).toBe(streamFn);
		expect(withProviderRetry(streamFn, resolveProviderRetryPolicy({ enabled: false }))).toBe(streamFn);
		expect(withProviderRetry(streamFn, resolveProviderRetryPolicy({ enabled: true, maxRetries: 0 }))).toBe(streamFn);
		expect(withProviderRetryModels(models, resolveProviderRetryPolicy())).toBe(models);
		expect(withProviderRetryModels(models, resolveProviderRetryPolicy({ enabled: true, maxRetries: 0 }))).toBe(models);
	});

	it("validates public policy values and the largest timer delay", () => {
		for (const retry of [
			{ enabled: "yes" },
			{ maxRetries: -1 },
			{ maxRetries: 1.5 },
			{ maxRetries: Number.MAX_SAFE_INTEGER + 1 },
			{ baseDelayMs: -1 },
			{ baseDelayMs: Number.NaN },
			{ baseDelayMs: Number.POSITIVE_INFINITY },
			{ enabled: true, maxRetries: 2, baseDelayMs: 2_147_483_647 },
		]) {
			expect(() => resolveProviderRetryPolicy(retry as never)).toThrow();
		}
		expect(() => resolveProviderRetryPolicy({ enabled: true, maxRetries: 0, baseDelayMs: Infinity })).toThrow();
		expect(resolveProviderRetryPolicy({ enabled: true, maxRetries: 100, baseDelayMs: 0 })).toMatchObject({
			enabled: true,
			maxRetries: 100,
			baseDelayMs: 0,
		});
	});

	it("uses three retries with 2s/4s/8s defaults", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const retrying = withProviderRetry((() => {
			calls += 1;
			return errorStream("HTTP 429: rate limited");
		}) as StreamFn, enabled);
		const result = retrying(model, context).result();

		for (const [delay, expectedCalls] of [[2_000, 2], [4_000, 3], [8_000, 4]] as const) {
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(calls).toBe(expectedCalls - 1);
			await vi.advanceTimersByTimeAsync(1);
			expect(calls).toBe(expectedCalls);
		}
		expect((await result).stopReason).toBe("error");
	});

	it("uses custom retry count and delay without interpreting provider options", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const options = { maxRetries: 9, maxRetryDelayMs: 1 } satisfies SimpleStreamOptions;
		const retrying = withProviderRetry(((_model, _context, received) => {
			expect(received).toBe(options);
			calls += 1;
			return errorStream("HTTP 429: retry in 30s");
		}) as StreamFn, resolveProviderRetryPolicy({ enabled: true, maxRetries: 1, baseDelayMs: 25 }));
		const result = retrying(model, context, options).result();
		await vi.advanceTimersByTimeAsync(24);
		expect(calls).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect((await result).stopReason).toBe("error");
		expect(calls).toBe(2);
	});
});

describe("provider retry behavior", () => {
	it("discards a failed attempt and replays one accepted snapshot sequence", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const retrying = withProviderRetry((() => {
			calls += 1;
			return calls === 1 ? errorStream("HTTP 429", "discarded") : mutableTextStream();
		}) as StreamFn, enabled);
		const eventsPromise = collect(retrying(model, context));
		await vi.advanceTimersByTimeAsync(2_000);
		await vi.runAllTimersAsync();
		const events = await eventsPromise;

		expect(JSON.stringify(events)).not.toContain("discarded");
		expect(events.filter((event) => event.type === "text_delta").map((event) => event.partial.content)).toEqual([
			[{ type: "text", text: "a" }],
			[{ type: "text", text: "ab" }],
		]);
		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
	});

	it.each([
		"invalid API key",
		"insufficient_quota: quota exceeded",
		"billing limit reached",
		"ordinary model error",
	])("does not retry non-transient failure %s", async (error) => {
		let calls = 0;
		const retrying = withProviderRetry((() => {
			calls += 1;
			return errorStream(error);
		}) as StreamFn, enabled);
		expect((await retrying(model, context).result()).stopReason).toBe("error");
		expect(calls).toBe(1);
	});

	it("excludes context overflow before transient classification", async () => {
		let calls = 0;
		const retrying = withProviderRetry((() => {
			calls += 1;
			return errorStream("500: input exceeds the context window");
		}) as StreamFn, enabled);
		await retrying(model, context).result();
		expect(calls).toBe(1);
	});

	it.each(["HTTP 429", "503 service unavailable", "network error", "request timed out"])(
		"retries classifier-accepted failure %s",
		async (error) => {
			vi.useFakeTimers();
			let calls = 0;
			const retrying = withProviderRetry((() => (++calls === 1 ? errorStream(error) : textStream("ok"))) as StreamFn, enabled);
			const result = retrying(model, context).result();
			await vi.advanceTimersByTimeAsync(2_000);
			expect((await result).stopReason).toBe("stop");
			expect(calls).toBe(2);
		},
	);

	it("normalizes retryable stream invocation and iteration failures", async () => {
		vi.useFakeTimers();
		let invocationCalls = 0;
		const invocation = withProviderRetry((() => {
			if (++invocationCalls === 1) throw new Error("network error");
			return textStream("ok");
		}) as StreamFn, enabled);
		const invocationResult = invocation(model, context).result();
		await vi.advanceTimersByTimeAsync(2_000);
		expect((await invocationResult).stopReason).toBe("stop");

		let rejectionCalls = 0;
		const rejection = withProviderRetry((async () => {
			if (++rejectionCalls === 1) throw new Error("fetch failed");
			return textStream("ok");
		}) as StreamFn, enabled);
		const rejectionResult = rejection(model, context).result();
		await vi.advanceTimersByTimeAsync(2_000);
		expect((await rejectionResult).stopReason).toBe("stop");

		let iterationCalls = 0;
		const iteration = withProviderRetry((() => {
			iterationCalls += 1;
			return iterationCalls === 1 ? throwingStream("socket hang up") : textStream("ok");
		}) as StreamFn, enabled);
		const iterationResult = iteration(model, context).result();
		await vi.advanceTimersByTimeAsync(2_000);
		expect((await iterationResult).stopReason).toBe("stop");
	});

	it("settles malformed and unsnapshotable streams without retrying", async () => {
		let calls = 0;
		const malformed = withProviderRetry((() => {
			calls += 1;
			return emptyStream();
		}) as StreamFn, enabled);
		const malformedEvents = await collect(malformed(model, context));
		expect(malformedEvents.at(-1)?.type).toBe("error");
		expect((await malformed(model, context).result()).errorMessage).toContain("without a terminal event");

		const unsnapshotable = withProviderRetry((() => {
			calls += 1;
			return uncloneableStream();
		}) as StreamFn, enabled);
		const stream = unsnapshotable(model, context);
		const [events, result] = await Promise.all([collect(stream), stream.result()]);
		expect(events.at(-1)?.type).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(calls).toBe(3);
	});

	it("aborts before the first request and during backoff", async () => {
		const alreadyAborted = new AbortController();
		alreadyAborted.abort();
		let calls = 0;
		const retrying = withProviderRetry((() => {
			calls += 1;
			return errorStream("HTTP 429");
		}) as StreamFn, enabled);
		const first = retrying(model, context, { signal: alreadyAborted.signal });
		const [firstEvents, firstResult] = await Promise.all([collect(first), first.result()]);
		expect(firstEvents.filter((event) => event.type === "error")).toHaveLength(1);
		expect(firstResult.stopReason).toBe("aborted");
		expect(calls).toBe(0);

		vi.useFakeTimers();
		const controller = new AbortController();
		const second = retrying(model, context, { signal: controller.signal });
		await vi.advanceTimersByTimeAsync(1);
		controller.abort();
		const [secondEvents, secondResult] = await Promise.all([collect(second), second.result()]);
		expect(secondEvents.filter((event) => event.type === "error")).toHaveLength(1);
		expect(secondResult.stopReason).toBe("aborted");
		expect(calls).toBe(1);
	});

	it("stops reading after the first terminal event", async () => {
		let nextCalls = 0;
		const retrying = withProviderRetry((() => terminalThenThrowStream(() => nextCalls++)) as StreamFn, enabled);
		const stream = retrying(model, context);
		const [events, result] = await Promise.all([collect(stream), stream.result()]);
		expect(result.stopReason).toBe("stop");
		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
		expect(nextCalls).toBe(1);
	});

	it("wraps only Models simple paths and preserves generic delegates", async () => {
		let simpleCalls = 0;
		let genericCalls = 0;
		const models = {
			streamSimple: () => (++simpleCalls === 1 ? errorStream("HTTP 429") : textStream("simple")),
			stream: () => {
				genericCalls += 1;
				return textStream("generic");
			},
			complete: async () => {
				genericCalls += 1;
				return assistant("stop");
			},
		} as Models;
		vi.useFakeTimers();
		const wrapped = withProviderRetryModels(models, enabled);
		const simpleResult = wrapped.completeSimple(model, context);
		await vi.advanceTimersByTimeAsync(2_000);
		expect((await simpleResult).content).toEqual([{ type: "text", text: "simple" }]);
		await wrapped.stream(model, context).result();
		await wrapped.complete(model, context);
		expect(simpleCalls).toBe(2);
		expect(genericCalls).toBe(2);
	});
});

function assistant(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
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
		stopReason,
		errorMessage,
		timestamp: 0,
	};
}

function errorStream(message: string, text?: string) {
	const stream = createAssistantMessageEventStream();
	const value = assistant("error", message);
	stream.push({ type: "start", partial: value });
	if (text) {
		value.content.push({ type: "text", text });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: value });
	}
	stream.push({ type: "error", reason: "error", error: value });
	return stream;
}

function textStream(text: string) {
	const stream = createAssistantMessageEventStream();
	const value = assistant("stop");
	stream.push({ type: "start", partial: value });
	value.content.push({ type: "text", text });
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: value });
	stream.push({ type: "done", reason: "stop", message: value });
	return stream;
}

function mutableTextStream() {
	const stream = createAssistantMessageEventStream();
	const value = assistant("stop");
	void (async () => {
		stream.push({ type: "start", partial: value });
		value.content.push({ type: "text", text: "a" });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "a", partial: value });
		await new Promise((resolve) => setTimeout(resolve, 0));
		value.content[0] = { type: "text", text: "ab" };
		stream.push({ type: "text_delta", contentIndex: 0, delta: "b", partial: value });
		stream.push({ type: "done", reason: "stop", message: value });
	})();
	return stream;
}

function emptyStream() {
	return {
		async *[Symbol.asyncIterator]() {},
	} as ReturnType<typeof createAssistantMessageEventStream>;
}

function throwingStream(message: string) {
	return {
		async *[Symbol.asyncIterator]() {
			throw new Error(message);
		},
	} as ReturnType<typeof createAssistantMessageEventStream>;
}

function uncloneableStream() {
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "start", partial: { ...assistant("stop"), uncloneable: () => {} } } as never;
		},
	} as ReturnType<typeof createAssistantMessageEventStream>;
}

function terminalThenThrowStream(onNext: () => void) {
	const value = assistant("stop");
	let index = 0;
	return {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					onNext();
					if (index++ === 0) return { done: false as const, value: { type: "done", reason: "stop", message: value } as const };
					throw new Error("must not read after terminal");
				},
			};
		},
	} as ReturnType<typeof createAssistantMessageEventStream>;
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}
