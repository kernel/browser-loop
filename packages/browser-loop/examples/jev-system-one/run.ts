import { spawn } from "node:child_process";
import Kernel from "@onkernel/sdk";
import { LoopExecutionResources } from "../../src/core/resources";
import { runAgent } from "./agent";
import { ExecutorBrowserRuntime } from "./browser";
import { SystemOneJevPolicy } from "./models";
import { OpenAICompatibleTextResolver } from "./text";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const goal = arg("--task");
if (!goal) {
	console.error('usage: npm run run -- --task "Open https://example.com and follow the More information link"');
	process.exit(2);
}
const kernelApiKey = process.env.KERNEL_API_KEY;
if (!kernelApiKey) throw new Error("KERNEL_API_KEY is required");

const client = new Kernel({ apiKey: kernelApiKey });
const browser = await client.browsers.create({ stealth: true });
if (browser.browser_live_view_url) {
	console.error(`live view: ${browser.browser_live_view_url}`);
	openLiveView(browser.browser_live_view_url);
}
const resources = new LoopExecutionResources({ client, browser });

try {
	const result = await runAgent({
		goal,
		browser: new ExecutorBrowserRuntime(resources.browserExecutor()),
		policy: new SystemOneJevPolicy(),
		textResolver: new OpenAICompatibleTextResolver(),
		onDecision: (trace) => {
			const confidence = [
				`operation=${percent(trace.operationConfidence)}`,
				...(trace.targetConfidence === undefined ? [] : [`target=${percent(trace.targetConfidence)}`]),
			].join(" ");
			console.error(
				`[step ${trace.step + 1}] jev=${Math.round(trace.latencyMs)}ms model=${trace.model} tokens=${trace.inputTokens}/${trace.outputTokens} ${confidence} ${trace.operation} ${JSON.stringify(trace.label)}`,
			);
		},
		onFreshness: (trace) => {
			console.error(
				`[step ${trace.step}] freshness=${Math.round(trace.latencyMs)}ms changed=${trace.changed}`,
			);
		},
		onAction: (trace) => {
			console.error(
				`[step ${trace.step}] action=${Math.round(trace.latencyMs)}ms resolve=${Math.round(trace.resolveMs)}ms execute=${Math.round(trace.executeMs)}ms observe=${Math.round(trace.observeMs)}ms ${trace.operation} ${JSON.stringify(trace.label)} changed=${trace.pageChanged} url=${trace.url}`,
			);
		},
	});
	console.error(
		`[result] status=${result.status} elapsed=${Math.round(result.wallMs)}ms steps=${result.steps.length} url=${result.finalObservation.url} reason=${JSON.stringify(result.reason)}`,
	);
} finally {
	await resources.dispose();
	await client.browsers.deleteByID(browser.session_id);
}

function openLiveView(url: string): void {
	if (process.platform !== "darwin" || !process.stderr.isTTY) return;
	spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}
