import { describe, expect, it } from "vitest";
import type { Context, Message, Model } from "@earendil-works/pi-ai";
import { META_RESPONSES_API, threadMetaRequest } from "../src/providers/meta/provider";

const model = {} as Model<typeof META_RESPONSES_API>;

function multiTurnContext(): Context {
	const messages: Message[] = [
		{ role: "user", content: "inspect the browser", timestamp: 0 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1|fc_1", name: "screenshot", arguments: {} }],
			api: META_RESPONSES_API,
			provider: "meta",
			model: "muse-spark-1.1",
			responseId: "resp_meta_1",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 0,
		},
		{
			role: "toolResult",
			toolCallId: "call_1|fc_1",
			toolName: "screenshot",
			content: [{ type: "image", mimeType: "image/png", data: "screenshot" }],
			isError: false,
			timestamp: 0,
		},
	];
	return { messages, tools: [], systemPrompt: "control the browser" };
}

describe("Meta Responses threading", () => {
	it("threads the latest response and applies serial computer-use defaults", async () => {
		const { context, onPayload } = threadMetaRequest(multiTurnContext(), undefined);
		expect(context.messages).toHaveLength(1);
		expect(await onPayload({ input: [] }, model)).toEqual({
			input: [],
			store: true,
			parallel_tool_calls: false,
			previous_response_id: "resp_meta_1",
		});
	});

	it("omits encrypted reasoning replay on the initial request", async () => {
		const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
		const { onPayload } = threadMetaRequest(context, undefined);
		expect(await onPayload({ input: [], include: ["reasoning.encrypted_content"] }, model)).toEqual({
			input: [],
			store: true,
			parallel_tool_calls: false,
		});
	});

	it("sends full history without previous_response_id when threading is disabled", async () => {
		const context = multiTurnContext();
		const prepared = threadMetaRequest(context, { disableResponseThreading: true });
		expect(prepared.context).toBe(context);
		expect(await prepared.onPayload({ input: [] }, model)).toEqual({
			input: [],
			store: true,
			parallel_tool_calls: false,
		});
	});

	it("passes the prepared request to a caller payload hook", async () => {
		const { onPayload } = threadMetaRequest(multiTurnContext(), {
			onPayload: (payload) => ({ wrapped: payload }),
		});
		expect(await onPayload({}, model)).toEqual({
			wrapped: {
				store: true,
				parallel_tool_calls: false,
				previous_response_id: "resp_meta_1",
			},
		});
	});

	it("removes include fields added by caller payload hooks", async () => {
		const { onPayload } = threadMetaRequest(multiTurnContext(), {
			onPayload: (payload) => ({ ...(payload as object), include: ["reasoning.encrypted_content"] }),
		});
		expect(await onPayload({}, model)).toEqual({
			store: true,
			parallel_tool_calls: false,
			previous_response_id: "resp_meta_1",
		});
	});
});
