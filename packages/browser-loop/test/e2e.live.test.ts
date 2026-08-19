import Kernel from "@onkernel/sdk";
import { describe, expect, it } from "vitest";
import {
	Agent,
	type AgentEvent,
	AgentHarness,
	type AgentHarnessEvent,
	type AgentMessage,
	InMemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import { attach } from "../src/pi/index";
import { loop } from "../src/index";

const LIVE = process.env.LOOP_E2E_LIVE === "1";
const KERNEL_API_KEY = process.env.KERNEL_API_KEY;

type ProviderCase = {
	name: "openai" | "anthropic" | "gemini" | "xai" | "moonshotai";
	apiKeyEnvVar: string;
	modelRef:
		| "openai:gpt-5.6-sol"
		| "anthropic:claude-opus-5"
		| "google:gemini-3.6-flash"
		| "xai:grok-4.5"
		| "moonshotai:kimi-k3";
	prompt: string;
	expectToolCalls: boolean;
	timeoutMs: number;
	ciOptInEnvVar?: string;
};

type ModelSwitchCase = {
	name: string;
	from: ProviderCase;
	to: ProviderCase;
	timeoutMs: number;
};

const cases: ProviderCase[] = [
	{
		name: "openai",
		apiKeyEnvVar: "OPENAI_API_KEY",
		modelRef: "openai:gpt-5.6-sol",
		prompt: [
			"Use the tool named `browser_screenshot` exactly once to inspect the browser.",
			"Pass empty arguments (`{}`).",
			"Do not call any other tools.",
			"After the tool result, provide a one-sentence summary.",
		].join("\n"),
		expectToolCalls: true,
		timeoutMs: 120_000,
		ciOptInEnvVar: "LOOP_E2E_OPENAI",
	},
	{
		name: "anthropic",
		apiKeyEnvVar: "ANTHROPIC_API_KEY",
		modelRef: "anthropic:claude-opus-5",
		prompt: [
			"Use the native `browser` tool's `screenshot` action exactly once.",
			"Do not call any other tools.",
			"After the tool result, provide a one-sentence summary.",
		].join("\n"),
		expectToolCalls: true,
		timeoutMs: 120_000,
		ciOptInEnvVar: "LOOP_E2E_ANTHROPIC",
	},
	{
		name: "gemini",
		apiKeyEnvVar: "GOOGLE_API_KEY",
		modelRef: "google:gemini-3.6-flash",
		prompt: [
			"Use the predefined `take_screenshot` browser action exactly once.",
			"Do not call any other tools.",
			"After the tool result, provide a one-sentence summary.",
		].join("\n"),
		expectToolCalls: true,
		timeoutMs: 300_000,
		ciOptInEnvVar: "LOOP_E2E_GEMINI",
	},
	{
		name: "xai",
		apiKeyEnvVar: "XAI_API_KEY",
		modelRef: "xai:grok-4.5",
		prompt: [
			"Use the tool named `browser_screenshot` exactly once to inspect the browser.",
			"Pass empty arguments (`{}`).",
			"Do not call any other tools.",
			"After the tool result, provide a one-sentence summary.",
		].join("\n"),
		expectToolCalls: true,
		timeoutMs: 180_000,
	},
	{
		name: "moonshotai",
		apiKeyEnvVar: "MOONSHOT_API_KEY",
		modelRef: "moonshotai:kimi-k3",
		prompt: [
			"Use the tool named `browser_screenshot` exactly once to inspect the browser.",
			"Pass empty arguments (`{}`).",
			"Do not call any other tools.",
			"After the tool result, provide a one-sentence summary.",
		].join("\n"),
		expectToolCalls: true,
		timeoutMs: 180_000,
	},
];

const switchCases: ModelSwitchCase[] = [
	{
		name: "openai-to-gemini",
		from: cases[0]!,
		to: cases[2]!,
		timeoutMs: 420_000,
	},
];

type RunStats = {
	toolCalls: number;
	toolResults: number;
	hasReadArtifact: boolean;
	finalAssistant?: AgentMessage;
	toolErrors: string[];
	assistantErrors: string[];
};

function apiKeyForCase(c: ProviderCase): string | undefined {
	return process.env[c.apiKeyEnvVar];
}

function shouldRunCase(c: ProviderCase): boolean {
	if (!LIVE) return false;
	if (!KERNEL_API_KEY) return false;
	if (c.ciOptInEnvVar && process.env.CI && process.env[c.ciOptInEnvVar] !== "1") return false;
	return Boolean(apiKeyForCase(c));
}

function shouldRunSwitchCase(c: ModelSwitchCase): boolean {
	return shouldRunCase(c.from) && shouldRunCase(c.to);
}

function structuredBrowserTools() {
	return [...loop.toolsets.browser(), loop.tools.browser.act()];
}

function toolsForCase(c: ProviderCase) {
	switch (c.name) {
		case "openai":
		case "xai":
			return structuredBrowserTools();
		case "moonshotai":
			// Moonshot's API rejects `browser_act`'s schema; Kimi runs primitives only.
			return loop.toolsets.browser();
		case "anthropic":
			return [loop.providers.anthropic.tools.browser({ version: "20260701", javascript: true })];
		case "gemini":
			return loop.providers.google.toolsets.browser();
	}
}

function systemPromptForCase(_case: ProviderCase): string {
	return "Use only the explicitly selected browser interaction tools.";
}

const modelSwitchPrompt = [
	"Use the tool named `screenshot` exactly once to inspect the browser.",
	"Pass empty arguments (`{}`).",
	"Do not call any other tools.",
	"After the tool result, provide a one-sentence summary.",
].join("\n");

function modelSwitchTools() {
	return [loop.tools.computer.screenshot({ name: "screenshot" })];
}

function createRunStats(): RunStats {
	return { toolCalls: 0, toolResults: 0, hasReadArtifact: false, toolErrors: [], assistantErrors: [] };
}

async function withBrowser<T>(run: (client: Kernel, browser: Awaited<ReturnType<Kernel["browsers"]["create"]>>) => Promise<T>): Promise<T> {
	if (!KERNEL_API_KEY) {
		throw new Error("KERNEL_API_KEY is required");
	}
	const client = new Kernel({ apiKey: KERNEL_API_KEY });
	const browser = await client.browsers.create({ stealth: true });
	try {
		return await run(client, browser);
	} finally {
		await client.browsers.deleteByID(browser.session_id).catch(() => {});
	}
}

async function createHarnessServices(id: string) {
	const sessionRepo = new InMemorySessionRepo();
	return {
		session: await sessionRepo.create({ id }),
	};
}

function assertStats(stats: RunStats, c: ProviderCase, runtimeName: "agent" | "harness"): void {
	const providerName = c.name;
	// Provider/transport errors are asserted before the tool-call counts: an API
	// rejection also yields zero tool calls, and only these carry a message that
	// explains why.
	expect(stats.toolErrors, `${providerName}/${runtimeName} emitted tool errors: ${stats.toolErrors.join(" | ")}`).toHaveLength(0);
	expect(stats.assistantErrors, `${providerName}/${runtimeName} emitted assistant errors: ${stats.assistantErrors.join(" | ")}`).toHaveLength(0);
	if (c.expectToolCalls) {
		expect(stats.toolCalls).toBeGreaterThan(0);
		expect(stats.toolResults).toBeGreaterThan(0);
		expect(stats.hasReadArtifact).toBe(true);
	}
	expect(stats.finalAssistant).toBeDefined();
	if (stats.finalAssistant?.role === "assistant") {
		expect(stats.finalAssistant.stopReason, `${providerName}/${runtimeName} ended in assistant error`).not.toBe("error");
		expect(stats.finalAssistant.stopReason, `${providerName}/${runtimeName} ended in assistant abort`).not.toBe("aborted");
	}
}

function recordRunEvent(stats: RunStats, event: AgentEvent | AgentHarnessEvent): void {
	if (event.type === "tool_execution_start") stats.toolCalls += 1;
	if (event.type === "tool_execution_end" && event.isError) {
		stats.toolErrors.push(`${event.toolName}: ${toolErrorMessage(event.result) ?? "failed"}`);
	}
	if (event.type === "message_end" && event.message.role === "toolResult") {
		stats.toolResults += 1;
		if (
			event.message.content.some(
				(block) => block.type === "image" || (block.type === "text" && /url\(\)|Current URL:/.test(block.text)),
			)
		) {
			stats.hasReadArtifact = true;
		}
	}
	if (event.type === "message_end" && event.message.role === "assistant") {
		stats.finalAssistant = event.message;
		if (event.message.errorMessage) {
			stats.assistantErrors.push(event.message.errorMessage);
		}
	}
}

function toolErrorMessage(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const current = result as { details?: unknown; content?: unknown[] };
	const details = current.details as { error?: string; statusText?: string } | undefined;
	if (details?.error) return details.error;
	if (details?.statusText) return details.statusText;
	const text = current.content
		?.map((block) => {
			if (!block || typeof block !== "object") return undefined;
			const item = block as { type?: unknown; text?: unknown };
			return item.type === "text" && typeof item.text === "string" ? item.text : undefined;
		})
		.filter((text): text is string => Boolean(text))
		.join(" ");
	return text || undefined;
}

describe("Loop live e2e", () => {
	for (const c of cases) {
		const test = shouldRunCase(c) ? it : it.skip;

		test(
			`${c.name}: a plain pi Agent executes browser steps`,
			async () => {
				await withBrowser(async (client, browser) => {
					const stats = createRunStats();
					const compiled = attach({ browser, client }).compile({ model: c.modelRef, tools: toolsForCase(c) });
					const agent = new Agent({
						streamFn: (model, context, options) => compiled.models.streamSimple(model, context, options),
						afterToolCall: async () => ({ terminate: true }),
						initialState: {
							model: compiled.model,
							tools: [...compiled.agentTools],
							systemPrompt: systemPromptForCase(c),
						},
					});
					agent.subscribe((event) => {
						recordRunEvent(stats, event);
					});

					await agent.prompt(c.prompt);
					assertStats(stats, c, "agent");
				});
			},
			c.timeoutMs,
		);

		test(
			`${c.name}: a plain pi AgentHarness executes browser steps`,
			async () => {
				await withBrowser(async (client, browser) => {
					const stats = createRunStats();
					const compiled = attach({ browser, client }).compile({ model: c.modelRef, tools: toolsForCase(c) });
					const harness = new AgentHarness({
						...(await createHarnessServices(`${c.name}-harness`)),
						model: compiled.model,
						models: compiled.models,
						tools: [...compiled.tools],
						activeToolNames: compiled.tools.map((tool) => tool.name),
						systemPrompt: systemPromptForCase(c),
					});
					compiled.activate(harness);
					harness.on("tool_result", () => ({ terminate: true }));

					harness.subscribe((event) => {
						recordRunEvent(stats, event);
					});

					await harness.prompt(c.prompt);
					assertStats(stats, c, "harness");
				});
			},
			c.timeoutMs,
		);
	}

	for (const c of switchCases) {
		const test = shouldRunSwitchCase(c) ? it : it.skip;

		test(
			`${c.name}: a plain pi Agent switches models after a turn`,
			async () => {
				await withBrowser(async (client, browser) => {
					let stats = createRunStats();
					const handle = attach({ browser, client });
					const from = handle.compile({ model: c.from.modelRef, tools: modelSwitchTools() });
					const agent = new Agent({
						streamFn: (model, context, options) => handle.models.streamSimple(model, context, options),
						initialState: {
							model: from.model,
							tools: [...from.agentTools],
							systemPrompt: "Use only the explicitly selected screenshot tool.",
						},
					});
					agent.subscribe((event) => {
						recordRunEvent(stats, event);
					});

					await agent.prompt(modelSwitchPrompt);
					assertStats(stats, c.from, "agent");

					// A switch recompiles: the new model carries the transport its
					// tools derive, and its executables replace the old pair.
					stats = createRunStats();
					const to = handle.compile({ model: c.to.modelRef, tools: modelSwitchTools() });
					agent.state.model = to.model;
					agent.state.tools = [...to.agentTools];
					await agent.prompt(modelSwitchPrompt);
					assertStats(stats, c.to, "agent");
				});
			},
			c.timeoutMs,
		);

		test(
			`${c.name}: a plain pi AgentHarness switches models after a turn`,
			async () => {
				await withBrowser(async (client, browser) => {
					let stats = createRunStats();
					const handle = attach({ browser, client });
					const from = handle.compile({ model: c.from.modelRef, tools: modelSwitchTools() });
					const harness = new AgentHarness({
						...(await createHarnessServices(`${c.name}-harness-switch`)),
						model: from.model,
						models: from.models,
						tools: [...from.tools],
						activeToolNames: from.tools.map((tool) => tool.name),
						systemPrompt: "Use only the explicitly selected screenshot tool.",
					});
					from.activate(harness);
					harness.subscribe((event) => {
						recordRunEvent(stats, event);
					});

					await harness.prompt(modelSwitchPrompt);
					assertStats(stats, c.from, "harness");

					stats = createRunStats();
					await handle.compile({ model: c.to.modelRef, tools: modelSwitchTools() }).apply(harness);
					await harness.prompt(modelSwitchPrompt);
					assertStats(stats, c.to, "harness");
				});
			},
			c.timeoutMs,
		);
	}
});
