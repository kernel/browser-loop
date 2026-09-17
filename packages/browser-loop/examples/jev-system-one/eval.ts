import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Page } from "playwright-core";
import { runAgent } from "./agent";
import { launchBrowser } from "./browser";
import { startFixtureServer } from "./fixture-server";
import type { AgentMode, AgentResult } from "./types";

interface EvalCase {
	name: string;
	path?: string;
	url?: string;
	task: string;
	public?: boolean;
	verify(page: Page, result: AgentResult): Promise<boolean>;
}

interface EvalRecord {
	case: string;
	mode: AgentMode;
	repeat: number;
	success: boolean;
	status: AgentResult["status"];
	reason?: string;
	answer?: string;
	steps: number;
	wallMs: number;
	jevCalls: number;
	jevInputTokens: number;
	jevOutputTokens: number;
	jevLatencyMs: number;
	jevCostUsd: number;
	plannerCalls: number;
	plannerInputTokens: number;
	plannerOutputTokens: number;
	plannerLatencyMs: number;
	plannerCostUsd: number;
	trace: AgentResult["steps"];
}

const cases: EvalCase[] = [
	{
		name: "single-safe-click",
		path: "/buttons",
		task: "Continue the workflow. Do not delete anything or save a draft.",
		verify: successFlag,
	},
	{
		name: "two-field-form",
		path: "/contact",
		task: "Fill Full name with \"Ada Lovelace\" and Work email with \"ada@example.com\", then submit.",
		verify: successFlag,
	},
	{
		name: "select-and-checkbox",
		path: "/preferences",
		task: "Choose the Dark theme, enable Weekly updates, and apply the preferences.",
		verify: successFlag,
	},
	{
		name: "semantic-comparison",
		path: "/catalog",
		task: "Add the least expensive item that is in stock to the cart.",
		verify: successFlag,
	},
	{
		name: "multi-page-wizard",
		path: "/wizard",
		task: "Complete setup on the Pro plan and accept the test terms.",
		verify: successFlag,
	},
	{
		name: "search-and-result",
		path: "/search",
		task: "Search for \"kernel browser\" and open the result titled Browser Infrastructure.",
		verify: successFlag,
	},
	{
		name: "dynamic-reveal",
		path: "/reveal",
		task: "Reveal the available regions, then select West.",
		verify: successFlag,
	},
	{
		name: "bounded-extraction",
		path: "/confirmation",
		task: "What is the confirmation code?",
		verify: async (_page, result) => result.status === "completed" && result.answer === "KRN-48291",
	},
	{
		name: "open-ended-summary",
		path: "/article",
		task: "Summarize the article in two concise sentences.",
		verify: async (_page, result) => {
			const answer = result.answer?.toLowerCase() ?? "";
			return result.status === "completed" && answer.includes("action") && answer.includes("planner") && (answer.includes("prose") || answer.includes("synth"));
		},
	},
	{
		name: "public-example-navigation",
		url: "https://example.com",
		task: "Open the Learn more link and stop on its destination page.",
		public: true,
		verify: async (page, result) => result.status === "completed" && /iana\.org/.test(page.url()),
	},
	{
		name: "public-hn-navigation",
		url: "https://news.ycombinator.com",
		task: "Open the newest submissions page using the new link.",
		public: true,
		verify: async (page, result) => result.status === "completed" && /\/newest(?:$|\?)/.test(page.url()),
	},
];

async function successFlag(page: Page, result: AgentResult): Promise<boolean> {
	return result.status === "completed" && await page.evaluate("document.body.dataset.success === 'true'");
}

function numberArg(name: string, fallback: number): number {
	const index = process.argv.indexOf(name);
	return index >= 0 ? Number.parseInt(process.argv[index + 1] ?? "", 10) || fallback : fallback;
}

function stringArg(name: string, fallback: string): string {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

async function main(): Promise<void> {
	const repeats = numberArg("--repeat", 3);
	const includePublic = process.argv.includes("--public");
	const modeArg = stringArg("--mode", "both");
	const modes: AgentMode[] = modeArg === "both" ? ["jev-only", "hybrid"] : [modeArg as AgentMode];
	const output = resolve(stringArg("--output", "artifacts/jev-eval.json"));
	const caseFilter = stringArg("--case", "");
	const server = await startFixtureServer();
	const browser = await launchBrowser();
	const records: EvalRecord[] = [];
	try {
		for (const evalCase of cases.filter((item) => (includePublic || !item.public) && (!caseFilter || item.name === caseFilter))) {
			const caseRepeats = evalCase.public ? 1 : repeats;
			for (const mode of modes) {
				for (let repeat = 0; repeat < caseRepeats; repeat++) {
					const context = await browser.newContext({ ignoreHTTPSErrors: true });
					const page = await context.newPage();
					try {
						await page.goto(evalCase.url ?? `${server.baseURL}${evalCase.path}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
						const result = await runAgent(page, evalCase.task, mode);
						const success = await evalCase.verify(page, result);
						const record: EvalRecord = {
							case: evalCase.name,
							mode,
							repeat,
							success,
							status: result.status,
							reason: result.reason,
							answer: result.answer,
							steps: result.steps.length,
							wallMs: result.wallMs,
							jevCalls: result.usage.jev.calls,
							jevInputTokens: result.usage.jev.inputTokens,
							jevOutputTokens: result.usage.jev.outputTokens,
							jevLatencyMs: result.usage.jev.latencyMs,
							jevCostUsd: result.usage.jev.costUsd,
							plannerCalls: result.usage.planner.calls,
							plannerInputTokens: result.usage.planner.inputTokens,
							plannerOutputTokens: result.usage.planner.outputTokens,
							plannerLatencyMs: result.usage.planner.latencyMs,
							plannerCostUsd: result.usage.planner.costUsd,
							trace: result.steps,
						};
						records.push(record);
						console.log(`${success ? "PASS" : "FAIL"} ${mode.padEnd(8)} ${evalCase.name} #${repeat + 1} ${result.status} ${result.steps.length} steps ${result.wallMs.toFixed(0)}ms`);
					} catch (error) {
						console.error(`ERROR ${mode} ${evalCase.name}:`, error);
						records.push({
							case: evalCase.name, mode, repeat, success: false, status: "failed", reason: String(error), steps: 0, wallMs: 0,
							jevCalls: 0, jevInputTokens: 0, jevOutputTokens: 0, jevLatencyMs: 0, jevCostUsd: 0,
							plannerCalls: 0, plannerInputTokens: 0, plannerOutputTokens: 0, plannerLatencyMs: 0, plannerCostUsd: 0, trace: [],
						});
					} finally {
						await context.close();
					}
				}
			}
		}
	} finally {
		await browser.close();
		await server.close();
	}

	await mkdir(dirname(output), { recursive: true });
	await writeFile(output, `${JSON.stringify({ generatedAt: new Date().toISOString(), repeats, includePublic, records }, null, 2)}\n`);
	printSummary(records);
	console.log(`\nraw results: ${output}`);
}

function printSummary(records: EvalRecord[]): void {
	console.log("\nmode       passed total success  p50 wall  p50 Jev  input tok  cost");
	for (const mode of ["jev-only", "hybrid"] as const) {
		const rows = records.filter((row) => row.mode === mode);
		if (!rows.length) continue;
		const sortedWall = rows.map((row) => row.wallMs).sort((a, b) => a - b);
		const sortedJev = rows.flatMap((row) => row.trace.map((step) => step.latencyMs)).sort((a, b) => a - b);
		const passed = rows.filter((row) => row.success).length;
		const tokens = rows.reduce((sum, row) => sum + row.jevInputTokens + row.plannerInputTokens, 0);
		const cost = rows.reduce((sum, row) => sum + row.jevCostUsd + row.plannerCostUsd, 0);
		const median = (values: number[]) => values[Math.floor(values.length / 2)] ?? 0;
		console.log(`${mode.padEnd(10)} ${String(passed).padStart(6)} ${String(rows.length).padStart(5)} ${(passed / rows.length * 100).toFixed(1).padStart(6)}% ${median(sortedWall).toFixed(0).padStart(8)}ms ${median(sortedJev).toFixed(0).padStart(7)}ms ${String(tokens).padStart(10)} $${cost.toFixed(6)}`);
	}
}

await main();
