import { afterEach, describe, expect, it } from "vitest";
import type { Context, Message, Model } from "@earendil-works/pi-ai";
import { OPENAI_CUA_RESPONSES_API, threadRequest } from "../src/providers/openai/provider";

const TURNS = 6;
const model = {} as Model<typeof OPENAI_CUA_RESPONSES_API>;

/** Multi-turn context where each assistant turn carries a distinct responseId followed by a screenshot tool result. */
function multiTurnContext(): Context {
	const messages: Message[] = [{ role: "user", content: "book a flight", timestamp: 0 }];
	for (let turn = 0; turn < TURNS; turn += 1) {
		messages.push({
			role: "assistant",
			content: [{ type: "toolCall", id: `call_${turn}`, name: "click", arguments: { x: turn, y: turn } }],
			api: OPENAI_CUA_RESPONSES_API,
			provider: "openai",
			model: "gpt-5.5",
			responseId: `resp_${turn}`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 0,
		});
		messages.push({
			role: "toolResult",
			toolCallId: `call_${turn}`,
			toolName: "click",
			content: [{ type: "image", mimeType: "image/png", data: `screenshot-${turn}` }],
			isError: false,
			timestamp: 0,
		});
	}
	return { messages, tools: [], systemPrompt: "control the browser" };
}

describe("openai threadRequest", () => {
	afterEach(() => {
		delete process.env.CUA_DISABLE_RESPONSE_THREADING;
	});

	it("prunes to the delta and injects store + previous_response_id when threading (default)", async () => {
		const { context, onPayload } = threadRequest(multiTurnContext(), undefined);
		// Only the latest tool result (after the last assistant turn) is sent; the rest lives server-side.
		expect(context.messages).toHaveLength(1);
		expect((context.messages[0] as { toolCallId?: string }).toolCallId).toBe(`call_${TURNS - 1}`);
		expect(await onPayload({ input: [] }, model)).toEqual({ input: [], store: true, previous_response_id: `resp_${TURNS - 1}` });
	});

	it("replays full history with store but no previous_response_id when disabled by option", async () => {
		const ctx = multiTurnContext();
		const { context, onPayload } = threadRequest(ctx, { disableResponseThreading: true });
		expect(context).toBe(ctx);
		expect(await onPayload({}, model)).toEqual({ store: true });
	});

	it("replays full history when CUA_DISABLE_RESPONSE_THREADING is set", async () => {
		process.env.CUA_DISABLE_RESPONSE_THREADING = "1";
		const ctx = multiTurnContext();
		const { context, onPayload } = threadRequest(ctx, undefined);
		expect(context).toBe(ctx);
		expect(((await onPayload({}, model)) as Record<string, unknown>).previous_response_id).toBeUndefined();
	});

	it("falls back to full history when the latest assistant turn lacks a responseId", async () => {
		const ctx = multiTurnContext();
		ctx.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "request failed" }],
			api: OPENAI_CUA_RESPONSES_API,
			provider: "openai",
			model: "gpt-5.5",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "error",
			timestamp: 0,
		});
		const { context, onPayload } = threadRequest(ctx, undefined);
		expect(context).toBe(ctx);
		expect(((await onPayload({}, model)) as Record<string, unknown>).previous_response_id).toBeUndefined();
	});

	it("ignores a responseId from an errored turn so it never anchors previous_response_id", async () => {
		const ctx = multiTurnContext();
		// An error after response.created can capture a responseId for a response the server never stored.
		ctx.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "request failed" }],
			api: OPENAI_CUA_RESPONSES_API,
			provider: "openai",
			model: "gpt-5.5",
			responseId: "resp_failed",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "error",
			timestamp: 0,
		});
		const { context, onPayload } = threadRequest(ctx, undefined);
		expect(context).toBe(ctx);
		expect(((await onPayload({}, model)) as Record<string, unknown>).previous_response_id).toBeUndefined();
	});

	it("never anchors previous_response_id on an assistant turn from a different api", async () => {
		const ctx = multiTurnContext();
		// A mid-session -m provider switch leaves the prior provider's turn (and its foreign id) as the anchor.
		ctx.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-8",
			responseId: "msg_anthropic",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 0,
		});
		const { context, onPayload } = threadRequest(ctx, undefined);
		expect(context).toBe(ctx);
		expect(((await onPayload({}, model)) as Record<string, unknown>).previous_response_id).toBeUndefined();
	});

	it("composes a caller onPayload on top of the threaded payload", async () => {
		const { onPayload } = threadRequest(multiTurnContext(), {
			onPayload: (payload) => ({ wrapped: payload }),
		});
		expect(await onPayload({ input: [] }, model)).toEqual({
			wrapped: { input: [], store: true, previous_response_id: `resp_${TURNS - 1}` },
		});
	});
});
