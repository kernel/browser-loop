import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolCall } from "@onkernel/cua-ai";
import type Kernel from "@onkernel/sdk";
import { describe, expect, it, vi } from "vitest";
import { CuaAgent, type KernelBrowser } from "../src/index";

const { responsesCreate } = vi.hoisted(() => ({ responsesCreate: vi.fn() }));

vi.mock("openai", () => ({
	default: class {
		responses = {
			create: (payload: unknown) => ({
				withResponse: async () => ({
					data: responseEvents(responsesCreate(payload)),
					response: { status: 200, headers: new Headers() },
				}),
			}),
		};
	},
}));

async function* responseEvents(response: Record<string, unknown>) {
	yield { type: "response.created", response: { id: response.id } };
	for (const [outputIndex, item] of ((response.output as unknown[]) ?? []).entries()) {
		yield { type: "response.output_item.added", output_index: outputIndex, item };
		yield { type: "response.output_item.done", output_index: outputIndex, item };
	}
	yield { type: "response.completed", response };
}

function functionCall(id: string, callId: string, name: string, namespace?: string) {
	return {
		type: "function_call",
		id,
		call_id: callId,
		name,
		arguments: "{}",
		status: "completed",
		...(namespace ? { namespace } : {}),
	};
}

function response(id: string, output: unknown[]) {
	return {
		id,
		status: "completed",
		output,
		usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
	};
}

function callerTool(name: string, execute: AgentTool["execute"], executionMode?: AgentTool["executionMode"]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: { type: "object", properties: {}, additionalProperties: false } as never,
		execute,
		...(executionMode ? { executionMode } : {}),
	};
}

describe("OpenAI deferred tool namespace continuation", () => {
	it("executes a deferred-added call and replays its provider namespace", async () => {
		responsesCreate
			.mockReturnValueOnce(response("resp_loader", [functionCall("fc_loader", "call_loader", "loader")]))
			.mockReturnValueOnce(response("resp_added", [functionCall("fc_added", "call_added", "added", "deferred_tools")]))
			.mockReturnValueOnce(response("resp_done", [{
				type: "message",
				id: "msg_done",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "done", annotations: [] }],
			}]));

		const addedExecute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "added result" }], details: {} }));
		const added = callerTool("added", addedExecute);
		let agent!: CuaAgent;
		const loader = callerTool("loader", async () => {
			agent.setTools([...agent.getTools(), added]);
			return { content: [{ type: "text", text: "loaded" }], details: {} };
		}, "sequential");
		agent = new CuaAgent({
			browser: { session_id: "browser_123" } as KernelBrowser,
			client: {} as Kernel,
			tools: [loader],
			initialState: { model: "openai:gpt-5.5" },
			getApiKey: () => "test",
			responseThreading: false,
		});

		await agent.prompt("load and run the added tool");

		expect(addedExecute).toHaveBeenCalledTimes(1);
		const deferredCall = agent.state.messages
			.find((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.name === "added"))
			?.content.find((part): part is ToolCall => part.type === "toolCall") as (ToolCall & { namespace?: string }) | undefined;
		expect(deferredCall?.namespace).toBe("deferred_tools");

		const secondPayload = responsesCreate.mock.calls[1]?.[0] as { input: Array<Record<string, unknown>> };
		expect(secondPayload.input).toContainEqual(expect.objectContaining({ type: "tool_search_output" }));
		const replayPayload = responsesCreate.mock.calls[2]?.[0] as { input: Array<Record<string, unknown>> };
		expect(replayPayload.input).toContainEqual(expect.objectContaining({
			type: "function_call",
			call_id: "call_added",
			name: "added",
			namespace: "deferred_tools",
		}));
	});
});
