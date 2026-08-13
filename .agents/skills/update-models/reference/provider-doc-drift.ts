#!/usr/bin/env tsx
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

type Provider = "openai" | "anthropic" | "gemini" | "meta" | "xai" | "moonshot";

interface Args {
	examples: string;
	out: string;
}

interface FetchResult {
	url: string;
	ok: boolean;
	status: number | null;
	error?: string;
	text: string;
}

const DOCS: Record<Provider, string[]> = {
	openai: [
		"https://developers.openai.com/api/docs/guides/tools-computer-use",
		"https://raw.githubusercontent.com/openai/openai-node/master/src/resources/responses/responses.ts",
	],
	anthropic: [
		"https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/computer-use-tool",
		"https://console.anthropic.com/docs/en/agents-and-tools/tool-use/tool-reference",
	],
	gemini: [
		"https://ai.google.dev/gemini-api/docs/computer-use",
		"https://ai.google.dev/api/models",
	],
	meta: [
		"https://dev.meta.ai/docs/getting-started/cookbook/computer-use-macos",
		"https://dev.meta.ai/docs/features/responses",
		"https://dev.meta.ai/docs/features/tool-calling",
	],
	xai: [
		"https://docs.x.ai/developers/grok-4-5",
		"https://docs.x.ai/developers/tools/function-calling",
		"https://docs.x.ai/developers/model-capabilities/images/understanding",
	],
	moonshot: [
		"https://www.kimi.com/blog/kimi-k3",
		"https://platform.kimi.ai/docs/api/tool-use",
		"https://platform.kimi.ai/docs/guide/use-kimi-vision-model",
	],
};

const LOCAL_FILES: Record<Provider, string> = {
	openai: "packages/ai/src/providers/openai/index.ts",
	anthropic: "packages/ai/src/providers/anthropic/actions.ts",
	gemini: "packages/ai/src/providers/gemini/index.ts",
	meta: "packages/ai/src/providers/meta/index.ts",
	xai: "packages/ai/src/providers/xai/index.ts",
	moonshot: "packages/ai/src/providers/moonshot/index.ts",
};

const ACTION_REGEXES: Record<Provider, RegExp> = {
	openai: /\b(click|double_click|scroll|type|wait|keypress|drag|move|screenshot)\b/g,
	anthropic: /\b(screenshot|left_click|right_click|middle_click|double_click|triple_click|left_click_drag|mouse_move|key|type|scroll|hold_key|wait|left_mouse_down|left_mouse_up|cursor_position|zoom)\b/g,
	gemini: /\b(open_web_browser|open_web|wait_5_seconds|go_back|go_forward|search|navigate|click_at|hover_at|type_text_at|key_combination|scroll_document|scroll_at|drag_and_drop)\b/g,
	meta: /\b(click|double_click|mouse_down|mouse_up|scroll|type|wait|keypress|drag|move|screenshot|goto|back|forward|url|cursor_position|left_click|right_click|middle_click|triple_click|left_click_drag|mouse_move|key|hold_key|left_mouse_down|left_mouse_up)\b/g,
	xai: /\b(click|double_click|mouse_down|mouse_up|scroll|type|wait|keypress|drag|move|screenshot|goto|back|forward|url|cursor_position)\b/g,
	moonshot: /\b(click|double_click|mouse_down|mouse_up|scroll|type|wait|keypress|drag|move|screenshot|goto|back|forward|url|cursor_position)\b/g,
};

function parseArgs(argv: string[]): Args {
	const out: Args = { examples: "", out: "" };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === "--examples" && next) {
			out.examples = next;
			i++;
		} else if (arg === "--out" && next) {
			out.out = next;
			i++;
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
  npx tsx .agents/skills/update-models/reference/provider-doc-drift.ts --examples /tmp/cua-example-evidence.json --out /tmp/cua-drift.json
`);
	process.exit(0);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const examples = args.examples ? JSON.parse(await readFile(args.examples, "utf8")) : {};
	const report: Record<string, unknown> = {
		generated_at: new Date().toISOString(),
		providers: {},
	};
	const providers = report.providers as Record<string, unknown>;
	await Promise.all((Object.keys(DOCS) as Provider[]).map(async (provider) => {
		providers[provider] = await checkProvider(provider, examples);
	}));
	await emitJson(report, args.out);
}

async function checkProvider(provider: Provider, examples: any): Promise<Record<string, unknown>> {
	const docTexts = await Promise.all(DOCS[provider].map(fetchText));
	const docText = docTexts.map((r) => r.text).join("\n");
	const localText = await readFile(LOCAL_FILES[provider], "utf8").catch((err) => `/* failed to read local file: ${err.message} */`);
	const example = examples?.by_provider?.[provider] ?? {};

	const documentedActions = unique(extractAll(docText, ACTION_REGEXES[provider]));
	const localActions = unique(extractAll(localText, ACTION_REGEXES[provider]));
	const exampleActions: string[] = example.action_names ?? [];
	const documentedToolVersions = unique(extractAll(docText, /computer_\d{8}/g));
	const localToolVersions = unique(extractAll(localText, /computer_\d{8}/g));
	const exampleToolVersions: string[] = example.tool_versions ?? [];
	const documentedBetaHeaders = unique(extractAll(docText, /computer-use-\d{4}-\d{2}-\d{2}/g));
	const localBetaHeaders = unique(extractAll(localText, /computer-use-\d{4}-\d{2}-\d{2}/g));
	const exampleBetaHeaders: string[] = example.beta_headers ?? [];

	return {
		provider,
		doc_sources: docTexts.map(({ url, ok, status, error }) => ({ url, ok, status, error })),
		documented_tool_versions: sorted(documentedToolVersions),
		example_tool_versions: sorted(exampleToolVersions),
		local_tool_versions: sorted(localToolVersions),
		newer_tool_versions: sorted(difference(new Set([...documentedToolVersions, ...exampleToolVersions]), new Set(localToolVersions))),
		documented_beta_headers: sorted(documentedBetaHeaders),
		example_beta_headers: sorted(exampleBetaHeaders),
		local_beta_headers: sorted(localBetaHeaders),
		newer_beta_headers: sorted(difference(new Set([...documentedBetaHeaders, ...exampleBetaHeaders]), new Set(localBetaHeaders))),
		documented_actions: sorted(documentedActions),
		example_repo_actions: sorted(exampleActions),
		repo_supported_actions: sorted(localActions),
		unknown_documented_actions: provider === "meta" || provider === "xai" || provider === "moonshot" ? [] : sorted(difference(new Set(documentedActions), new Set(localActions))),
		unknown_example_actions: provider === "meta" || provider === "xai" || provider === "moonshot" ? [] : sorted(difference(new Set(exampleActions), new Set(localActions))),
		response_fields_from_examples: sorted(example.response_fields ?? []),
		notes: notesFor(provider, documentedToolVersions, exampleToolVersions, localToolVersions),
	};
}

async function fetchText(url: string): Promise<FetchResult> {
	try {
		const response = await fetch(url);
		const text = await response.text();
		return { url, ok: response.ok, status: response.status, text };
	} catch (err) {
		return { url, ok: false, status: null, error: err instanceof Error ? err.message : String(err), text: "" };
	}
}

function notesFor(provider: Provider, documentedToolVersions: string[], exampleToolVersions: string[], localToolVersions: string[]): string[] {
	const notes: string[] = [];
	if (provider === "openai") {
		notes.push("OpenAI's GA computer tool is currently undated (`computer`); drift usually appears as action-shape changes or preview deprecations.");
	}
	if (provider === "anthropic") {
		const newest = sorted(new Set([...documentedToolVersions, ...exampleToolVersions])).at(-1);
		if (newest && !localToolVersions.includes(newest)) {
			notes.push(`Anthropic docs/examples mention ${newest}, which is not in local constants.`);
		}
	}
	if (provider === "gemini") {
		notes.push("Gemini official computer use emits predefined function-call names; keep this separate from CUA custom function declarations.");
	}
	if (provider === "meta") {
		notes.push("Meta uses developer-defined function tools, so provider action-name drift does not apply; compare payload threading and coordinate conventions instead.");
	}
	if (provider === "xai") {
		notes.push("xAI uses developer-defined function tools and does not document a native coordinate protocol; compare Responses compatibility, reasoning controls, and CUA's normalized coordinate contract instead.");
	}
	if (provider === "moonshot") {
		notes.push("Moonshot uses developer-defined function tools over OpenAI-compatible chat completions and does not document a coordinate protocol; Kimi grounding emits 0-1 width/height fractions, so compare against CUA's fractional coordinate contract.");
	}
	return notes;
}

function extractAll(text: string, regex: RegExp): string[] {
	const values: string[] = [];
	for (const match of String(text).matchAll(regex)) values.push(match[1] ?? match[0]);
	return values;
}

function difference(a: Set<string>, b: Set<string>): string[] {
	return [...a].filter((value) => !b.has(value));
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
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
