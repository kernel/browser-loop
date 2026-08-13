import { describe, expect, it, vi } from "vitest";
import type { ToolCall } from "@earendil-works/pi-ai";
import { createCuaModels, getCuaModel, OPENAI_CUA_COMPUTER_API } from "../src/index";

const { responsesCreate } = vi.hoisted(() => ({ responsesCreate: vi.fn() }));

vi.mock("openai", () => ({
	default: class {
		responses = {
			create: (...args: unknown[]) => ({
				withResponse: async () => ({ data: responsePayload(responsesCreate(...args)), response: { status: 200, headers: new Headers() } }),
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

// pi's builtin transport iterates an event stream; the CUA native-computer
// adapter reads the raw response object's fields directly. Serve both from
// one mock so a single test file can exercise either dispatch path.
function responsePayload(response: Record<string, unknown>): AsyncIterable<unknown> & Record<string, unknown> {
	return Object.assign(responseEvents(response), response);
}

const model = getCuaModel("openai:gpt-5.5");
const tools = [{ name: "lookup", description: "lookup", parameters: { type: "object" } as never }];

describe("OpenAI adapter routing", () => {
	it("streams a plain function-tool context through pi's builtin transport", async () => {
		responsesCreate.mockReturnValueOnce({
			id: "resp_1",
			status: "completed",
			usage: { input_tokens: 1, output_tokens: 1 },
			output: [{
				type: "function_call",
				id: "fc_1",
				call_id: "call_1",
				name: "lookup",
				namespace: "deferred_tools",
				arguments: "{}",
				status: "completed",
			}],
		});
		const message = await createCuaModels().streamSimple(model, {
			messages: [{ role: "user", content: "look it up", timestamp: 1 }],
			tools,
		}, { apiKey: "test", sessionId: "session_1" }).result();

		// pi-ai 0.83.0's builtin Responses path does not parse the namespace
		// field on function_call items, unlike the CUA adapter.
		const call = message.content.find((part): part is ToolCall => part.type === "toolCall") as (ToolCall & { namespace?: string }) | undefined;
		expect(call?.name).toBe("lookup");
		expect(call?.namespace).toBeUndefined();

		// The measurement A/B depends on the default path relying on prompt
		// caching instead of `previous_response_id` threading.
		const payload = responsesCreate.mock.calls[0]![0] as Record<string, unknown>;
		expect(payload.store).toBe(false);
		expect(payload.prompt_cache_key).toBe("session_1");
		expect(payload.previous_response_id).toBeUndefined();
	});

	it("reaches the CUA adapter when the model carries OPENAI_CUA_COMPUTER_API", async () => {
		responsesCreate.mockReturnValueOnce({
			id: "resp_2",
			output: [{
				type: "computer_call",
				call_id: "computer_1",
				action: { type: "click", x: 10, y: 20 },
			}],
		});
		// compileCuaToolCatalog derives this api onto the model whenever OpenAI's
		// native computer tool is selected; the provider wrapper dispatches on it
		// alone, with no request-shape sniffing.
		const computerModel = { ...model, api: OPENAI_CUA_COMPUTER_API };
		const message = await createCuaModels().streamSimple(computerModel, {
			messages: [{ role: "user", content: "click it", timestamp: 1 }],
			tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
		}, {
			apiKey: "test",
			cuaIncomingToolPlan: { openaiComputerName: "computer", yutoriNames: {}, googleNames: {}, googleExcludedNames: [], nativeToolNames: ["computer"] },
		} as never).result();

		// Only the CUA native-computer adapter understands computer_call items;
		// pi's builtin transport has no case for them and would emit nothing.
		const call = message.content.find((part): part is ToolCall => part.type === "toolCall");
		expect(call).toMatchObject({ name: "computer", arguments: { action: { type: "click", x: 10, y: 20 } } });
	});

	it("reaches the CUA adapter when the transcript carries a deferred tool-search addition", async () => {
		responsesCreate.mockReturnValueOnce({
			id: "resp_3",
			status: "completed",
			usage: { input_tokens: 1, output_tokens: 1 },
			output: [{
				type: "function_call",
				id: "fc_3",
				call_id: "call_3",
				name: "lookup",
				namespace: "deferred_tools",
				arguments: "{}",
				status: "completed",
			}],
		});
		const message = await createCuaModels().streamSimple(model, {
			messages: [
				{ role: "user", content: "load and look it up", timestamp: 1 },
				{
					role: "toolResult",
					toolCallId: "call_loader",
					toolName: "loader",
					content: [{ type: "text", text: "loaded" }],
					isError: false,
					addedToolNames: ["lookup"],
					timestamp: 2,
				},
			],
			tools,
		}, { apiKey: "test" } as never).result();

		// The CUA adapter round-trips the namespace pi's builtin drops.
		const call = message.content.find((part): part is ToolCall => part.type === "toolCall") as (ToolCall & { namespace?: string }) | undefined;
		expect(call?.namespace).toBe("deferred_tools");
	});

	it("keeps cache-relevant payload fields identical across a mid-conversation escalation", async () => {
		// A turn can move from pi's builtin transport to the CUA adapter mid-session
		// (a deferred tool gets added). If that switch changed `store` or the cache
		// key, it would silently invalidate the matched prompt-cache prefix.
		responsesCreate.mockReturnValue({ id: "resp_parity", status: "completed", usage: {}, output: [] });
		await createCuaModels().streamSimple(model, {
			messages: [{ role: "user", content: "look it up", timestamp: 1 }],
			tools,
		}, { apiKey: "test", sessionId: "session_parity" }).result();
		const builtinPayload = responsesCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;

		await createCuaModels().streamSimple(model, {
			messages: [
				{ role: "user", content: "load and look it up", timestamp: 1 },
				{
					role: "toolResult",
					toolCallId: "call_loader",
					toolName: "loader",
					content: [{ type: "text", text: "loaded" }],
					isError: false,
					addedToolNames: ["lookup"],
					timestamp: 2,
				},
			],
			tools,
		}, { apiKey: "test", sessionId: "session_parity" } as never).result();
		const escalatedPayload = responsesCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;

		for (const field of ["store", "prompt_cache_key", "prompt_cache_retention", "prompt_cache_options"]) {
			expect(escalatedPayload[field], field).toEqual(builtinPayload[field]);
		}
	});

	it("pairs replayed namespaces by call id, not ordinal, across an aborted assistant turn", async () => {
		responsesCreate.mockReturnValueOnce({ id: "resp_4", usage: {}, output: [] });
		await createCuaModels().streamSimple(model, {
			messages: [
				{ role: "user", content: "load and look it up", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_loader|fc_loader", name: "loader", arguments: {} }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "aborted",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_loader|fc_loader",
					toolName: "loader",
					content: [{ type: "text", text: "loaded" }],
					isError: false,
					addedToolNames: ["lookup"],
					timestamp: 3,
				},
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_lookup|fc_lookup", name: "lookup", arguments: {}, namespace: "deferred_tools" } as ToolCall],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "toolUse",
					timestamp: 4,
				},
				{
					role: "toolResult",
					toolCallId: "call_lookup|fc_lookup",
					toolName: "lookup",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 5,
				},
			],
			tools,
		}, { apiKey: "test" } as never).result();

		// pi drops the aborted "loader" assistant message from the replayed
		// transcript entirely, so pairing by ordinal would shift "lookup"'s
		// namespace onto the missing "loader" call instead.
		const payload = responsesCreate.mock.calls.at(-1)?.[0] as { input: Array<Record<string, unknown>> };
		expect(payload.input).toContainEqual(expect.objectContaining({
			type: "function_call",
			call_id: "call_lookup",
			name: "lookup",
			namespace: "deferred_tools",
		}));
	});
});
