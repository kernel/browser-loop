import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Model,
	type Models,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withProviderRetry, withProviderRetryModels } from "../src/provider-retry";

const model = {
	id: "test",
	provider: "google",
	api: "google-generative-ai",
} as Model<Api>;
const context = { messages: [] };

afterEach(() => vi.useRealTimers());

describe("provider retry", () => {
	it("discards a retryable attempt and returns the successful retry", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const retrying = withProviderRetry(() => {
			calls += 1;
			return calls === 1 ? errorStream("HTTP 429: rate limited") : textStream("done");
		});

		const eventsPromise = collect(retrying(model, context));
		await vi.advanceTimersByTimeAsync(1_999);
		expect(calls).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		const events = await eventsPromise;

		expect(calls).toBe(2);
		expect(events.some((event) => event.type === "error")).toBe(false);
		expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta)).toEqual(["done"]);
	});

	it("uses exponential backoff and exposes the fourth error", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const retrying = withProviderRetry(() => {
			calls += 1;
			return errorStream("HTTP 429: rate limited");
		});
		const result = retrying(model, context).result();

		await vi.advanceTimersByTimeAsync(2_000);
		expect(calls).toBe(2);
		await vi.advanceTimersByTimeAsync(4_000);
		expect(calls).toBe(3);
		await vi.advanceTimersByTimeAsync(8_000);
		expect(calls).toBe(4);
		expect((await result).stopReason).toBe("error");
	});

	it.each([
		["Please retry in 10.5s", 10_500],
		["retry delay of 2500 ms", 2_500],
		["Retry Delay: 3 s", 3_000],
	])("honors provider delay %s", async (message, delay) => {
		vi.useFakeTimers();
		let calls = 0;
		const retrying = withProviderRetry(() => (++calls === 1 ? errorStream(`HTTP 429: ${message}`) : textStream("ok")));
		const result = retrying(model, context).result();
		await vi.advanceTimersByTimeAsync(delay - 1);
		expect(calls).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect((await result).stopReason).toBe("stop");
		expect(calls).toBe(2);
	});

	it.each([
		["HTTP 429: retry in 61s", undefined],
		["HTTP 429: retry in 10s", 5_000],
	])("does not retry a provider delay above the cap", async (message, maxRetryDelayMs) => {
		let calls = 0;
		const retrying = withProviderRetry(() => {
			calls += 1;
			return errorStream(message);
		});
		expect((await retrying(model, context, { maxRetryDelayMs }).result()).stopReason).toBe("error");
		expect(calls).toBe(1);
	});

	it.each(["retry in -3s", "retry delay: Infinity ms", "retry soon"])(
		"falls back to exponential delay for malformed hint %s",
		async (hint) => {
			vi.useFakeTimers();
			let calls = 0;
			const retrying = withProviderRetry(() => (++calls === 1 ? errorStream(`HTTP 429: ${hint}`) : textStream("ok")));
			const result = retrying(model, context).result();
			await vi.advanceTimersByTimeAsync(1_999);
			expect(calls).toBe(1);
			await vi.advanceTimersByTimeAsync(1);
			expect((await result).stopReason).toBe("stop");
		},
	);

	it("allows an uncapped provider delay when maxRetryDelayMs is zero", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const retrying = withProviderRetry(() => (++calls === 1 ? errorStream("HTTP 429: retry in 61s") : textStream("ok")));
		const result = retrying(model, context, { maxRetryDelayMs: 0 }).result();
		await vi.advanceTimersByTimeAsync(61_000);
		expect((await result).stopReason).toBe("stop");
		expect(calls).toBe(2);
	});

	it("waits the full uncapped delay when it exceeds the runtime timer limit", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const delay = 3_000_000_000;
		const retrying = withProviderRetry(() =>
			++calls === 1 ? errorStream(`HTTP 429: retry in ${delay}ms`) : textStream("ok"),
		);
		const result = retrying(model, context, { maxRetryDelayMs: 0 }).result();

		await vi.advanceTimersByTimeAsync(delay - 1);
		expect(calls).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect((await result).stopReason).toBe("stop");
		expect(calls).toBe(2);
	});

	it("does not retry non-retryable errors or aborted responses", async () => {
		for (const message of [errorMessage("invalid API key"), errorMessage("aborted", "aborted")]) {
			let calls = 0;
			const retrying = withProviderRetry(() => {
				calls += 1;
				return message;
			});
			await retrying(model, context).result();
			expect(calls).toBe(1);
		}
	});

	it("emits only an aborted logical attempt when aborted during backoff", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		let calls = 0;
		const retrying = withProviderRetry(() => {
			calls += 1;
			return errorStream("HTTP 429: retry in 10s", "discarded");
		});
		const eventsPromise = collect(retrying(model, context, { signal: controller.signal }));
		await vi.advanceTimersByTimeAsync(1);
		controller.abort();
		const events = await eventsPromise;

		expect(calls).toBe(1);
		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		expect(events.at(-1)?.type === "error" && events.at(-1).error.stopReason).toBe("aborted");
		expect(JSON.stringify(events)).not.toContain("discarded");
	});

	it("supports promise-returning streams and snapshots mutable partials", async () => {
		const retrying = withProviderRetry(async () => mutableTextStream());
		const events = await collect(retrying(model, context));
		const deltas = events.filter((event) => event.type === "text_delta");
		expect(deltas[0].partial.content).toEqual([{ type: "text", text: "a" }]);
		expect(deltas[1].partial.content).toEqual([{ type: "text", text: "ab" }]);
	});

	it("applies retries to Models.completeSimple", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const models = {
			streamSimple: () => (++calls === 1 ? errorStream("HTTP 429: rate limited") : textStream("done")),
		} as Models;
		const retryingModels = withProviderRetryModels(models);
		const completion = retryingModels.completeSimple(model, context);
		await vi.advanceTimersByTimeAsync(2_000);

		expect((await completion).content).toEqual([{ type: "text", text: "done" }]);
		expect(calls).toBe(2);
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

function errorMessage(message: string, reason: "error" | "aborted" = "error") {
	const stream = createAssistantMessageEventStream();
	const value = assistant(reason, message);
	stream.push({ type: "start", partial: value });
	stream.push({ type: "error", reason, error: value });
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

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}
