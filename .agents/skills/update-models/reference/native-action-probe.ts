#!/usr/bin/env tsx
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parse as parseToml } from "smol-toml";

type Provider = "openai" | "anthropic" | "gemini" | "xai" | "tzafon" | "yutori";

interface ProbePrompt {
	id: string;
	text: string;
}

interface Args {
	provider: Provider;
	model: string;
	out: string;
	limit: number;
}

interface ProbeResult {
	id: string;
	status: "pass" | "inconclusive" | "fail";
	actions: string[];
	item_types: string[];
	[key: string]: unknown;
}

const PROMPTS: ProbePrompt[] = [
	{ id: "screenshot", text: "Use the computer tool to inspect the current screen by requesting a screenshot. Do not answer in text." },
	{ id: "open", text: "Use the computer tool to open the web browser or navigate to https://example.com. Do not answer in text." },
	{ id: "click", text: "Use the computer tool to click the center of the page. Do not answer in text." },
	{ id: "type", text: "Use the computer tool to type hello into the active field. Do not answer in text." },
	{ id: "keypress", text: "Use the computer tool to press Enter. Do not answer in text." },
	{ id: "scroll", text: "Use the computer tool to scroll down. Do not answer in text." },
	{ id: "drag", text: "Use the computer tool to drag from the upper-left area to the lower-right area. Do not answer in text." },
	{ id: "hover", text: "Use the computer tool to move or hover the pointer at the center of the screen. Do not answer in text." },
	{ id: "wait", text: "Use the computer tool to wait briefly. Do not answer in text." },
	{ id: "back", text: "Use the computer tool to go back in browser history. Do not answer in text." },
];

function parseArgs(argv: string[]): Args {
	const out: Args = { provider: "" as Provider, model: "", out: "", limit: PROMPTS.length };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === "--provider" && next) {
			out.provider = next as Provider;
			i++;
		} else if (arg === "--model" && next) {
			out.model = next;
			i++;
		} else if (arg === "--out" && next) {
			out.out = next;
			i++;
		} else if (arg === "--limit" && next) {
			out.limit = Number(next) || out.limit;
			i++;
		} else if (arg === "--help" || arg === "-h") {
			usage();
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	if (!["openai", "anthropic", "gemini", "xai", "tzafon", "yutori"].includes(out.provider)) {
		throw new Error("--provider is required: openai | anthropic | gemini | xai | tzafon | yutori");
	}
	if (!out.model) throw new Error("--model is required");
	return out;
}

function usage(): never {
	console.log(`Usage:
  npx tsx .agents/skills/update-models/reference/native-action-probe.ts --provider openai --model gpt-5.5 --out /tmp/actions.json
  npx tsx .agents/skills/update-models/reference/native-action-probe.ts --provider anthropic --model claude-opus-4-7 --limit 3
  npx tsx .agents/skills/update-models/reference/native-action-probe.ts --provider xai --model grok-4.5 --limit 3
  npx tsx .agents/skills/update-models/reference/native-action-probe.ts --provider tzafon --model tzafon.northstar-cua-fast --limit 3
  npx tsx .agents/skills/update-models/reference/native-action-probe.ts --provider yutori --model n1.5-latest --limit 3
`);
	process.exit(0);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const prompts = PROMPTS.slice(0, args.limit);
	const probes: ProbeResult[] = [];
	for (const prompt of prompts) {
		probes.push(await runProbe(args.provider, args.model, prompt));
	}
	const report = {
		generated_at: new Date().toISOString(),
		provider: args.provider,
		model: args.model,
		observed_actions: unique(probes.flatMap((p) => p.actions)),
		probes,
	};
	await emitJson(report, args.out);
}

async function runProbe(provider: Provider, model: string, prompt: ProbePrompt): Promise<ProbeResult> {
	try {
		if (provider === "openai") return await probeOpenAI(model, prompt);
		if (provider === "anthropic") return await probeAnthropic(model, prompt);
		if (provider === "gemini") return await probeGemini(model, prompt);
		if (provider === "xai") return await probeXai(model, prompt);
		if (provider === "tzafon") return await probeTzafon(model, prompt);
		if (provider === "yutori") return await probeYutori(model, prompt);
		throw new Error(`unknown provider ${provider satisfies never}`);
	} catch (err) {
		return {
			id: prompt.id,
			status: "fail",
			actions: [],
			item_types: [],
			error: publicError(err),
		};
	}
}

async function probeOpenAI(model: string, prompt: ProbePrompt): Promise<ProbeResult> {
	const OpenAI = await importDefault("openai", "OpenAI");
	const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
	const response = await client.responses.create({
		model,
		input: prompt.text,
		tools: [{ type: "computer" }],
		tool_choice: { type: "computer" },
		max_output_tokens: 64,
	});
	const output: any[] = response.output ?? [];
	const calls = output.filter((item) => item?.type === "computer_call");
	const actions = calls.flatMap((call) => Array.isArray(call.actions) ? call.actions : call.action ? [call.action] : []);
	return {
		id: prompt.id,
		status: calls.length ? "pass" : "inconclusive",
		actions: unique(actions.map((a) => a?.type).filter(Boolean)),
		item_types: unique(output.map((item) => item?.type).filter(Boolean)),
		raw_tool_calls: calls.map(redactLargeFields),
	};
}

async function probeAnthropic(model: string, prompt: ProbePrompt): Promise<ProbeResult> {
	const Anthropic = await importDefault("@anthropic-ai/sdk", "Anthropic");
	const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
	const attempts: ProbeResult[] = [];
	for (const pair of [
		{ tool: "computer_20251124", beta: "computer-use-2025-11-24" },
		{ tool: "computer_20250124", beta: "computer-use-2025-01-24" },
	]) {
		try {
			const response = await client.beta.messages.create({
				model,
				max_tokens: 64,
				messages: [{ role: "user", content: prompt.text }],
				tools: [{
					type: pair.tool,
					name: "computer",
					display_width_px: 1024,
					display_height_px: 768,
					display_number: 1,
				}],
				betas: [pair.beta],
			});
			const content: any[] = response.content ?? [];
			const calls = content.filter((block) => block?.type === "tool_use" && block?.name === "computer");
			const result: ProbeResult = {
				id: prompt.id,
				status: calls.length ? "pass" : "inconclusive",
				tool_version: pair.tool,
				beta_header: pair.beta,
				actions: unique(calls.map((call) => call?.input?.action).filter(Boolean)),
				item_types: unique(content.map((block) => block?.type).filter(Boolean)),
				stop_reason: response.stop_reason ?? null,
				raw_tool_calls: calls.map(redactLargeFields),
			};
			if (result.status === "pass") return result;
			attempts.push(result);
		} catch (err) {
			attempts.push({ id: prompt.id, status: "fail", tool_version: pair.tool, beta_header: pair.beta, actions: [], item_types: [], error: publicError(err) });
		}
	}
	return { id: prompt.id, status: "fail", actions: [], item_types: [], attempts };
}

async function probeGemini(model: string, prompt: ProbePrompt): Promise<ProbeResult> {
	const { GoogleGenAI } = await import("@google/genai");
	const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
	const client = new GoogleGenAI({ apiKey });
	const variants = [
		{ tools: [{ computerUse: { environment: "ENVIRONMENT_BROWSER" } }], maxOutputTokens: 64 },
		{ tools: [{ computer_use: { environment: "ENVIRONMENT_BROWSER" } }], maxOutputTokens: 64 },
	];
	const attempts: ProbeResult[] = [];
	for (const config of variants) {
		try {
			const response = await client.models.generateContent({
				model,
				contents: [{ role: "user", parts: [{ text: prompt.text }] }],
				config: config as any,
			});
			const parts: any[] = response?.candidates?.[0]?.content?.parts ?? [];
			const calls = parts.map((part) => part.functionCall ?? part.function_call).filter(Boolean);
			const result: ProbeResult = {
				id: prompt.id,
				status: calls.length ? "pass" : "inconclusive",
				actions: unique(calls.map((call) => call.name).filter(Boolean)),
				item_types: unique(parts.map((part) => part.functionCall || part.function_call ? "function_call" : part.text ? "text" : Object.keys(part)[0]).filter(Boolean)),
				raw_tool_calls: calls.map(redactLargeFields),
			};
			if (result.status === "pass") return result;
			attempts.push(result);
		} catch (err) {
			attempts.push({ id: prompt.id, status: "fail", actions: [], item_types: [], error: publicError(err) });
		}
	}
	return { id: prompt.id, status: "fail", actions: [], item_types: [], attempts };
}

async function probeXai(model: string, prompt: ProbePrompt): Promise<ProbeResult> {
	const OpenAI = await importDefault("openai", "OpenAI");
	const client = new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: "https://api.x.ai/v1" });
	const screenshot = await readFixtureScreenshot();
	const response = await client.responses.create({
		model,
		store: true,
		parallel_tool_calls: false,
		max_output_tokens: 768,
		reasoning: { effort: "low" },
		instructions: "The available browser tools use normalized 0-1000 screenshot coordinates. Call one tool instead of answering in text.",
		input: [{
			role: "user",
			content: [
				{ type: "input_text", text: prompt.text },
				{ type: "input_image", image_url: `data:image/png;base64,${screenshot.toString("base64")}`, detail: "high" },
			],
		}],
		tools: XAI_FUNCTION_TOOLS,
	});
	const output: any[] = response.output ?? [];
	const calls = output.filter((item) => item?.type === "function_call");
	return {
		id: prompt.id,
		status: calls.length ? "pass" : "inconclusive",
		actions: unique(calls.map((call) => call?.name).filter(Boolean)),
		item_types: unique(output.map((item) => item?.type).filter(Boolean)),
		raw_tool_calls: calls.map(redactLargeFields),
	};
}

async function readFixtureScreenshot(): Promise<Buffer> {
	const path = [
		join(process.cwd(), "examples", "screenshot.png"),
		join(process.cwd(), "packages", "ai", "examples", "screenshot.png"),
	].find(existsSync);
	if (!path) throw new Error("could not find packages/ai/examples/screenshot.png");
	return readFile(path);
}

async function probeYutori(model: string, prompt: ProbePrompt): Promise<ProbeResult> {
	const OpenAI = await importDefault("openai", "OpenAI");
	const client = new OpenAI({
		apiKey: await yutoriApiKey(),
		baseURL: "https://api.yutori.com/v1",
	});
	const response = await client.chat.completions.create({
		model,
		messages: [{
			role: "user",
			content: [
				{ type: "text", text: prompt.text },
				{ type: "image_url", image_url: { url: "https://docs.yutori.com/assets/google_homepage_2024.jpg" } },
			],
		}],
		max_completion_tokens: 128,
		temperature: 0.3,
	});
	const choice = response.choices?.[0];
	const toolCalls: any[] = choice?.message?.tool_calls ?? [];
	return {
		id: prompt.id,
		status: toolCalls.length ? "pass" : "inconclusive",
		actions: unique(toolCalls.map((call) => call?.function?.name).filter(Boolean)),
		item_types: unique([
			choice?.message?.content ? "text" : undefined,
			toolCalls.length ? "tool_calls" : undefined,
		].filter(Boolean) as string[]),
		finish_reason: choice?.finish_reason ?? null,
		raw_tool_calls: toolCalls.map(redactLargeFields),
	};
}

async function yutoriApiKey(): Promise<string> {
	const env = process.env.YUTORI_API_KEY;
	if (env && env.trim()) return env;
	const cfgPath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cua", "config.toml");
	try {
		const raw = parseToml(await readFile(cfgPath, "utf8")) as any;
		const profile = typeof raw?.default_profile === "string" ? raw.default_profile : undefined;
		const key = profile ? raw?.profiles?.[profile]?.yutori_api_key : undefined;
		if (typeof key === "string" && key.trim()) return key;
	} catch {
		// Fall through to a clear credential error.
	}
	throw new Error("missing Yutori API key (set YUTORI_API_KEY or yutori_api_key in the default cua config profile)");
}

async function probeTzafon(model: string, prompt: ProbePrompt): Promise<ProbeResult> {
	const Lightcone = await importDefault("@tzafon/lightcone", "Lightcone");
	const client = new Lightcone({ apiKey: process.env.TZAFON_API_KEY });
	const response = await client.responses.create({
		model,
		input: [{
			role: "user",
			content: [
				{ type: "input_text", text: `${prompt.text}\nCall one of the available function tools instead of answering in text.` },
				{ type: "input_image", image_url: "https://docs.yutori.com/assets/google_homepage_2024.jpg", detail: "auto" },
			],
		}],
		tools: TZAFON_FUNCTION_TOOLS,
		instructions: "The screen's coordinate space is a 0-999 grid.",
		temperature: 0,
		max_output_tokens: 128,
	});
	const output: any[] = response.output ?? [];
	const functionCalls = output.filter((item) => item?.type === "function_call");
	const computerCalls = output.filter((item) => item?.type === "computer_call");
	const computerActions = computerCalls.flatMap((call) => Array.isArray(call.actions) ? call.actions : call.action ? [call.action] : []);
	return {
		id: prompt.id,
		status: functionCalls.length || computerCalls.length ? "pass" : "inconclusive",
		actions: unique([
			...functionCalls.map((call) => call?.name).filter(Boolean),
			...computerActions.map((action) => action?.type).filter(Boolean),
		]),
		item_types: unique(output.map((item) => item?.type).filter(Boolean)),
		raw_tool_calls: [...functionCalls, ...computerCalls].map(redactLargeFields),
	};
}

const XAI_FUNCTION_TOOLS = [
	{ type: "function", name: "screenshot", description: "Capture the current browser screenshot.", parameters: { type: "object", properties: {}, additionalProperties: false } },
	{ type: "function", name: "goto", description: "Navigate to a URL.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } },
	{ type: "function", name: "click", description: "Click at normalized 0-1000 coordinates.", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false } },
	{ type: "function", name: "type", description: "Type text into the active field.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
	{ type: "function", name: "keypress", description: "Press one or more keyboard keys.", parameters: { type: "object", properties: { keys: { type: "array", items: { type: "string" } } }, required: ["keys"], additionalProperties: false } },
	{ type: "function", name: "scroll", description: "Scroll at normalized 0-1000 coordinates.", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, scroll_y: { type: "number" } }, required: ["scroll_y"], additionalProperties: false } },
	{ type: "function", name: "drag", description: "Drag through normalized 0-1000 coordinates.", parameters: { type: "object", properties: { path: { type: "array", items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false } } }, required: ["path"], additionalProperties: false } },
	{ type: "function", name: "move", description: "Move the pointer to normalized 0-1000 coordinates.", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false } },
	{ type: "function", name: "wait", description: "Wait briefly.", parameters: { type: "object", properties: {}, additionalProperties: false } },
	{ type: "function", name: "back", description: "Go back in browser history.", parameters: { type: "object", properties: {}, additionalProperties: false } },
];

const TZAFON_FUNCTION_TOOLS = [
	{ type: "function", name: "click", description: "Single click at (x, y) in 0-999 grid.", parameters: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, button: { type: "string", enum: ["left", "right"] } }, required: ["x", "y"] } },
	{ type: "function", name: "double_click", description: "Double click at (x, y) in 0-999 grid.", parameters: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } }, required: ["x", "y"] } },
	{ type: "function", name: "point_and_type", description: "Click at position then type text.", parameters: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, text: { type: "string" }, press_enter: { type: "boolean" } }, required: ["x", "y", "text"] } },
	{ type: "function", name: "key", description: "Press key combo.", parameters: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"] } },
	{ type: "function", name: "scroll", description: "Scroll at (x, y) in 0-999 grid.", parameters: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, dy: { type: "integer" } }, required: ["x", "y", "dy"] } },
	{ type: "function", name: "drag", description: "Drag from (x1, y1) to (x2, y2) in 0-999 grid.", parameters: { type: "object", properties: { x1: { type: "integer" }, y1: { type: "integer" }, x2: { type: "integer" }, y2: { type: "integer" } }, required: ["x1", "y1", "x2", "y2"] } },
	{ type: "function", name: "done", description: "Task complete. Report findings.", parameters: { type: "object", properties: { result: { type: "string" } }, required: ["result"] } },
];

async function importDefault(pkg: string, named: string): Promise<any> {
	try {
		const mod = await import(pkg);
		return mod.default ?? mod[named];
	} catch (err) {
		throw new Error(`failed to import ${pkg}. Run npm install first. ${publicError(err)}`);
	}
}

function redactLargeFields(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value, (key, val) => {
		if (typeof val === "string" && val.length > 500) return `${val.slice(0, 120)}...<truncated:${val.length}>`;
		if (key === "image_url" || key === "data") return "<redacted-image>";
		return val;
	}));
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

function publicError(err: unknown): string {
	if (err && typeof err === "object" && "status" in err && "message" in err) {
		return `${String((err as { status: unknown }).status)}: ${String((err as { message: unknown }).message)}`;
	}
	return err instanceof Error ? err.message : String(err);
}

async function emitJson(value: unknown, outPath: string): Promise<void> {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	if (outPath) await writeFile(outPath, text);
	else process.stdout.write(text);
}

main().catch((err) => {
	console.error(publicError(err));
	process.exit(1);
});
