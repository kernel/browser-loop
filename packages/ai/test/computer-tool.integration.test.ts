import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CUA_ACTION_TYPES,
	type Context,
	type CuaActionType,
	type CuaProvider,
	anthropic,
	cuaModels,
	gemini,
	getCuaEnvApiKey,
	getCuaModel,
	meta,
	openai,
	tzafon,
	xai,
	yutori,
} from "../src/index";

const screenshotPath = [
	join(process.cwd(), "examples", "screenshot.png"),
	join(process.cwd(), "packages", "ai", "examples", "screenshot.png"),
].find(existsSync);

if (!screenshotPath) throw new Error("could not find packages/ai/examples/screenshot.png");

interface ProviderCase {
	provider: CuaProvider;
	envVar: string;
	modelRef: string;
	tools: () => ReturnType<typeof openai.computerTools>;
	coordinateRange: readonly [number, number];
	requireToolCalls: boolean;
	systemPrompt?: string;
	ciOptInEnvVar?: string;
	extraOptions?: Record<string, unknown>;
}

const cases: ProviderCase[] = [
	{
		provider: "openai",
		envVar: "OPENAI_API_KEY",
		modelRef: "openai:gpt-5.5",
		tools: () => openai.computerTools({ actions: ["click"] }),
		coordinateRange: [0, 1920],
		requireToolCalls: true,
	},
	{
		provider: "anthropic",
		envVar: "ANTHROPIC_API_KEY",
		modelRef: "anthropic:claude-opus-4-7",
		tools: () => anthropic.computerTools({ actions: ["click"] }),
		coordinateRange: [0, 1920],
		requireToolCalls: true,
		extraOptions: { toolChoice: { type: "tool", name: "click" } },
	},
	{
		provider: "google",
		envVar: "GOOGLE_API_KEY",
		modelRef: "google:gemini-3-flash-preview",
		tools: () => gemini.computerTools({ actions: ["click"] }),
		coordinateRange: [0, 999],
		requireToolCalls: true,
	},
	{
		provider: "xai",
		envVar: "XAI_API_KEY",
		modelRef: "xai:grok-4.5",
		tools: () => xai.computerTools({ actions: ["click"] }),
		coordinateRange: [0, 1000],
		requireToolCalls: true,
		systemPrompt: "Coordinates are normalized from 0 to 1000 relative to the screenshot.",
		extraOptions: { reasoningEffort: "off" },
	},
	{
		provider: "tzafon",
		envVar: "TZAFON_API_KEY",
		modelRef: "tzafon:tzafon.northstar-cua-fast",
		tools: () => tzafon.computerTools({ actions: ["click"] }),
		coordinateRange: [0, 999],
		requireToolCalls: false,
		ciOptInEnvVar: "CUA_E2E_TZAFON",
	},
];

async function buildContext(c: ProviderCase): Promise<Context> {
	const screenshot = await readFile(screenshotPath);
	return {
		systemPrompt: [
			"You are controlling a browser from a screenshot.",
			"Call the available click tool for the sign in / up link.",
			c.systemPrompt,
		].filter(Boolean).join("\n"),
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "Click the sign in / up link in this Kernel homepage screenshot." },
					{ type: "image", data: screenshot.toString("base64"), mimeType: "image/png" },
				],
				timestamp: Date.now(),
			},
		],
		tools: c.tools(),
	};
}

async function buildYutoriContext(): Promise<Context> {
	const screenshot = await readFile(screenshotPath);
	return {
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "Click the sign in / up link in this Kernel homepage screenshot." },
					{ type: "image", data: screenshot.toString("base64"), mimeType: "image/png" },
				],
				timestamp: Date.now(),
			},
		],
		tools: yutori.computerTools(),
	};
}

function apiKeyForCase(c: ProviderCase): string | undefined {
	return c.provider === "meta" ? getCuaEnvApiKey("meta") : process.env[c.envVar];
}

describe("individual computer action integration", () => {
	for (const c of cases) {
		const hasKey = !!apiKeyForCase(c);
		const ciEnabled = !c.ciOptInEnvVar || !process.env.CI || process.env[c.ciOptInEnvVar] === "1";
		const test = hasKey ? it : it.skip;

		(ciEnabled ? test : it.skip)(`${c.provider} returns a canonical click tool call`, async () => {
			const model = getCuaModel(c.modelRef as never);
			const context = await buildContext(c);
			const response = await cuaModels().complete(model, context, {
				apiKey: apiKeyForCase(c),
				maxTokens: 1024,
				...c.extraOptions,
			});

			const toolCalls = response.content.filter((part) => part.type === "toolCall");
			if (toolCalls.length === 0) {
				if (c.requireToolCalls) {
					expect(toolCalls.length, `${c.provider} returned no tool calls`).toBeGreaterThan(0);
				}
				expect(response.usage.totalTokens, `${c.provider} usage tokens not reported`).toBeGreaterThanOrEqual(0);
				return;
			}

			const click = toolCalls.find((call) => call.name === "click");
			expect(click, `${c.provider} did not return click; got [${toolCalls.map((call) => call.name).join(", ")}]`).toBeDefined();
			expect(typeof click!.arguments.x).toBe("number");
			expect(typeof click!.arguments.y).toBe("number");
			const [min, max] = c.coordinateRange;
			expect(click!.arguments.x as number, `${c.provider} x out of range`).toBeGreaterThanOrEqual(min);
			expect(click!.arguments.x as number).toBeLessThanOrEqual(max);
			expect(click!.arguments.y as number, `${c.provider} y out of range`).toBeGreaterThanOrEqual(min);
			expect(click!.arguments.y as number).toBeLessThanOrEqual(max);
			expect(response.usage.totalTokens, `${c.provider} usage tokens not reported`).toBeGreaterThan(0);
		}, 60_000);
	}

	const metaApiKey = getCuaEnvApiKey("meta");
	(metaApiKey ? it : it.skip)(
		"meta continues a screenshot tool loop with previous_response_id",
		async () => {
			const screenshot = await readFile(screenshotPath);
			const model = getCuaModel("meta:muse-spark-1.1");
			const tools = meta.computerTools({ actions: ["click"] });
			const context: Context = {
				systemPrompt: "Use normalized 0-1000 coordinates. Call click exactly once, then answer in text after its result.",
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Click the sign in / up link. After the tool result, report that the click completed without calling another tool." },
							{ type: "image", data: screenshot.toString("base64"), mimeType: "image/png" },
						],
						timestamp: Date.now(),
					},
				],
				tools,
			};
			const first = await cuaModels().complete(model, context, {
				apiKey: metaApiKey,
				maxTokens: 1024,
			});
			const click = first.content.find((part) => part.type === "toolCall" && part.name === "click");
			expect(click).toBeDefined();
			expect(typeof click!.arguments.x).toBe("number");
			expect(typeof click!.arguments.y).toBe("number");
			expect(click!.arguments.x as number).toBeGreaterThanOrEqual(0);
			expect(click!.arguments.x as number).toBeLessThanOrEqual(1000);
			expect(click!.arguments.y as number).toBeGreaterThanOrEqual(0);
			expect(click!.arguments.y as number).toBeLessThanOrEqual(1000);
			expect(first.responseId).toBeTruthy();
			context.messages.push(first, {
				role: "toolResult",
				toolCallId: click!.id,
				toolName: click!.name,
				content: [
					{ type: "text", text: "Click executed successfully." },
					{ type: "image", data: screenshot.toString("base64"), mimeType: "image/png" },
				],
				isError: false,
				timestamp: Date.now(),
			});

			let payload: Record<string, unknown> | undefined;
			const second = await cuaModels().complete(model, context, {
				apiKey: metaApiKey,
				maxTokens: 1024,
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
				},
			});
			expect(second.stopReason).not.toBe("error");
			expect(second.responseId).toBeTruthy();
			expect(payload?.previous_response_id).toBe(first.responseId);
			expect(payload?.store).toBe(true);
			expect(payload?.parallel_tool_calls).toBe(false);
			expect(payload?.include).toBeUndefined();
		},
		90_000,
	);

	const xaiApiKey = getCuaEnvApiKey("xai");
	(xaiApiKey ? it : it.skip)(
		"xai continues a screenshot tool loop with previous_response_id",
		async () => {
			const screenshot = await readFile(screenshotPath);
			const model = getCuaModel("xai:grok-4.5");
			const tools = xai.computerTools({ actions: ["click"] });
			const context: Context = {
				systemPrompt: "Use normalized 0-1000 coordinates. Call click exactly once, then answer in text after its result.",
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Click the sign in / up link. After the tool result, report that the click completed without calling another tool." },
							{ type: "image", data: screenshot.toString("base64"), mimeType: "image/png" },
						],
						timestamp: Date.now(),
					},
				],
				tools,
			};
			const first = await cuaModels().complete(model, context, {
				apiKey: xaiApiKey,
				maxTokens: 1024,
				reasoningEffort: "off",
			});
			const click = first.content.find((part) => part.type === "toolCall" && part.name === "click");
			expect(click).toBeDefined();
			expect(first.responseId).toBeTruthy();
			context.messages.push(first, {
				role: "toolResult",
				toolCallId: click!.id,
				toolName: click!.name,
				content: [
					{ type: "text", text: "Click executed successfully." },
					{ type: "image", data: screenshot.toString("base64"), mimeType: "image/png" },
				],
				isError: false,
				timestamp: Date.now(),
			});

			let payload: Record<string, unknown> | undefined;
			const second = await cuaModels().complete(model, context, {
				apiKey: xaiApiKey,
				maxTokens: 1024,
				reasoningEffort: "off",
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
				},
			});
			expect(second.stopReason).not.toBe("error");
			expect(second.responseId).toBeTruthy();
			expect(payload?.previous_response_id).toBe(first.responseId);
			expect(payload?.store).toBe(true);
			expect(payload?.parallel_tool_calls).toBe(false);
			expect(payload?.reasoning).toEqual({ effort: "low", summary: "auto" });
			expect(payload?.include).toEqual(["reasoning.encrypted_content"]);
		},
		90_000,
	);

	const yutoriHasKey = !!process.env.YUTORI_API_KEY;
	(yutoriHasKey ? it : it.skip)(
		"yutori translates native tool calls into canonical individual actions",
		async () => {
			const model = getCuaModel("yutori:n1.5-latest");
			const context = await buildYutoriContext();
			const response = await cuaModels().complete(model, context, {
				apiKey: process.env.YUTORI_API_KEY,
				maxTokens: 1024,
			});

			const toolCalls = response.content.filter((part) => part.type === "toolCall");
			expect(toolCalls.length, "yutori did not emit translated canonical tool calls").toBeGreaterThan(0);
			expect(CUA_ACTION_TYPES).toContain(toolCalls[0]!.name as CuaActionType);
		},
		60_000,
	);
});
