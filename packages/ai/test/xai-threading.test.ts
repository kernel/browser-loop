import type { Context, Message, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { threadXaiRequest, XAI_CUA_RESPONSES_API } from "../src/providers/xai/provider";

const model = {} as Model<typeof XAI_CUA_RESPONSES_API>;

function multiTurnContext(): Context {
	const messages: Message[] = [
		{ role: "user", content: "inspect the browser", timestamp: 0 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1|fc_1", name: "screenshot", arguments: {} }],
			api: XAI_CUA_RESPONSES_API,
			provider: "xai",
			model: "grok-4.5",
			responseId: "response_xai_1",
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

describe("xAI Responses threading", () => {
	it("threads the latest response and applies serial computer-use defaults", async () => {
		const { context, onPayload } = threadXaiRequest(multiTurnContext(), undefined);
		expect(context.messages).toHaveLength(1);
		expect(await onPayload({ input: [] }, model)).toEqual({
			input: [],
			store: true,
			parallel_tool_calls: false,
			previous_response_id: "response_xai_1",
		});
	});

	it("preserves encrypted reasoning replay", async () => {
		const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
		const { onPayload } = threadXaiRequest(context, undefined);
		expect(await onPayload({ input: [], include: ["reasoning.encrypted_content"] }, model)).toEqual({
			input: [],
			include: ["reasoning.encrypted_content"],
			store: true,
			parallel_tool_calls: false,
		});
	});

	it("sends full history without previous_response_id when threading is disabled", async () => {
		const context = multiTurnContext();
		const prepared = threadXaiRequest(context, {
			disableResponseThreading: true,
			onPayload: (payload) => ({ ...(payload as object), previous_response_id: "foreign-response" }),
		});
		expect(prepared.context).toBe(context);
		expect(await prepared.onPayload({ input: [] }, model)).toEqual({
			input: [],
			store: true,
			parallel_tool_calls: false,
		});
	});

	it("reapplies xAI constraints after caller payload hooks", async () => {
		const { onPayload } = threadXaiRequest(multiTurnContext(), {
			onPayload: (payload) => ({
				...(payload as object),
				store: false,
				parallel_tool_calls: true,
				previous_response_id: "wrong-response",
				include: ["reasoning.encrypted_content"],
			}),
		});
		expect(await onPayload({}, model)).toEqual({
			store: true,
			parallel_tool_calls: false,
			previous_response_id: "response_xai_1",
			include: ["reasoning.encrypted_content"],
		});
	});
});
