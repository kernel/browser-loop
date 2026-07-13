#!/usr/bin/env tsx
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

type Provider = "openai" | "anthropic" | "gemini" | "meta" | "xai" | "yutori";

interface ExampleRepo {
	provider: Provider;
	name: string;
	repo: string;
	confidence: string;
	pathHint?: string;
	patterns: string[];
}

interface Args {
	cache: string;
	out: string;
	noUpdate: boolean;
}

interface GitResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

const EXAMPLES: ExampleRepo[] = [
	{
		provider: "openai",
		name: "openai-cua-sample-app",
		repo: "https://github.com/openai/openai-cua-sample-app.git",
		confidence: "provider-owned",
		patterns: ["computer_call", "computer_call_output", "actions", "pending_safety_checks", "computer_use_preview"],
	},
	{
		provider: "anthropic",
		name: "anthropic-quickstarts",
		repo: "https://github.com/anthropics/anthropic-quickstarts.git",
		confidence: "provider-owned",
		pathHint: "computer-use-demo",
		patterns: ["computer_", "computer-use-", "tool_use", "tool_result", "input.action"],
	},
	{
		provider: "gemini",
		name: "computer-use-preview",
		repo: "https://github.com/google/computer-use-preview.git",
		confidence: "provider-owned",
		patterns: ["computer_use", "ComputerUse", "function_call", "functionCall", "FunctionResponse", "safety_decision"],
	},
	{
		provider: "meta",
		name: "meta-model-cookbook",
		repo: "https://github.com/meta-models/meta-model-cookbook.git",
		confidence: "provider-owned",
		pathHint: "03_use_cases/13_macos_cua",
		patterns: ["muse-spark-1.1", "function_call", "function_call_output", "previous_response_id", "reasoning.encrypted_content", "parallel_tool_calls"],
	},
	{
		provider: "xai",
		name: "xai-sdk-python",
		repo: "https://github.com/xai-org/xai-sdk-python.git",
		confidence: "provider-owned",
		pathHint: "examples",
		patterns: ["grok-4.5", "function_call", "tool_call", "previous_response_id", "reasoning_effort", "parallel_tool_calls"],
	},
	{
		provider: "yutori",
		name: "kernel-cli-yutori-template",
		repo: "https://github.com/kernel/cli.git",
		confidence: "kernel-template",
		pathHint: "pkg/templates/typescript/yutori",
		patterns: ["YUTORI_API_KEY", "tool_calls", "left_click", "goto_url", "n1-latest", "api.yutori.com"],
	},
];

const ACTION_REGEXES: Record<Provider, RegExp[]> = {
	openai: [/\b(click|double_click|scroll|type|wait|keypress|drag|move|screenshot)\b/g],
	anthropic: [/\b(screenshot|left_click|right_click|middle_click|double_click|triple_click|left_click_drag|mouse_move|key|type|scroll|hold_key|wait|left_mouse_down|left_mouse_up|cursor_position|zoom)\b/g],
	gemini: [/\b(open_web_browser|open_web|wait_5_seconds|go_back|go_forward|search|navigate|click_at|hover_at|type_text_at|key_combination|scroll_document|scroll_at|drag_and_drop)\b/g],
	meta: [/\b(screenshot|left_click|right_click|middle_click|double_click|triple_click|left_click_drag|mouse_move|key|type|scroll|hold_key|wait|left_mouse_down|left_mouse_up)\b/g],
	xai: [/\b(screenshot|click|double_click|mouse_down|mouse_up|scroll|type|keypress|drag|move|wait)\b/g],
	yutori: [/\b(left_click|double_click|triple_click|right_click|scroll|type|key_press|hover|drag|wait|refresh|go_back|goto_url|mouse_move|middle_click|mouse_down|mouse_up|go_forward|hold_key|extract_elements|find|set_element_value|execute_js)\b/g],
};

function parseArgs(argv: string[]): Args {
	const out: Args = {
		cache: "/tmp/cua-update-models/examples",
		out: "",
		noUpdate: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === "--cache" && next) {
			out.cache = next;
			i++;
		} else if (arg === "--out" && next) {
			out.out = next;
			i++;
		} else if (arg === "--no-update") {
			out.noUpdate = true;
		} else if (arg === "--help" || arg === "-h") {
			usage();
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return out;
}

function usage(): never {
	console.log(`Usage:
  npx tsx .agents/skills/update-models/reference/audit-official-examples.ts --out /tmp/cua-example-evidence.json

Options:
  --cache <dir>   Clone/update examples here. Default: /tmp/cua-update-models/examples
  --no-update     Do not git pull existing repos.
  --out <file>    Write JSON report to file.
`);
	process.exit(0);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const cacheDir = resolve(process.cwd(), args.cache);
	await mkdir(cacheDir, { recursive: true });

	const repos = [];
	for (const example of EXAMPLES) {
		repos.push(await auditRepo(example, cacheDir, args));
	}

	const report = {
		generated_at: new Date().toISOString(),
		cache_dir: cacheDir,
		repos,
		by_provider: groupByProvider(repos),
	};
	await emitJson(report, args.out);
}

async function auditRepo(example: ExampleRepo, cacheDir: string, args: Args): Promise<Record<string, unknown>> {
	const dir = join(cacheDir, example.name);
	const cloneOrUpdate = ensureRepo(example.repo, dir, args.noUpdate);
	const commit = git(["rev-parse", "HEAD"], dir).stdout.trim() || null;
	const files = await collectFiles(example.pathHint ? join(dir, example.pathHint) : dir);
	const matches = [];
	const toolVersions = new Set<string>();
	const betaHeaders = new Set<string>();
	const actionNames = new Set<string>();
	const responseFields = new Set<string>();

	for (const file of files) {
		const text = await readFile(file, "utf8").catch(() => "");
		if (!text) continue;
		const foundPatterns = example.patterns.filter((p) => text.includes(p));
		if (foundPatterns.length === 0) continue;

		extractAll(text, /computer_\d{8}/g).forEach((v) => toolVersions.add(v));
		extractAll(text, /computer-use-\d{4}-\d{2}-\d{2}/g).forEach((v) => betaHeaders.add(v));
		for (const regex of ACTION_REGEXES[example.provider] ?? []) {
			extractAll(text, regex).forEach((v) => actionNames.add(v));
		}
		for (const field of ["computer_call", "actions", "action", "pending_safety_checks", "tool_use", "tool_result", "tool_calls", "function_call", "functionCall", "FunctionResponse", "safety_decision", "previous_response_id", "parallel_tool_calls", "reasoning_effort"]) {
			if (text.includes(field)) responseFields.add(field);
		}

		matches.push({
			file: relativePath(dir, file),
			patterns: foundPatterns,
			snippets: snippets(text, foundPatterns),
		});
	}

	return {
		provider: example.provider,
		name: example.name,
		repo: example.repo,
		confidence: example.confidence,
		local_path: dir,
		commit,
		clone_or_update: cloneOrUpdate,
		tool_versions: sorted(toolVersions),
		beta_headers: sorted(betaHeaders),
		action_names: sorted(actionNames),
		response_fields: sorted(responseFields),
		matches,
	};
}

function ensureRepo(repo: string, dir: string, noUpdate: boolean): Record<string, unknown> {
	if (!existsSync(dir)) {
		const res = git(["clone", "--depth", "1", repo, dir], process.cwd());
		return { action: "clone", ok: res.status === 0, stderr: res.stderr.trim() };
	}
	if (noUpdate) return { action: "skip-update", ok: true, stderr: "" };
	const res = git(["pull", "--ff-only"], dir);
	return { action: "pull", ok: res.status === 0, stderr: res.stderr.trim() };
}

function git(args: string[], cwd: string): GitResult {
	const res = spawnSync("git", args, { cwd, encoding: "utf8" });
	return {
		status: res.status,
		stdout: res.stdout ?? "",
		stderr: res.stderr ?? "",
	};
}

async function collectFiles(root: string): Promise<string[]> {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	await walk(root, out);
	return out.filter((file) => /\.(py|ts|tsx|js|jsx|mjs|md|json|yaml|yml)$/i.test(file));
}

async function walk(dir: string, out: string[]): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "__pycache__") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) await walk(path, out);
		else if (entry.isFile()) out.push(path);
	}
}

function extractAll(text: string, regex: RegExp): string[] {
	const values: string[] = [];
	for (const match of text.matchAll(regex)) values.push(match[1] ?? match[0]);
	return values;
}

function snippets(text: string, patterns: string[]): Array<Record<string, unknown>> {
	const lines = text.split(/\r?\n/);
	const out: Array<Record<string, unknown>> = [];
	for (const pattern of patterns.slice(0, 8)) {
		const idx = lines.findIndex((line) => line.includes(pattern));
		if (idx < 0) continue;
		out.push({
			pattern,
			line: idx + 1,
			text: (lines[idx] ?? "").trim().slice(0, 240),
		});
	}
	return out;
}

function relativePath(root: string, file: string): string {
	return file.startsWith(root) ? file.slice(root.length + 1) : basename(file);
}

function groupByProvider(repos: Array<Record<string, any>>): Record<string, Record<string, string[]>> {
	const out: Record<string, Record<string, string[]>> = {};
	for (const repo of repos) {
		const provider = String(repo.provider);
		out[provider] ??= { action_names: [], tool_versions: [], beta_headers: [], response_fields: [] };
		out[provider].action_names = sorted(new Set([...out[provider].action_names, ...repo.action_names]));
		out[provider].tool_versions = sorted(new Set([...out[provider].tool_versions, ...repo.tool_versions]));
		out[provider].beta_headers = sorted(new Set([...out[provider].beta_headers, ...repo.beta_headers]));
		out[provider].response_fields = sorted(new Set([...out[provider].response_fields, ...repo.response_fields]));
	}
	return out;
}

function sorted(values: Iterable<string>): string[] {
	return [...values].sort();
}

async function emitJson(value: unknown, outPath: string): Promise<void> {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	if (outPath) await writeFile(outPath, text);
	else process.stdout.write(text);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
