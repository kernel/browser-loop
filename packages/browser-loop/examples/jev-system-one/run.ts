import { runAgent } from "./agent";
import { launchBrowser } from "./browser";
import type { AgentMode } from "./types";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const url = arg("--url");
const task = arg("--task");
const mode = (arg("--mode") ?? "jev-only") as AgentMode;
if (!url || !task || !["jev-only", "hybrid"].includes(mode)) {
	console.error('usage: tsx run.ts --url https://example.com --task "open the More information link" --mode jev-only|hybrid');
	process.exit(2);
}

const browser = await launchBrowser();
try {
	const context = await browser.newContext({ ignoreHTTPSErrors: true });
	const page = await context.newPage();
	await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
	const result = await runAgent(page, task, mode);
	console.log(JSON.stringify({ ...result, finalURL: page.url() }, null, 2));
	await context.close();
} finally {
	await browser.close();
}
