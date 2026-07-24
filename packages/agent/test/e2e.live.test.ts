import Kernel from "@onkernel/sdk";
import { describe, expect, it } from "vitest";
import {
	CuaAgent,
	CuaAgentHarness,
	InMemorySessionRepo,
	NodeExecutionEnv,
	type AgentEvent,
	type AgentHarnessEvent,
	type AgentMessage,
} from "../src/index";

const LIVE = process.env.CUA_E2E_LIVE === "1";
const KERNEL_API_KEY = process.env.KERNEL_API_KEY;

type ProviderCase = {
	name: string;
	apiKeyEnvVar: string;
	modelRef:
		| "openai:gpt-5.5"
		| "anthropic:claude-opus-5"
		| "google:gemini-3-flash-preview"
		| "meta:muse-spark-1.1"
		| "xai:grok-4.5"
		| "moonshotai:kimi-k3"
		| "tzafon:tzafon.northstar-cua-fast"
		| "yutori:n1.5-latest";
	prompt: string;
	expectToolCalls: boolean;
	expectReadArtifact?: boolean;
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
		modelRef: "openai:gpt-5.5",
		prompt: [
			"Use the tool named `screenshot` exactly once to inspect the browser.",
			"Pass empty arguments (`{}`).",
			"Do not call any other tools.",
			"After the tool result, provide a one-sentence summary.",
		].join("\n"),
		expectToolCalls: true,
		timeoutMs: 120_000,
		ciOptInEnvVar: "CUA_E2E_OPENAI",
	},
	{
		name: "anthropic",
		apiKeyEnvVar: "ANTHROPIC_API_KEY",
		modelRef: "anthropic:claude-opus-5",
		prompt: [
			"Use the tool named `screenshot` exactly once to inspect the browser.",
			"Pass empty arguments (`{}`).",
			"Do not call any other tools.",
			"After the tool result, provide a one-sentence summary.",
		].join("\n"),
		expectToolCalls: false,
		timeoutMs: 120_000,
		ciOptInEnvVar: "CUA_E2E_ANTHROPIC",
	},
	{
		name: "gemini",
		apiKeyEnvVar: "GOOGLE_API_KEY",
		modelRef: "google:gemini-3-flash-preview",
		prompt: [
			"Use the tool named `screenshot` exactly once to inspect the browser.",
			"Pass empty arguments (`{}`).",
			"Do not call any other tools.",
			"After the tool result, provide a one-sentence summary.",
		].join("\n"),
		expectToolCalls: true,
		timeoutMs: 300_000,
		ciOptInEnvVar: "CUA_E2E_GEMINI",
	},
	{
		name: "meta",
		apiKeyEnvVar: "META_API_KEY",
		modelRef: "meta:muse-spark-1.1",
		prompt: [
			"Use the tool named `screenshot` exactly once to inspect the browser.",
			"Pass empty arguments (`{}`).",
			"Do not call any other tools.",
			"After the tool result, provide a one-sentence summary.",
		].join("\n"),
		expectToolCalls: true,
		timeoutMs: 180_000,
	},
	{
		name: "xai",
		apiKeyEnvVar: "XAI_API_KEY",
		modelRef: "xai:grok-4.5",
		prompt: [
			"Use the tool named `screenshot` exactly once to inspect the browser.",
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
			"Use the tool named `screenshot` exactly once to inspect the browser.",
			"Pass empty arguments (`{}`).",
			"Do not call any other tools.",
			"After the tool result, provide a one-sentence summary.",
		].join("\n"),
		expectToolCalls: true,
		timeoutMs: 180_000,
	},
	{
		name: "tzafon",
		apiKeyEnvVar: "TZAFON_API_KEY",
		modelRef: "tzafon:tzafon.northstar-cua-fast",
		prompt: [
			"Use the tool named `screenshot` exactly once to inspect the browser.",
			"Pass empty arguments (`{}`).",
			"Do not call any other tools.",
			"After the tool result, provide a one-sentence summary.",
		].join("\n"),
		expectToolCalls: false,
		timeoutMs: 120_000,
		ciOptInEnvVar: "CUA_E2E_TZAFON",
	},
	{
		name: "yutori",
		apiKeyEnvVar: "YUTORI_API_KEY",
		modelRef: "yutori:n1.5-latest",
		prompt: [
			"Use the browser tools to open https://example.com exactly once.",
			"After the browser action result, do not call any more tools.",
		].join("\n"),
		expectToolCalls: true,
		expectReadArtifact: false,
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
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
		session: await sessionRepo.create({ id }),
	};
}

function assertStats(stats: RunStats, c: ProviderCase, runtimeName: "agent" | "harness"): void {
	const providerName = c.name;
	if (c.expectToolCalls) {
		expect(stats.toolCalls).toBeGreaterThan(0);
		expect(stats.toolResults).toBeGreaterThan(0);
		if (c.expectReadArtifact !== false) expect(stats.hasReadArtifact).toBe(true);
	}
	expect(stats.toolErrors, `${providerName}/${runtimeName} emitted tool errors: ${stats.toolErrors.join(" | ")}`).toHaveLength(0);
	expect(stats.assistantErrors, `${providerName}/${runtimeName} emitted assistant errors: ${stats.assistantErrors.join(" | ")}`).toHaveLength(0);
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

describe("Cua live e2e", () => {
	for (const c of cases) {
		const test = shouldRunCase(c) ? it : it.skip;

		test(
			`${c.name}: CuaAgent executes browser steps`,
			async () => {
				await withBrowser(async (client, browser) => {
					const stats = createRunStats();
					const agent = new CuaAgent({
						browser,
						client,
						getApiKey: () => apiKeyForCase(c),
						afterToolCall: async () => ({ terminate: true }),
						initialState: {
							model: c.modelRef,
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
			`${c.name}: CuaAgentHarness executes browser steps`,
			async () => {
				await withBrowser(async (client, browser) => {
					const stats = createRunStats();
					const harness = new CuaAgentHarness({
						...(await createHarnessServices(`${c.name}-harness`)),
						browser,
						client,
						model: c.modelRef,
						getApiKeyAndHeaders: async () => {
							const apiKey = apiKeyForCase(c);
							return apiKey ? { apiKey } : undefined;
						},
					});
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
			`${c.name}: CuaAgent switches models after a turn`,
			async () => {
				await withBrowser(async (client, browser) => {
					let stats = createRunStats();
					const agent = new CuaAgent({
						browser,
						client,
						getApiKey: (provider) => {
							if (provider === c.from.modelRef.split(":")[0]) return apiKeyForCase(c.from);
							if (provider === c.to.modelRef.split(":")[0]) return apiKeyForCase(c.to);
							return undefined;
						},
						initialState: {
							model: c.from.modelRef,
						},
					});
					agent.subscribe((event) => {
						recordRunEvent(stats, event);
					});

					await agent.prompt(c.from.prompt);
					assertStats(stats, c.from, "agent");

					stats = createRunStats();
					agent.state.model = c.to.modelRef;
					await agent.prompt(c.to.prompt);
					assertStats(stats, c.to, "agent");
				});
			},
			c.timeoutMs,
		);

		test(
			`${c.name}: CuaAgentHarness switches models after a turn`,
			async () => {
				await withBrowser(async (client, browser) => {
					let stats = createRunStats();
					const harness = new CuaAgentHarness({
						...(await createHarnessServices(`${c.name}-harness-switch`)),
						browser,
						client,
						model: c.from.modelRef,
						getApiKeyAndHeaders: async (model) => {
							if (model.provider === c.from.modelRef.split(":")[0]) {
								const apiKey = apiKeyForCase(c.from);
								return apiKey ? { apiKey } : undefined;
							}
							if (model.provider === c.to.modelRef.split(":")[0]) {
								const apiKey = apiKeyForCase(c.to);
								return apiKey ? { apiKey } : undefined;
							}
							return undefined;
						},
					});
					harness.subscribe((event) => {
						recordRunEvent(stats, event);
					});

					await harness.prompt(c.from.prompt);
					assertStats(stats, c.from, "harness");

					stats = createRunStats();
					await harness.setModel(c.to.modelRef);
					await harness.prompt(c.to.prompt);
					assertStats(stats, c.to, "harness");
				});
			},
			c.timeoutMs,
		);
	}
});
