import { describe, expect, it, vi } from "vitest";
import type { Model, ToolCall } from "@earendil-works/pi-ai";
import { getCuaModel } from "../src/index";
import * as tzafon from "../src/providers/tzafon/provider";

const { lightconeConstructor, responsesCreate } = vi.hoisted(() => ({
	lightconeConstructor: vi.fn(),
	responsesCreate: vi.fn(),
}));

vi.mock("@tzafon/lightcone", () => ({
	default: class {
		responses = { create: responsesCreate };
		constructor(options: unknown) {
			lightconeConstructor(options);
		}
	},
}));

const model = getCuaModel("tzafon:tzafon.northstar-cua-fast") as Model<typeof tzafon.TZAFON_RESPONSES_API>;

function toolCalls(content: Array<{ type: string }>): ToolCall[] {
	return content.filter((part): part is ToolCall => part.type === "toolCall");
}

describe("streamTzafonResponses", () => {
	it("configures the resolvable Tzafon API endpoint", async () => {
		responsesCreate.mockResolvedValueOnce({ id: "resp_endpoint", usage: {}, output: [] });

		await tzafon.streamTzafonResponses(model, { messages: [] }, { apiKey: "test" }).result();

		expect(model.baseUrl).toBe("https://api.tzafon.ai");
		expect(lightconeConstructor).toHaveBeenLastCalledWith(expect.objectContaining({
			apiKey: "test",
			baseURL: "https://api.tzafon.ai",
		}));
	});

	it("derives unique ids when one computer_call expands to multiple actions", () => {
		expect(tzafon.tzafonToolCallId("call_1", 0)).toBe("call_1");
		expect(tzafon.tzafonToolCallId("call_1", 1)).toBe("call_1:1");
		expect(tzafon.tzafonToolCallId("call_1", 2)).toBe("call_1:2");
	});

	it("unwraps stringified nested arguments and coerces numeric strings on function calls", async () => {
		responsesCreate.mockResolvedValueOnce({
			id: "resp_1",
			usage: { input_tokens: 1, output_tokens: 2 },
			output: [
				{
					type: "function_call",
					call_id: "call_1",
					name: "computer_batch",
					// Observed Tzafon shape: the actions array arrives JSON-encoded
					// inside the argument object, with stringified coordinates.
					arguments: JSON.stringify({ actions: JSON.stringify([{ type: "click", x: "10", y: "20" }]) }),
				},
			],
		});

		const message = await tzafon.streamTzafonResponses(model, { messages: [] }, { apiKey: "test" }).result();
		expect(message.stopReason).toBe("toolUse");
		expect(message.errorMessage).toBeUndefined();
		const calls = toolCalls(message.content);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.name).toBe("computer_batch");
		expect(calls[0]!.arguments).toEqual({ actions: [{ type: "click", x: 10, y: 20 }] });
	});

	it("normalizes non-native computer_call actions with string coordinates", async () => {
		responsesCreate.mockResolvedValueOnce({
			id: "resp_2",
			usage: {},
			output: [{ type: "computer_call", call_id: "call_2", action: { type: "left_click", x: "500", y: "250" } }],
		});

		const message = await tzafon.streamTzafonResponses(model, { messages: [] }, { apiKey: "test" }).result();
		expect(message.stopReason).toBe("toolUse");
		const calls = toolCalls(message.content);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.name).toBe("click");
		expect(calls[0]!.arguments).toEqual({ x: 500, y: 250 });
	});

	it("rejects native computer actions that require automatic post-action screenshots", async () => {
		responsesCreate.mockResolvedValueOnce({
			id: "resp_native_click",
			usage: {},
			output: [{ type: "computer_call", call_id: "call_click", action: { type: "click", x: 500, y: 500 } }],
		});

		const message = await tzafon.streamTzafonResponses(model, { messages: [] }, {
			apiKey: "test",
			cuaIncomingToolPlan: { tzafonComputerName: "computer", yutoriNames: {}, googleNames: {}, googleExcludedNames: [], nativeToolNames: ["computer"] },
		}).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain('Tzafon native computer action "click" is unsupported');
		expect(toolCalls(message.content)).toEqual([]);
	});

	it("serializes text-only native computer results as computer_screenshot errors", () => {
		const payload = tzafon.buildTzafonRequestInput(model, {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_click", name: "computer", arguments: { action: { type: "click", x: 500, y: 500 } } }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call_click",
					toolName: "computer",
					content: [{ type: "text", text: "Actions executed successfully." }],
					isError: false,
					timestamp: 2,
				},
			],
			tools: [],
		}, {
			disableResponseThreading: true,
			cuaIncomingToolPlan: { tzafonComputerName: "computer", yutoriNames: {}, googleNames: {}, googleExcludedNames: [], nativeToolNames: ["computer"] },
		});

		expect(payload.input).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "computer_call", call_id: "call_click" }),
			expect.objectContaining({
				type: "computer_call_output",
				call_id: "call_click",
				output: {
					type: "computer_screenshot",
					error: "Actions executed successfully.",
				},
			}),
		]));
	});

	it("degrades malformed function-call arguments to empty args instead of failing the turn", async () => {
		responsesCreate.mockResolvedValueOnce({
			id: "resp_3",
			usage: {},
			output: [
				{ type: "function_call", call_id: "call_bad", name: "custom_tool", arguments: "{not json" },
				{ type: "computer_call", call_id: "call_good", action: { type: "left_click", x: 1, y: 2 } },
			],
		});

		const message = await tzafon.streamTzafonResponses(model, { messages: [] }, { apiKey: "test" }).result();
		expect(message.stopReason).toBe("toolUse");
		expect(message.errorMessage).toBeUndefined();
		const calls = toolCalls(message.content);
		expect(calls).toHaveLength(2);
		expect(calls[0]!).toMatchObject({ name: "custom_tool", arguments: {} });
		expect(calls[1]!).toMatchObject({ name: "click", arguments: { x: 1, y: 2 } });
	});
});
