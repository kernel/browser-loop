import { describe, expect, it, vi } from "vitest";
import type { AgentTool, Context, Message, Model } from "@earendil-works/pi-ai";
import { createServer } from "node:http";
import { cuaModels, getCuaModel, resolveCuaRuntimeSpec } from "../src/index";
import { ANTHROPIC_NATIVE_BROWSER_MESSAGES_API } from "../src/providers/anthropic/native";

const { openaiCreate } = vi.hoisted(() => ({
	openaiCreate: vi.fn(),
}));

vi.mock("openai", () => ({
	default: class {
		responses = {
			create: (...args: unknown[]) => {
				openaiCreate(...args);
				return {
					withResponse: async () => {
						throw new Error("stop after payload capture");
					},
				};
			},
		};
	},
}));

const dynamicTool: AgentTool = {
	name: "learned_tool",
	label: "Learned tool",
	description: "learned",
	parameters: { type: "object", properties: {} },
	execute: async () => ({ content: [], details: {} }),
};
const addTool: AgentTool = { ...dynamicTool, name: "add_tool", label: "Add tool" };

function addMessages(api: string, responseId?: string): Message[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "add_1", name: "add_tool", arguments: {} }],
			api,
			provider: api.startsWith("openai") ? "openai" : "anthropic",
			model: api.startsWith("openai") ? "gpt-5.5" : "claude-sonnet-4-5",
			responseId,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 0,
		},
		{
			role: "toolResult",
			toolCallId: "add_1",
			toolName: "add_tool",
			content: [{ type: "text", text: "added" }],
			addedToolNames: ["learned_tool"],
			isError: false,
			timestamp: 0,
		},
	];
}

async function capturePayload(
	model: Model<any>,
	context: Context,
	transform?: (payload: unknown, model: Model<any>) => unknown | Promise<unknown>,
): Promise<Record<string, any>> {
	let payload: Record<string, any> | undefined;
	await cuaModels()
		.streamSimple(model, context, {
			apiKey: "test",
			onPayload: async (value, payloadModel) => {
				const transformed = transform
					? ((await transform(value, payloadModel)) ?? value)
					: value;
				payload = transformed as Record<string, any>;
				return transformed;
			},
		})
		.result();
	if (!payload) throw new Error("payload was not captured");
	return payload;
}

describe("message-anchored dynamic tool payloads", () => {
	it("uses OpenAI tool search while preserving response threading", async () => {
		const model = getCuaModel("openai:gpt-5.5");
		const payload = await capturePayload(model, {
			systemPrompt: "test",
			tools: [addTool, dynamicTool],
			messages: addMessages(model.api, "resp_add"),
		});
		expect(payload.store).toBe(true);
		expect(payload.previous_response_id).toBe("resp_add");
		const searchOutput = payload.input.find((item: any) => item.type === "tool_search_output");
		expect(searchOutput.tools).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "learned_tool", defer_loading: true })]),
		);
		expect(payload.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "tool_search_call" }),
				expect.objectContaining({ type: "tool_search_output" }),
			]),
		);
	});

	it("eagerly declares the tool after the add marker is pruned by the next response anchor", async () => {
		const model = getCuaModel("openai:gpt-5.5");
		const messages = addMessages(model.api, "resp_add");
		messages.push(
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "learn_1", name: "learned_tool", arguments: {} }],
				api: model.api,
				provider: "openai",
				model: model.id,
				responseId: "resp_learned",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse",
				timestamp: 0,
			},
			{ role: "toolResult", toolCallId: "learn_1", toolName: "learned_tool", content: [], isError: false, timestamp: 0 },
		);
		const payload = await capturePayload(model, { systemPrompt: "test", tools: [addTool, dynamicTool], messages });
		expect(payload.previous_response_id).toBe("resp_learned");
		expect(payload.tools).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "learned_tool" })]),
		);
		expect(payload.tools.find((tool: any) => tool.name === "learned_tool").defer_loading).toBeUndefined();
	});

	it("uses Anthropic references for supported models and eager tools for Haiku", async () => {
		const supported = getCuaModel("anthropic:claude-sonnet-4-5");
		const supportedPayload = await capturePayload(supported, {
			systemPrompt: "test",
			tools: [addTool, dynamicTool],
			messages: addMessages(supported.api),
		});
		expect(supportedPayload.tools).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "learned_tool", defer_loading: true })]),
		);
		expect(JSON.stringify(supportedPayload.messages)).toContain("tool_reference");

		const haiku = {
			...supported,
			id: "claude-haiku-4",
			compat: { ...supported.compat, supportsToolReferences: false },
		};
		const haikuPayload = await capturePayload(haiku, {
			systemPrompt: "test",
			tools: [addTool, dynamicTool],
			messages: addMessages(haiku.api),
		});
		expect(JSON.stringify(haikuPayload.messages)).not.toContain("tool_reference");
		expect(haikuPayload.tools).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "learned_tool" })]),
		);
	});

	it("preserves dynamic tools and beta headers through Anthropic native routing", async () => {
		let requestHeaders: Record<string, string | string[] | undefined> = {};
		const server = createServer((request, response) => {
			requestHeaders = request.headers;
			response.writeHead(500, { "content-type": "application/json" });
			response.end('{"error":{"message":"captured"}}');
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		try {
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("test server did not bind");
			const spec = resolveCuaRuntimeSpec(
				"anthropic:claude-sonnet-4-5",
				{ nativeTool: { type: "browser_20260701" } },
			);
			const model = {
				...spec.model,
				api: ANTHROPIC_NATIVE_BROWSER_MESSAGES_API,
				baseUrl: `http://127.0.0.1:${address.port}`,
			} as Model<any>;
			const nativePlaceholder = {
				...dynamicTool,
				...spec.toolDefinitions[0],
			} as AgentTool;
			const payload = await capturePayload(
				model,
				{
					systemPrompt: "test",
					tools: [nativePlaceholder, addTool, dynamicTool],
					messages: addMessages("anthropic-messages"),
				},
				spec.onPayload,
			);
			expect(payload.tools).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "learned_tool",
						defer_loading: true,
					}),
				]),
			);
			expect(payload.tools).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "browser_20260701" }),
				]),
			);
			expect(requestHeaders["anthropic-beta"]).toContain(
				"browser-use-2026-07-01",
			);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});
