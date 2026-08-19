import { describe, expect, it, vi } from "vitest";
import type { Model, ToolCall } from "@earendil-works/pi-ai";
import { getLoopModel } from "../src/pi/index";
import * as openai from "../src/pi/providers/openai/provider";

const { responsesCreate } = vi.hoisted(() => ({ responsesCreate: vi.fn() }));

vi.mock("openai", () => ({
	default: class {
		responses = {
			create: (...args: unknown[]) => ({
				withResponse: async () => ({ data: responsesCreate(...args), response: { status: 200, headers: new Headers() } }),
			}),
		};
	},
}));

const model = getLoopModel("openai:gpt-5.5") as Model<"openai-responses">;
// The catalog derives this api when OpenAI's native computer tool is selected;
// the provider wrapper routes it to the adapter under test.
const nativeModel = { ...model, api: openai.OPENAI_COMPUTER_USE_API } as unknown as Model<"openai-responses">;
const incoming = { openaiComputerName: "computer", googleNames: {}, googleExcludedNames: [], nativeToolNames: ["computer"] };

describe("OpenAI native computer Responses adapter", () => {
	it("emits one identity-selected local call for actions[] and safety checks", async () => {
		responsesCreate.mockReturnValueOnce({
			id: "resp_1",
			usage: { input_tokens: 10, output_tokens: 2 },
			output: [{
				type: "computer_call",
				call_id: "computer_1",
				actions: [{ type: "click", x: 10, y: 20 }, { type: "type", text: "hello" }],
				pending_safety_checks: [{ id: "check_1", code: "malicious_instructions" }],
			}],
		});
		const message = await openai.streamOpenAIComputerUse(nativeModel, {
			messages: [],
			tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
		}, {
			apiKey: "test",
			loopIncomingToolPlan: incoming,
			onPayload: (payload) => ({ ...(payload as Record<string, unknown>), tools: [{ type: "computer" }] }),
		}).result();
		const call = message.content.find((part): part is ToolCall => part.type === "toolCall");
		expect(call).toMatchObject({
			id: "computer_1",
			name: "computer",
			arguments: {
				actions: [{ type: "click", x: 10, y: 20 }, { type: "type", text: "hello" }],
				pending_safety_checks: [{ id: "check_1", code: "malicious_instructions" }],
			},
		});

		const payload = responsesCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		expect(payload.store).toBe(false);
		expect(payload.previous_response_id).toBeUndefined();
	});

	it("sends the same prompt-cache fields as the function-tool path", async () => {
		responsesCreate.mockReturnValueOnce({ id: "resp_cache", usage: {}, output: [] });
		await openai.streamOpenAIComputerUse(nativeModel, {
			messages: [{ role: "user", content: "go", timestamp: 1 }],
			tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
		}, { apiKey: "test", sessionId: "session_native", loopIncomingToolPlan: incoming }).result();

		const payload = responsesCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		expect(payload.prompt_cache_key).toBe("session_native");
		expect(payload.store).toBe(false);
	});

	it("round-trips function-call namespaces beside the native computer adapter", async () => {
		responsesCreate.mockReturnValueOnce({
			id: "resp_namespace",
			usage: {},
			output: [{
				type: "function_call",
				id: "fc_lookup",
				call_id: "call_lookup",
				name: "lookup",
				namespace: "deferred_tools",
				arguments: '{"query":"status"}',
			}],
		});
		const first = await openai.streamOpenAIComputerUse(nativeModel, {
			messages: [{ role: "user", content: "look it up", timestamp: 1 }],
			tools: [
				{ name: "computer", description: "placeholder", parameters: { type: "object" } as never },
				{ name: "lookup", description: "lookup", parameters: { type: "object" } as never },
			],
		}, { apiKey: "test", loopIncomingToolPlan: incoming }).result();
		const call = first.content.find((part): part is ToolCall => part.type === "toolCall") as ToolCall & { namespace?: string };
		expect(call.namespace).toBe("deferred_tools");

		responsesCreate.mockReturnValueOnce({ id: "resp_done", usage: {}, output: [] });
		await openai.streamOpenAIComputerUse(nativeModel, {
			messages: [
				{ role: "user", content: "look it up", timestamp: 1 },
				first,
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "ok" }],
					details: {},
					isError: false,
					timestamp: 2,
				},
			],
			tools: [
				{ name: "computer", description: "placeholder", parameters: { type: "object" } as never },
				{ name: "lookup", description: "lookup", parameters: { type: "object" } as never },
			],
		}, { apiKey: "test", loopIncomingToolPlan: incoming }).result();

		const payload = responsesCreate.mock.calls.at(-1)?.[0] as { input: Array<Record<string, unknown>>; store?: unknown; previous_response_id?: unknown };
		expect(payload.input).toContainEqual(expect.objectContaining({
			type: "function_call",
			call_id: "call_lookup",
			name: "lookup",
			namespace: "deferred_tools",
		}));
		expect(payload.store).toBe(false);
		expect(payload.previous_response_id).toBeUndefined();
	});

	it("serializes native results as computer_call_output and ordinary results as function output", async () => {
		responsesCreate.mockReturnValueOnce({ id: "resp_2", usage: {}, output: [] });
		await openai.streamOpenAIComputerUse(nativeModel, {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "computer_1", name: "computer", arguments: {
						action: { type: "click", x: 10, y: 20 },
						pending_safety_checks: [{ id: "check_1" }],
					} }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "computer_1",
					toolName: "computer",
					content: [{ type: "image", data: Buffer.from("image").toString("base64"), mimeType: "image/png" }],
					details: {},
					isError: false,
					timestamp: 2,
				},
			],
			tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
		}, {
			apiKey: "test",
			loopIncomingToolPlan: incoming,
			onPayload: (payload) => ({ ...(payload as Record<string, unknown>), tools: [{ type: "computer" }] }),
		}).result();

		const payload = responsesCreate.mock.calls.at(-1)?.[0] as { input: Array<Record<string, unknown>>; store?: unknown; previous_response_id?: unknown };
		expect(payload.input).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "computer_call", call_id: "computer_1" }),
			expect.objectContaining({
				type: "computer_call_output",
				call_id: "computer_1",
				acknowledged_safety_checks: [{ id: "check_1" }],
				output: expect.objectContaining({ type: "computer_screenshot", image_url: expect.stringContaining("data:image/png;base64,") }),
			}),
		]));
		expect(payload.store).toBe(false);
		expect(payload.previous_response_id).toBeUndefined();
	});


});
describe("computer_call_output serialization", () => {
	async function sendWithResult(content: Array<{ type: string; [k: string]: unknown }>, isError: boolean) {
		responsesCreate.mockReturnValueOnce({ id: "resp_ser", usage: {}, output: [] });
		await openai.streamOpenAIComputerUse(nativeModel, {
			messages: [
				{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "computer", arguments: {} }], stopReason: "toolUse" },
				{ role: "toolResult", toolCallId: "c1", toolName: "computer", content, isError, timestamp: 1 },
			] as never,
			tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
		}, { apiKey: "test", loopIncomingToolPlan: incoming }).result();
		return JSON.stringify(responsesCreate.mock.calls.at(-1)?.[0]);
	}

	it("never emits an error key, and always carries a valid screenshot", async () => {
		// Verified live: putting the failure text in an `error` key here makes the
		// Responses API answer 400 `Unknown parameter: 'input[N].output.error'`, which
		// poisoned every later request in the conversation.
		const sent = await sendWithResult([{ type: "text", text: "click failed" }], true);
		expect(sent).not.toContain('"error"');
		expect(sent).toContain("computer_screenshot");
		expect(sent).toContain("image_url");
		// The text still reaches the model, as a message rather than an invalid field.
		expect(sent).toContain("computer action produced no screenshot");
	});

	it("uses the real screenshot when the result carries one", async () => {
		const sent = await sendWithResult([{ type: "image", data: "aW1n", mimeType: "image/png" }], false);
		expect(sent).toContain("data:image/png;base64,aW1n");
		expect(sent).not.toContain("produced no screenshot");
	});

	it("replays assistant text as output_text", async () => {
		responsesCreate.mockReturnValueOnce({ id: "resp_turn2", usage: {}, output: [] });
		await openai.streamOpenAIComputerUse(nativeModel, {
			messages: [
				{ role: "user", content: "say hi" },
				{ role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" },
				{ role: "user", content: "say hi again" },
			] as never,
			tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
		}, { apiKey: "test", loopIncomingToolPlan: incoming }).result();

		// Responses rejects `input_text` on an assistant item, so replaying it that
		// way answers 400 on every turn after the first.
		const payload = responsesCreate.mock.calls.at(-1)?.[0] as { input: Array<Record<string, unknown>> };
		expect(payload.input).toContainEqual({ role: "assistant", content: [{ type: "output_text", text: "hi" }] });
	});
});
