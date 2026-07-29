import type { AssistantMessage, Model, ToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCuaModel } from "../src/index";
import * as google from "../src/providers/google/provider";

const model = getCuaModel("google:gemini-3.6-flash") as Model<typeof google.GOOGLE_CUA_INTERACTIONS_API>;
const incoming = {
	googleNames: { click: "click" },
	googleExcludedNames: ["take_screenshot"],
	yutoriNames: {},
	nativeToolNames: ["click"],
};
const screenshotIncoming = {
	googleNames: { take_screenshot: "take_screenshot" },
	googleExcludedNames: ["click"],
	yutoriNames: {},
	nativeToolNames: ["take_screenshot"],
};
const clickTool = { name: "click", description: "Click the page", parameters: { type: "object" } as never };
const screenshotTool = { name: "take_screenshot", description: "Take a screenshot", parameters: { type: "object" } as never };

afterEach(() => vi.unstubAllGlobals());

describe("Google Interactions computer-use adapter", () => {
	it("sends first-turn messages as current user_input steps", async () => {
		const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
			id: "interaction_1",
			status: "requires_action",
			usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
			steps: [{ type: "function_call", id: "call_1", name: "click", arguments: { x: 450, y: 120, intent: "Click search" } }],
		}), { status: 200, headers: { "content-type": "application/json" } }));
		vi.stubGlobal("fetch", fetch);

		const message = await google.streamGoogleInteractions(model, {
			systemPrompt: "Use the browser.",
			messages: [{ role: "user", content: "click search", timestamp: 1 }],
			tools: [clickTool],
		}, { apiKey: "test", cuaIncomingToolPlan: incoming }).result();

		expect(fetch.mock.calls[0]?.[0]).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
		const call = message.content.find((content): content is ToolCall => content.type === "toolCall");
		expect(call).toMatchObject({ id: "call_1", name: "click", arguments: { x: 450, y: 120 } });
		expect(message.responseId).toBe("interaction_1");
		const request = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
		expect(request).toMatchObject({
			model: "gemini-3.6-flash",
			store: true,
			system_instruction: "Use the browser.",
			input: [{ type: "user_input", content: [{ type: "text", text: "click search" }] }],
			tools: [{ type: "function", name: "click", description: "Click the page", parameters: { type: "object" } }],
		});
		expect(request).not.toHaveProperty("previous_interaction_id");
	});

	it("fails with a named catalog error when Google emits an excluded predefined function", async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({
			id: "interaction_excluded",
			status: "requires_action",
			steps: [{ type: "function_call", id: "call_excluded", name: "click", arguments: {} }],
		}), { status: 200, headers: { "content-type": "application/json" } }));
		vi.stubGlobal("fetch", fetch);

		const message = await google.streamGoogleInteractions(model, {
			messages: [{ role: "user", content: "take a screenshot", timestamp: 1 }],
			tools: [screenshotTool],
		}, { apiKey: "test", cuaIncomingToolPlan: screenshotIncoming }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe(
			'Google exact tool catalog rejected function "click"; selected Google native tools: "take_screenshot"; ordinary function tools: none',
		);
		expect(message.content).not.toContainEqual(expect.objectContaining({ type: "toolCall", name: "click" }));
		expect(message.errorMessage).not.toMatch(/Tool click not found/);
	});

	it("maps only the observed screenshot aliases when take_screenshot is selected", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
			id: "interaction_aliases",
			status: "requires_action",
			steps: [
				{ type: "function_call", id: "call_1", name: "screenshot:take_screenshot", arguments: {} },
				{ type: "function_call", id: "call_2", name: "computer:screenshot", arguments: {} },
				{ type: "function_call", id: "call_3", name: "custom_user_interpretation:screenshot", arguments: {} },
				{ type: "function_call", id: "call_4", name: "screenshot", arguments: {} },
			],
		}), { status: 200, headers: { "content-type": "application/json" } })));

		const message = await google.streamGoogleInteractions(model, {
			messages: [{ role: "user", content: "take screenshots", timestamp: 1 }],
			tools: [screenshotTool],
		}, { apiKey: "test", cuaIncomingToolPlan: screenshotIncoming }).result();

		expect(message.content.filter((content): content is ToolCall => content.type === "toolCall").map((call) => call.name)).toEqual([
			"take_screenshot",
			"take_screenshot",
			"take_screenshot",
			"take_screenshot",
		]);
	});

	it.each([
		"custom_user_interpretation:screenshot",
		"screenshot",
	])("rejects observed alias %s when take_screenshot is excluded", async (alias) => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
			id: "interaction_alias_excluded",
			status: "requires_action",
			steps: [{ type: "function_call", id: "call_1", name: alias, arguments: {} }],
		}), { status: 200, headers: { "content-type": "application/json" } })));

		const message = await google.streamGoogleInteractions(model, {
			messages: [{ role: "user", content: "click", timestamp: 1 }],
			tools: [clickTool],
		}, { apiKey: "test", cuaIncomingToolPlan: incoming }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe(
			`Google exact tool catalog rejected function "${alias}" (alias of "take_screenshot"); selected Google native tools: "click"; ordinary function tools: none`,
		);
		expect(message.content).toEqual([]);
	});

	it("normalizes whitespace before matching selected native names and aliases", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
			id: "interaction_whitespace",
			status: "requires_action",
			steps: [
				{ type: "function_call", id: "call_1", name: " take_screenshot\t", arguments: {} },
				{ type: "function_call", id: "call_2", name: "screenshot ", arguments: {} },
			],
		}), { status: 200, headers: { "content-type": "application/json" } })));

		const message = await google.streamGoogleInteractions(model, {
			messages: [{ role: "user", content: "take screenshots", timestamp: 1 }],
			tools: [screenshotTool],
		}, { apiKey: "test", cuaIncomingToolPlan: screenshotIncoming }).result();

		expect(message.content.filter((content): content is ToolCall => content.type === "toolCall").map((call) => call.name)).toEqual([
			"take_screenshot",
			"take_screenshot",
		]);
	});

	it("gives an ordinary caller screenshot tool precedence over the native alias", async () => {
		const ordinaryScreenshot = { name: "screenshot", description: "Caller screenshot", parameters: { type: "object" } as never };
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
			id: "interaction_ordinary",
			status: "requires_action",
			steps: [
				{ type: "function_call", id: "call_1", name: "screenshot", arguments: { full: true } },
				{ type: "function_call", id: "call_2", name: "screenshot ", arguments: { full: false } },
			],
		}), { status: 200, headers: { "content-type": "application/json" } })));

		const message = await google.streamGoogleInteractions(model, {
			messages: [{ role: "user", content: "call my function", timestamp: 1 }],
			tools: [ordinaryScreenshot, screenshotTool],
		}, { apiKey: "test", cuaIncomingToolPlan: screenshotIncoming }).result();

		expect(message.content.filter((content): content is ToolCall => content.type === "toolCall")).toEqual([
			expect.objectContaining({ name: "screenshot", arguments: { full: true } }),
			expect.objectContaining({ name: "screenshot", arguments: { full: false } }),
		]);
	});

	it("threads the stored interaction id and sends only function_result delta steps", async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({
			id: "interaction_2",
			status: "completed",
			steps: [{ type: "model_output", content: [{ type: "text", text: "Done" }] }],
		}), { status: 200 }));
		vi.stubGlobal("fetch", fetch);
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "click", arguments: { x: 1, y: 2 } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			responseId: "interaction_1",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 1,
		};

		const message = await google.streamGoogleInteractions(model, {
			messages: [
				{ role: "user", content: "click search", timestamp: 0 },
				assistant,
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "click",
					content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
					details: {},
					isError: false,
					timestamp: 2,
				},
			],
			tools: [clickTool],
		}, { apiKey: "test", cuaIncomingToolPlan: incoming }).result();

		expect(message.content).toContainEqual({ type: "text", text: "Done" });
		const request = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
		expect(request).toMatchObject({
			store: true,
			previous_interaction_id: "interaction_1",
			input: [{
				type: "function_result",
				call_id: "call_1",
				name: "click",
				is_error: false,
				result: [{ type: "image", data: "aW1hZ2U=", mime_type: "image/png" }],
			}],
		});
	});
});
