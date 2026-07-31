import { describe, expect, it, vi } from "vitest";
import type { Model, ToolCall } from "@earendil-works/pi-ai";
import { getCuaModel } from "../src/index";
import * as openai from "../src/providers/openai/provider";

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

const model = getCuaModel("openai:gpt-5.5") as Model<typeof openai.OPENAI_CUA_RESPONSES_API>;
const incoming = { openaiComputerName: "computer", yutoriNames: {}, googleNames: {}, googleExcludedNames: [], nativeToolNames: ["computer"] };

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
		const message = await openai.streamOpenAIResponses(model, {
			messages: [],
			tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
		}, {
			apiKey: "test",
			cuaIncomingToolPlan: incoming,
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
		const first = await openai.streamOpenAIResponses(model, {
			messages: [{ role: "user", content: "look it up", timestamp: 1 }],
			tools: [
				{ name: "computer", description: "placeholder", parameters: { type: "object" } as never },
				{ name: "lookup", description: "lookup", parameters: { type: "object" } as never },
			],
		}, { apiKey: "test", cuaIncomingToolPlan: incoming }).result();
		const call = first.content.find((part): part is ToolCall => part.type === "toolCall") as ToolCall & { namespace?: string };
		expect(call.namespace).toBe("deferred_tools");

		responsesCreate.mockReturnValueOnce({ id: "resp_done", usage: {}, output: [] });
		await openai.streamOpenAIResponses(model, {
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
		}, { apiKey: "test", cuaIncomingToolPlan: incoming, disableResponseThreading: true }).result();

		const payload = responsesCreate.mock.calls.at(-1)?.[0] as { input: Array<Record<string, unknown>> };
		expect(payload.input).toContainEqual(expect.objectContaining({
			type: "function_call",
			call_id: "call_lookup",
			name: "lookup",
			namespace: "deferred_tools",
		}));
	});

	it("serializes native results as computer_call_output and ordinary results as function output", async () => {
		responsesCreate.mockReturnValueOnce({ id: "resp_2", usage: {}, output: [] });
		await openai.streamOpenAIResponses(model, {
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
			cuaIncomingToolPlan: incoming,
			disableResponseThreading: true,
			onPayload: (payload) => ({ ...(payload as Record<string, unknown>), tools: [{ type: "computer" }] }),
		}).result();

		const payload = responsesCreate.mock.calls.at(-1)?.[0] as { input: Array<Record<string, unknown>> };
		expect(payload.input).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "computer_call", call_id: "computer_1" }),
			expect.objectContaining({
				type: "computer_call_output",
				call_id: "computer_1",
				acknowledged_safety_checks: [{ id: "check_1" }],
				output: expect.objectContaining({ type: "computer_screenshot", image_url: expect.stringContaining("data:image/png;base64,") }),
			}),
		]));
	});
});
