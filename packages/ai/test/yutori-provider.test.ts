import { describe, expect, it, vi } from "vitest";
import type { Model, ToolCall } from "@earendil-works/pi-ai";
import { getCuaModel } from "../src/index";
import * as yutori from "../src/providers/yutori/provider";

const { completionsCreate } = vi.hoisted(() => ({ completionsCreate: vi.fn() }));

vi.mock("openai", () => ({
	default: class {
		chat = {
			completions: {
				create: (...args: unknown[]) => ({
					withResponse: async () => ({ data: completionsCreate(...args), response: { status: 200, headers: new Headers() } }),
				}),
			},
		};
	},
}));

const model = getCuaModel("yutori:n1.5-latest") as Model<typeof yutori.YUTORI_CHAT_COMPLETIONS_API>;
const incoming = { yutoriNames: { left_click: "left_click" }, googleNames: {}, googleExcludedNames: [], nativeToolNames: ["left_click"] };

function toolCalls(content: Array<{ type: string }>): ToolCall[] {
	return content.filter((part): part is ToolCall => part.type === "toolCall");
}

describe("streamYutori", () => {
	it("dispatches selected native calls through fixed catalog names", async () => {
		completionsCreate.mockReturnValueOnce({
			id: "chatcmpl_1",
			usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
			choices: [{
				finish_reason: "tool_calls",
				message: {
					content: "",
					tool_calls: [{ type: "function", id: "call_1", function: { name: "left_click", arguments: JSON.stringify({ coordinates: [100, 200] }) } }],
				},
			}],
		});

		const message = await yutori.streamYutori(model, { messages: [] }, { apiKey: "test", cuaIncomingToolPlan: incoming }).result();
		expect(message.stopReason).toBe("toolUse");
		const calls = toolCalls(message.content);
		expect(calls).toHaveLength(1);
		expect(calls[0]!).toMatchObject({ id: "call_1", name: "left_click", arguments: { coordinates: [100, 200] } });
	});

	it("degrades malformed selected calls to empty args without reclassifying by name", async () => {
		completionsCreate.mockReturnValueOnce({
			id: "chatcmpl_2",
			usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
			choices: [{
				finish_reason: "tool_calls",
				message: {
					content: "",
					tool_calls: [
						{ type: "function", id: "call_bad", function: { name: "left_click", arguments: "{not json" } },
						{ type: "function", id: "call_good", function: { name: "left_click", arguments: JSON.stringify({ coordinates: [100, 200] }) } },
					],
				},
			}],
		});

		const message = await yutori.streamYutori(model, { messages: [] }, { apiKey: "test", cuaIncomingToolPlan: incoming }).result();
		expect(message.stopReason).toBe("toolUse");
		expect(message.errorMessage).toBeUndefined();
		const calls = toolCalls(message.content);
		expect(calls).toHaveLength(2);
		expect(calls[0]!).toMatchObject({ id: "call_bad", name: "left_click", arguments: {} });
		expect(calls[1]!).toMatchObject({ id: "call_good", name: "left_click", arguments: { coordinates: [100, 200] } });
	});
});
