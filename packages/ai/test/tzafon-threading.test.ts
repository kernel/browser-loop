import { describe, expect, it } from "vitest";
import type { Context, Message, Model } from "@earendil-works/pi-ai";
import { tzafon } from "../src/index";

const model = { id: "tzafon.northstar-cua-fast", maxTokens: 4096 } as Model<typeof tzafon.TZAFON_RESPONSES_API>;

const TURNS = 6;

/** Build a multi-turn context where each assistant turn carries a distinct responseId followed by a screenshot tool result. */
function multiTurnContext(): Context {
	const messages: Message[] = [{ role: "user", content: "book a flight", timestamp: 0 }];
	for (let turn = 0; turn < TURNS; turn += 1) {
		messages.push({
			role: "assistant",
			content: [{ type: "toolCall", id: `call_${turn}`, name: "click", arguments: { x: turn, y: turn } }],
			api: tzafon.TZAFON_RESPONSES_API,
			provider: "tzafon",
			model: model.id,
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

function screenshotImageUrls(input: Array<Record<string, unknown>>): string[] {
	const urls: string[] = [];
	for (const item of input) {
		const content = item.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part && typeof part === "object" && (part as { type?: string }).type === "input_image") {
				urls.push((part as { image_url: string }).image_url);
			}
		}
	}
	return urls;
}

describe("buildTzafonRequestInput response threading", () => {
	// Threading ON is the fix: chain via previous_response_id and send only the
	// latest screenshot. OFF sends every screenshot — the per-turn growth that
	// overflows Tzafon's real 64K window after a few turns.
	it("threads the latest delta when enabled (default)", () => {
		const body = tzafon.buildTzafonRequestInput(model, multiTurnContext());
		const screenshots = screenshotImageUrls(body.input);

		expect(screenshots).toHaveLength(1);
		expect(screenshots[0]).toBe(`data:image/png;base64,screenshot-${TURNS - 1}`);
		expect(body.previous_response_id).toBe(`resp_${TURNS - 1}`);
		expect(body.store).toBe(true);
	});

	it("sends the full screenshot history when threading is disabled by option (locks the failure mode)", () => {
		const body = tzafon.buildTzafonRequestInput(model, multiTurnContext(), { disableResponseThreading: true });
		const screenshots = screenshotImageUrls(body.input);

		expect(screenshots).toHaveLength(TURNS);
		expect(screenshots).toEqual(Array.from({ length: TURNS }, (_, turn) => `data:image/png;base64,screenshot-${turn}`));
		expect(body.previous_response_id).toBeUndefined();
		expect(body.store).toBeUndefined();
	});

	it("falls back to full history when no prior turn carries a responseId", () => {
		const context = multiTurnContext();
		for (const message of context.messages) {
			if (message.role === "assistant") delete message.responseId;
		}

		const body = tzafon.buildTzafonRequestInput(model, context);
		expect(screenshotImageUrls(body.input)).toHaveLength(TURNS);
		expect(body.previous_response_id).toBeUndefined();
	});

	it("replays full history when the latest assistant turn has no responseId (failed request)", () => {
		const context = multiTurnContext();
		// A newer assistant turn whose request errored carries no responseId; threading must
		// anchor on it and replay, not chain to the older id and re-send the items past it.
		context.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "request failed" }],
			api: tzafon.TZAFON_RESPONSES_API,
			provider: "tzafon",
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "error",
			timestamp: 0,
		});

		const body = tzafon.buildTzafonRequestInput(model, context);
		expect(body.previous_response_id).toBeUndefined();
		expect(body.store).toBeUndefined();
		expect(screenshotImageUrls(body.input)).toHaveLength(TURNS);
	});

	it("replays full history when the latest assistant turn is from a different api", () => {
		const context = multiTurnContext();
		context.messages.push({
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

		const body = tzafon.buildTzafonRequestInput(model, context);
		expect(body.previous_response_id).toBeUndefined();
		expect(screenshotImageUrls(body.input)).toHaveLength(TURNS);
	});

	// Off-path screenshot count scales with turn count; on-path stays constant at one.
	it("grows the payload per turn when off but stays flat when on", () => {
		const counts = (turns: number, disable: boolean) => {
			const messages: Message[] = [{ role: "user", content: "task", timestamp: 0 }];
			for (let turn = 0; turn < turns; turn += 1) {
				messages.push({
					role: "assistant",
					content: [{ type: "toolCall", id: `c_${turn}`, name: "click", arguments: {} }],
					api: tzafon.TZAFON_RESPONSES_API,
					provider: "tzafon",
					model: model.id,
					responseId: `r_${turn}`,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "toolUse",
					timestamp: 0,
				});
				messages.push({
					role: "toolResult",
					toolCallId: `c_${turn}`,
					toolName: "click",
					content: [{ type: "image", mimeType: "image/png", data: `s-${turn}` }],
					isError: false,
					timestamp: 0,
				});
			}
			const body = tzafon.buildTzafonRequestInput(model, { messages, tools: [] }, { disableResponseThreading: disable });
			return screenshotImageUrls(body.input).length;
		};

		expect(counts(3, true)).toBe(3);
		expect(counts(8, true)).toBe(8);
		expect(counts(3, false)).toBe(1);
		expect(counts(8, false)).toBe(1);
	});
});
