#!/usr/bin/env tsx
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parse as parseToml } from "smol-toml";

type Provider = "openai" | "anthropic" | "gemini" | "meta" | "tzafon" | "yutori";

interface Args {
	provider: Provider | "all";
	out: string;
	models: string[];
	candidateLimit: number;
	smoke: boolean;
}

interface SmokeResult {
	status: "pass" | "inconclusive" | "unsupported" | "fail";
	tool_name?: string;
	tool_version?: string | null;
	beta_header?: string | null;
	observed_actions: string[];
	response_item_types: string[];
	error: string | null;
	[key: string]: unknown;
}

interface ModelResult {
	id: string;
	display_name?: string;
	name?: string | null;
	created_at?: string | null;
	raw?: unknown;
	supports_generation?: boolean;
	computer_use?: SmokeResult | Record<string, unknown>;
	model_docs?: Record<string, unknown>;
	cua?: Record<string, unknown>;
}

const PROVIDERS: Provider[] = ["openai", "anthropic", "gemini", "meta", "tzafon", "yutori"];
const TZAFON_KNOWN_MODELS = [
	"tzafon.northstar-cua-fast",
];
const YUTORI_DOC_MODELS = [
	"n1.5-latest",
	"n1.5-20260428",
	"n1-latest",
	"n1-20260203",
];
const GEMINI_DOC_COMPUTER_USE_MODELS = [
	"gemini-3.5-flash",
	"gemini-3-flash-preview",
	"gemini-2.5-computer-use-preview-10-2025",
];

const OPENAI_EXCLUDE = [
	"embedding",
	"moderation",
	"whisper",
	"tts",
	"dall-e",
	"image",
	"audio",
	"transcribe",
	"realtime",
];

function parseArgs(argv: string[]): Args {
	const out: Args = {
		provider: "all",
		out: "",
		models: [],
		candidateLimit: 20,
		smoke: true,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === "--provider" && next) {
			out.provider = next as Provider | "all";
			i++;
		} else if (arg === "--out" && next) {
			out.out = next;
			i++;
		} else if (arg === "--models" && next) {
			out.models = next.split(",").map((s) => s.trim()).filter(Boolean);
			i++;
		} else if (arg === "--candidate-limit" && next) {
			out.candidateLimit = Number(next) || out.candidateLimit;
			i++;
		} else if (arg === "--no-smoke") {
			out.smoke = false;
		} else if (arg === "--help" || arg === "-h") {
			usage();
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	if (out.provider !== "all" && !PROVIDERS.includes(out.provider)) {
		throw new Error(`--provider must be one of: all, ${PROVIDERS.join(", ")}`);
	}
	return out;
}

function usage(): never {
	console.log(`Usage:
  npx tsx .agents/skills/update-models/reference/discover-models.ts --provider all --out /tmp/cua-model-report.json
  npx tsx .agents/skills/update-models/reference/discover-models.ts --provider openai --models gpt-5.5,gpt-5.4

Options:
  --provider <all|openai|anthropic|gemini|meta|tzafon|yutori>
  --models <comma-separated model ids>    Smoke-test explicit models instead of inferred candidates.
  --candidate-limit <n>                  Max inferred candidates per provider. Default: 20.
  --no-smoke                             Only list metadata.
  --out <file>                           Write JSON report to file.
`);
	process.exit(0);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const selected = args.provider === "all" ? PROVIDERS : [args.provider];
	const report: Record<string, unknown> = {
		generated_at: new Date().toISOString(),
		providers: {},
	};
	const providers = report.providers as Record<string, unknown>;
	await Promise.all(selected.map(async (provider) => {
		providers[provider] = await runProvider(provider, args);
	}));
	await emitJson(report, args.out);
}

async function runProvider(provider: Provider, args: Args): Promise<Record<string, unknown>> {
	try {
		if (provider === "openai") return await discoverOpenAI(args);
		if (provider === "anthropic") return await discoverAnthropic(args);
		if (provider === "gemini") return await discoverGemini(args);
		if (provider === "meta") return await discoverMeta(args);
		if (provider === "tzafon") return await discoverTzafon(args);
		if (provider === "yutori") return await discoverYutori(args);
		throw new Error(`unknown provider ${provider satisfies never}`);
	} catch (err) {
		return {
			provider,
			error: publicError(err),
		};
	}
}

async function discoverOpenAI(args: Args): Promise<Record<string, unknown>> {
	const OpenAI = await importDefault("openai", "OpenAI");
	const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
	const rawModels = await collectAsync(client.models.list());
	const models: ModelResult[] = rawModels
		.map((m) => ({
			id: String(m.id),
			display_name: String(m.id),
			created_at: typeof m.created === "number" ? new Date(m.created * 1000).toISOString() : null,
			raw: m,
			supports_generation: likelyOpenAIGenerationModel(String(m.id)),
		}))
		.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));

	const candidates = explicitOrCandidates(args, models.filter((m) => m.supports_generation).map((m) => m.id));
	await annotateOpenAIModelDocs(models.filter((m) => candidates.includes(m.id)));
	if (args.smoke) {
		await Promise.all(candidates.map(async (id) => {
			const model = models.find((m) => m.id === id) ?? { id, display_name: id, supports_generation: true };
			model.computer_use = await smokeOpenAI(client, id);
			if (!models.find((m) => m.id === id)) models.unshift(model);
		}));
	}
	await annotateCuaSupport("openai", models);
	return { provider: "openai", metadata_source: "client.models.list()", models, candidates };
}

async function discoverMeta(args: Args): Promise<Record<string, unknown>> {
	const OpenAI = await importDefault("openai", "OpenAI");
	const apiKey = process.env.META_API_KEY;
	const client = new OpenAI({ apiKey, baseURL: "https://api.meta.ai/v1" });
	const rawModels = await collectAsync(client.models.list());
	const models: ModelResult[] = rawModels.map((m) => ({
		id: String(m.id),
		display_name: String(m.id),
		created_at: typeof m.created === "number" && m.created > 0 ? new Date(m.created * 1000).toISOString() : null,
		raw: m,
		supports_generation: true,
	}));
	const candidates = explicitOrCandidates(args, models.map((model) => model.id));
	if (args.smoke) {
		await Promise.all(candidates.map(async (id) => {
			const model = models.find((candidate) => candidate.id === id) ?? { id, display_name: id, supports_generation: true };
			model.computer_use = await smokeMeta(client, id);
			if (!models.find((candidate) => candidate.id === id)) models.unshift(model);
		}));
	}
	await annotateCuaSupport("meta", models);
	return { provider: "meta", metadata_source: "Meta Model API models.list()", models, candidates };
}

async function smokeMeta(client: any, model: string): Promise<SmokeResult> {
	try {
		const screenshotPath = [
			join(process.cwd(), "examples", "screenshot.png"),
			join(process.cwd(), "packages", "ai", "examples", "screenshot.png"),
		].find(existsSync);
		if (!screenshotPath) throw new Error("could not find packages/ai/examples/screenshot.png");
		const screenshot = await readFile(screenshotPath);
		const response = await client.responses.create({
			model,
			store: false,
			parallel_tool_calls: false,
			max_output_tokens: 512,
			reasoning: { effort: "low" },
			input: [{
				role: "user",
				content: [
					{ type: "input_text", text: "Call the click tool for the sign in link. Do not answer only in text." },
					{ type: "input_image", image_url: `data:image/png;base64,${screenshot.toString("base64")}` },
				],
			}],
			tools: [{
				type: "function",
				name: "click",
				description: "Click at normalized 0-1000 screen coordinates.",
				parameters: {
					type: "object",
					properties: { x: { type: "number" }, y: { type: "number" } },
					required: ["x", "y"],
					additionalProperties: false,
				},
			}],
		});
		const output: any[] = response.output ?? [];
		const calls = output.filter((item) => item?.type === "function_call");
		return {
			status: calls.length > 0 ? "pass" : "inconclusive",
			tool_name: "function_tools",
			tool_version: null,
			beta_header: null,
			observed_actions: unique(calls.map((call) => call?.name).filter(Boolean)),
			response_item_types: unique(output.map((item) => item?.type).filter(Boolean)),
			error: null,
		};
	} catch (err) {
		return smokeError(err, { tool_name: "function_tools" });
	}
}

function likelyOpenAIGenerationModel(id: string): boolean {
	const lower = id.toLowerCase();
	if (OPENAI_EXCLUDE.some((needle) => lower.includes(needle))) return false;
	return lower.startsWith("gpt-") || /^o\d/.test(lower) || lower.includes("computer-use");
}

async function annotateOpenAIModelDocs(models: ModelResult[]): Promise<void> {
	await Promise.all(models.map(async (model) => {
		model.model_docs = await fetchOpenAIModelDocs(model.id);
	}));
}

async function fetchOpenAIModelDocs(modelId: string): Promise<Record<string, unknown>> {
	const docId = canonicalOpenAIModelDocId(modelId);
	const url = `https://developers.openai.com/api/docs/models/${docId}`;
	try {
		const response = await fetch(url);
		const text = await response.text();
		return {
			url,
			ok: response.ok,
			streaming: supportStatus(text, "Streaming"),
			function_calling: supportStatus(text, "Function calling"),
			computer_use: supportStatus(text, "Computer use"),
			responses_endpoint: text.includes("v1/responses") ? "supported" : "unknown",
		};
	} catch (err) {
		return {
			url,
			ok: false,
			error: publicError(err),
		};
	}
}

function canonicalOpenAIModelDocId(modelId: string): string {
	return modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

function supportStatus(text: string, label: string): "supported" | "not_supported" | "unknown" {
	const compact = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
	const re = new RegExp(`${escapeRegex(label)}\\s+(Supported|Not supported)`, "i");
	const match = compact.match(re);
	if (!match) return "unknown";
	return match[1]?.toLowerCase() === "supported" ? "supported" : "not_supported";
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function smokeOpenAI(client: any, model: string): Promise<SmokeResult> {
	try {
		const response = await client.responses.create({
			model,
			input: "Use the computer tool to request a screenshot. Do not answer in text.",
			tools: [{ type: "computer" }],
			tool_choice: { type: "computer" },
			max_output_tokens: 64,
		});
		const output: any[] = response.output ?? [];
		const calls = output.filter((item) => item?.type === "computer_call");
		const actions = calls.flatMap((call) => Array.isArray(call.actions) ? call.actions : call.action ? [call.action] : []);
		return {
			status: calls.length > 0 ? "pass" : "inconclusive",
			tool_name: "computer",
			tool_version: null,
			beta_header: null,
			observed_actions: unique(actions.map((a) => a?.type).filter(Boolean)),
			response_item_types: unique(output.map((item) => item?.type).filter(Boolean)),
			error: null,
		};
	} catch (err) {
		return smokeError(err, { tool_name: "computer" });
	}
}

async function discoverAnthropic(args: Args): Promise<Record<string, unknown>> {
	const Anthropic = await importDefault("@anthropic-ai/sdk", "Anthropic");
	const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
	const rawModels = await collectAsync(client.models.list({ limit: 1000 }));
	const models: ModelResult[] = rawModels.map((m) => ({
		id: String(m.id),
		display_name: m.display_name ?? m.id,
		created_at: m.created_at ?? null,
		raw: m,
		supports_generation: m.type === "model" || String(m.id).startsWith("claude-"),
	}));
	const candidates = explicitOrCandidates(args, models.filter((m) => m.id.startsWith("claude-")).map((m) => m.id));
	if (args.smoke) {
		await Promise.all(candidates.map(async (id) => {
			const model = models.find((m) => m.id === id) ?? { id, display_name: id, supports_generation: true };
			model.computer_use = await smokeAnthropic(client, id);
			if (!models.find((m) => m.id === id)) models.unshift(model);
		}));
	}
	await annotateCuaSupport("anthropic", models);
	return { provider: "anthropic", metadata_source: "client.models.list({ limit: 1000 })", models, candidates };
}

type AnthropicToolPair = { tool: string; beta: string };

const ANTHROPIC_TOOL_PAIRS: AnthropicToolPair[] = [
	{ tool: "computer_20251124", beta: "computer-use-2025-11-24" },
	{ tool: "computer_20250124", beta: "computer-use-2025-01-24" },
	{ tool: "computer_20241022", beta: "computer-use-2024-10-22" },
];

async function smokeAnthropic(client: any, model: string): Promise<Record<string, unknown>> {
	const attempts: Record<string, unknown>[] = [];
	const runtimePair = anthropicRuntimeToolPair(model);
	for (const pair of orderAnthropicPairs(runtimePair)) {
		try {
			const response = await client.beta.messages.create({
				model,
				max_tokens: 64,
				messages: [{ role: "user", content: "Use the computer tool to take a screenshot. Do not answer in text." }],
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
			const actions = calls.map((call) => call?.input?.action).filter(Boolean);
			const result = {
				status: calls.length > 0 ? "pass" : "inconclusive",
				tool_name: "computer",
				tool_version: pair.tool,
				beta_header: pair.beta,
				runtime_tool_version: runtimePair.tool,
				runtime_beta_header: runtimePair.beta,
				runtime_compatible: calls.length > 0 && pair.tool === runtimePair.tool && pair.beta === runtimePair.beta,
				observed_actions: unique(actions),
				response_item_types: unique(content.map((block) => block?.type).filter(Boolean)),
				stop_reason: response.stop_reason ?? null,
				error: null,
			};
			if (result.status === "pass") return result;
			attempts.push(result);
		} catch (err) {
			attempts.push(smokeError(err, { tool_name: "computer", tool_version: pair.tool, beta_header: pair.beta }));
		}
	}
	return { status: "fail", attempts, error: attempts.at(-1)?.error ?? "all tool versions failed" };
}

function orderAnthropicPairs(runtimePair: AnthropicToolPair): AnthropicToolPair[] {
	const rest = ANTHROPIC_TOOL_PAIRS.filter((pair) => pair.tool !== runtimePair.tool || pair.beta !== runtimePair.beta);
	return [runtimePair, ...rest];
}

function anthropicRuntimeToolPair(model: string): AnthropicToolPair {
	const id = model.toLowerCase();
	if (
		id.startsWith("claude-opus-4-8") ||
		id.startsWith("claude-opus-4-7") ||
		id.startsWith("claude-opus-4-6") ||
		id.startsWith("claude-opus-4-5") ||
		id.startsWith("claude-sonnet-4-6") ||
		id.startsWith("claude-fable-5")
	) {
		return { tool: "computer_20251124", beta: "computer-use-2025-11-24" };
	}
	return { tool: "computer_20250124", beta: "computer-use-2025-01-24" };
}

async function discoverGemini(args: Args): Promise<Record<string, unknown>> {
	const { GoogleGenAI } = await import("@google/genai");
	const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
	const client = new GoogleGenAI({ apiKey });
	const rawModels = await collectAsync(client.models.list());
	const models: ModelResult[] = rawModels.map((m) => ({
		id: normalizeGeminiModelId(m.name ?? m.id ?? m.baseModelId),
		name: m.name ?? null,
		display_name: m.displayName ?? m.display_name ?? m.name ?? m.id,
		created_at: null,
		raw: m,
		supports_generation: hasGenerateContent(m),
	}));
	const geminiCandidates = unique([
		...GEMINI_DOC_COMPUTER_USE_MODELS,
		...rankGeminiCandidates(models.filter((m) => m.supports_generation && likelyGeminiCandidate(m.id))).map((m) => m.id),
	]);
	const candidates = explicitOrCandidates(args, geminiCandidates);
	if (args.smoke) {
		await Promise.all(candidates.map(async (id) => {
			const model = models.find((m) => m.id === id || m.name === id) ?? { id, display_name: id, supports_generation: true };
			model.computer_use = await smokeGemini(client, id);
			if (!models.find((m) => m.id === id || m.name === id)) models.unshift(model);
		}));
	}
	await annotateCuaSupport("gemini", models);
	return { provider: "gemini", metadata_source: "client.models.list()", models, candidates };
}

async function discoverYutori(args: Args): Promise<Record<string, unknown>> {
	const openapi = await fetchYutoriOpenApi();
	const ids = unique([
		...extractYutoriModelIds(openapi.raw),
		...YUTORI_DOC_MODELS,
	]);
	const models: ModelResult[] = ids.map((id) => ({
		id,
		display_name: yutoriDisplayName(id),
		created_at: yutoriCreatedAt(id),
		raw: { source: "docs.yutori.com/openapi.json" },
		supports_generation: true,
		model_docs: {
			navigator_docs: "https://docs.yutori.com/reference/navigator",
			n1_docs: "https://docs.yutori.com/reference/n1",
			n15_docs: "https://docs.yutori.com/reference/n1-5",
			openapi_ok: openapi.ok,
			tool_set: id.startsWith("n1.5") ? "browser_tools_core-20260403" : "legacy_fixed",
			disable_tools: id.startsWith("n1.5") ? "supported" : "not_supported",
			coordinate_space: "1000x1000",
		},
	}));
	const candidates = explicitOrCandidates(args, ids);
	if (args.smoke) {
		await Promise.all(candidates.map(async (id) => {
			const model = models.find((m) => m.id === id) ?? {
				id,
				display_name: yutoriDisplayName(id),
				supports_generation: true,
			};
			model.computer_use = await smokeYutori(id);
			if (!models.find((m) => m.id === id)) models.unshift(model);
		}));
	}
	await annotateCuaSupport("yutori", models);
	return {
		provider: "yutori",
		metadata_source: "https://docs.yutori.com/openapi.json + Navigator docs",
		openapi: openapi.summary,
		models,
		candidates,
	};
}

async function fetchYutoriOpenApi(): Promise<{ ok: boolean; raw: unknown; summary: Record<string, unknown> }> {
	const url = "https://docs.yutori.com/openapi.json";
	try {
		const response = await fetch(url);
		const raw = await response.json();
		return {
			ok: response.ok,
			raw,
			summary: {
				url,
				ok: response.ok,
				model_ids: extractYutoriModelIds(raw),
			},
		};
	} catch (err) {
		return {
			ok: false,
			raw: undefined,
			summary: { url, ok: false, error: publicError(err) },
		};
	}
}

function extractYutoriModelIds(raw: unknown): string[] {
	const found: string[] = [];
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const obj = value as Record<string, unknown>;
		if (Array.isArray(obj.enum)) {
			for (const item of obj.enum) {
				if (typeof item === "string" && /^n1(?:\.5)?-/.test(item)) found.push(item);
			}
		}
		for (const item of Object.values(obj)) visit(item);
	};
	visit(raw);
	return unique(found);
}

function yutoriDisplayName(id: string): string {
	if (id.startsWith("n1.5")) return `Yutori Navigator ${id.replace("n1.5", "n1.5")}`;
	return `Yutori Navigator ${id.replace("n1", "n1")}`;
}

function yutoriCreatedAt(id: string): string | null {
	const match = id.match(/-(\d{4})(\d{2})(\d{2})$/);
	if (!match) return null;
	return `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`;
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

async function smokeYutori(model: string): Promise<SmokeResult> {
	try {
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
					{ type: "text", text: "Use the browser action tool to inspect or interact with this page. Do not answer in text." },
					{ type: "image_url", image_url: { url: "https://docs.yutori.com/assets/google_homepage_2024.jpg" } },
				],
			}],
			max_completion_tokens: 128,
			temperature: 0.3,
		});
		const choice = response.choices?.[0];
		const toolCalls: any[] = choice?.message?.tool_calls ?? [];
		return {
			status: toolCalls.length > 0 ? "pass" : "inconclusive",
			tool_name: "browser_actions",
			tool_version: model.startsWith("n1.5") ? "n1.5" : "n1",
			beta_header: null,
			observed_actions: unique(toolCalls.map((call) => call?.function?.name).filter(Boolean)),
			response_item_types: unique([
				choice?.message?.content ? "text" : undefined,
				toolCalls.length ? "tool_calls" : undefined,
			].filter(Boolean) as string[]),
			finish_reason: choice?.finish_reason ?? null,
			accepts_image_tool_results: "assumed-from-docs",
			error: null,
		};
	} catch (err) {
		return smokeError(err, { tool_name: "browser_actions" });
	}
}

async function discoverTzafon(args: Args): Promise<Record<string, unknown>> {
	const Lightcone = await importDefault("@tzafon/lightcone", "Lightcone");
	const client = new Lightcone({ apiKey: process.env.TZAFON_API_KEY });
	const modelList = await fetchTzafonModels(client);
	const ids = unique([
		...modelList.ids,
		...TZAFON_KNOWN_MODELS,
	]);
	const models: ModelResult[] = ids.map((id) => ({
		id,
		display_name: tzafonDisplayName(id),
		raw: modelList.rawById[id] ?? { source: "known-model-fallback" },
		supports_generation: true,
		model_docs: {
			docs: "https://docs.lightcone.ai",
			responses_endpoint: "supported",
			function_calling: "supported",
			computer_use: "supported",
			coordinate_space: "0-999",
			model_list_endpoint: modelList.source,
		},
	}));
	const candidates = explicitOrCandidates(args, ids);
	if (args.smoke) {
		await Promise.all(candidates.map(async (id) => {
			const model = models.find((m) => m.id === id) ?? {
				id,
				display_name: tzafonDisplayName(id),
				supports_generation: true,
			};
			model.computer_use = await smokeTzafon(client, id);
			if (!models.find((m) => m.id === id)) models.unshift(model);
		}));
	}
	await annotateCuaSupport("tzafon", models);
	return {
		provider: "tzafon",
		metadata_source: modelList.source,
		model_list_error: modelList.error ?? null,
		models,
		candidates,
	};
}

async function fetchTzafonModels(client: any): Promise<{
	source: string;
	ids: string[];
	rawById: Record<string, unknown>;
	raw?: unknown;
	error?: string;
}> {
	try {
		const raw = await client.models.list();
		const entries = extractTzafonModelEntries(raw);
		const rawById: Record<string, unknown> = {};
		for (const entry of entries) rawById[entry.id] = entry.raw;
		return {
			source: "@tzafon/lightcone models.list()",
			ids: entries.map((entry) => entry.id),
			rawById,
			raw,
		};
	} catch (err) {
		return {
			source: "known-model-fallback (models.list unavailable)",
			ids: [],
			rawById: {},
			error: publicError(err),
		};
	}
}

function extractTzafonModelEntries(raw: unknown): Array<{ id: string; raw: unknown }> {
	const entries: Array<{ id: string; raw: unknown }> = [];
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const obj = value as Record<string, unknown>;
		const id = obj.id ?? obj.name ?? obj.model;
		if (typeof id === "string" && id.trim()) {
			entries.push({ id: id.trim(), raw: obj });
		}
		for (const child of Object.values(obj)) {
			if (child && typeof child === "object") visit(child);
		}
	};
	visit(raw);
	return entries;
}

function tzafonDisplayName(id: string): string {
	if (id === "tzafon.northstar-cua-fast") return "Tzafon Northstar CUA Fast";
	return id;
}

async function smokeTzafon(client: any, model: string): Promise<SmokeResult> {
	try {
		const response = await client.responses.create({
			model,
			input: [{
				role: "user",
				content: [
					{ type: "input_text", text: "Use the computer function tools to inspect this page. Do not answer in text." },
					{ type: "input_image", image_url: "https://docs.yutori.com/assets/google_homepage_2024.jpg", detail: "auto" },
				],
			}],
			tools: TZAFON_FUNCTION_TOOLS,
			instructions: "The screen's coordinate space is a 0-999 grid. Call a function tool instead of answering in text.",
			temperature: 0,
			max_output_tokens: 128,
		});
		const output: any[] = response.output ?? [];
		const functionCalls = output.filter((item) => item?.type === "function_call");
		const computerCalls = output.filter((item) => item?.type === "computer_call");
		const computerActions = computerCalls.flatMap((call) => Array.isArray(call.actions) ? call.actions : call.action ? [call.action] : []);
		return {
			status: functionCalls.length || computerCalls.length ? "pass" : "inconclusive",
			tool_name: functionCalls.length ? "function_tools" : "computer_use",
			tool_version: null,
			beta_header: null,
			observed_actions: unique([
				...functionCalls.map((call) => call?.name).filter(Boolean),
				...computerActions.map((action) => action?.type).filter(Boolean),
			]),
			response_item_types: unique(output.map((item) => item?.type).filter(Boolean)),
			error: null,
		};
	} catch (err) {
		return smokeError(err, { tool_name: "function_tools" });
	}
}

const TZAFON_FUNCTION_TOOLS = [
	{ type: "function", name: "click", description: "Single click at (x, y) in 0-999 grid.", parameters: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, button: { type: "string", enum: ["left", "right"] } }, required: ["x", "y"] } },
	{ type: "function", name: "double_click", description: "Double click at (x, y) in 0-999 grid.", parameters: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } }, required: ["x", "y"] } },
	{ type: "function", name: "point_and_type", description: "Click at position then type text.", parameters: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, text: { type: "string" }, press_enter: { type: "boolean" } }, required: ["x", "y", "text"] } },
	{ type: "function", name: "key", description: "Press key combo.", parameters: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"] } },
	{ type: "function", name: "scroll", description: "Scroll at (x, y) in 0-999 grid.", parameters: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, dy: { type: "integer" } }, required: ["x", "y", "dy"] } },
	{ type: "function", name: "drag", description: "Drag from (x1, y1) to (x2, y2) in 0-999 grid.", parameters: { type: "object", properties: { x1: { type: "integer" }, y1: { type: "integer" }, x2: { type: "integer" }, y2: { type: "integer" } }, required: ["x1", "y1", "x2", "y2"] } },
	{ type: "function", name: "done", description: "Task complete. Report findings.", parameters: { type: "object", properties: { result: { type: "string" } }, required: ["result"] } },
];

async function annotateCuaSupport(provider: Provider, models: ModelResult[]): Promise<void> {
	const piProvider = provider === "gemini" ? "google" : provider;
	const getModel = await import("@earendil-works/pi-ai").then((mod) => mod.getModel).catch(() => undefined);
	for (const model of models) {
		const inRegistry = getModel ? !!getModel(piProvider as never, model.id as never) : false;
		const localAdapterSupport = localAdapterSupportStatus(provider, model);
		model.cua = {
			provider_inference: provider,
			pi_ai_registry: inRegistry ? "present" : "missing",
			dynamic_model_fallback: "available",
			local_adapter_support: localAdapterSupport,
		};
	}
}

function localAdapterSupportStatus(provider: Provider, model: ModelResult): string {
	if (!model.computer_use || !("status" in model.computer_use) || model.computer_use.status !== "pass") {
		return "needs-check";
	}
	if (provider !== "anthropic") return "passes-smoke";
	return model.computer_use.runtime_compatible === true ? "passes-smoke" : "smoke-pass-runtime-mismatch";
}

function hasGenerateContent(model: any): boolean {
	const actions = model.supportedActions ?? model.supported_actions ?? model.supportedGenerationMethods ?? [];
	return Array.isArray(actions) && actions.some((a) => String(a).toLowerCase() === "generatecontent");
}

function likelyGeminiCandidate(id: string): boolean {
	const lower = String(id ?? "").toLowerCase();
	return lower.includes("gemini") && !lower.includes("embedding") && !lower.includes("tts") && !lower.includes("imagen");
}

function rankGeminiCandidates(models: ModelResult[]): ModelResult[] {
	return [...models].sort((a, b) => geminiScore(b.id) - geminiScore(a.id));
}

function geminiScore(id: string): number {
	const lower = id.toLowerCase();
	let score = 0;
	if (lower.includes("computer-use")) score += 100;
	if (lower.includes("gemini-3")) score += 80;
	if (lower.includes("preview")) score += 20;
	if (lower.includes("flash")) score += 10;
	if (lower.includes("pro")) score += 5;
	return score;
}

async function smokeGemini(client: any, model: string): Promise<Record<string, unknown>> {
	const configVariants = [
		{ tools: [{ computerUse: { environment: "ENVIRONMENT_BROWSER" } }], maxOutputTokens: 64 },
		{ tools: [{ computer_use: { environment: "ENVIRONMENT_BROWSER" } }], maxOutputTokens: 64 },
	];
	const attempts: Record<string, unknown>[] = [];
	for (const config of configVariants) {
		try {
			const response = await client.models.generateContent({
				model,
				contents: [{ role: "user", parts: [{ text: "Use the computer-use tool to open the web browser. Do not answer in text." }] }],
				config,
			});
			const parts: any[] = response?.candidates?.[0]?.content?.parts ?? [];
			const calls = parts.map((part) => part.functionCall ?? part.function_call).filter(Boolean);
			const actions = calls.map((call) => call.name).filter(Boolean);
			const result = {
				status: calls.length > 0 ? "pass" : "inconclusive",
				tool_name: "computer_use",
				tool_version: null,
				beta_header: null,
				observed_actions: unique(actions),
				response_item_types: unique(parts.map((part) => part.functionCall || part.function_call ? "function_call" : part.text ? "text" : Object.keys(part)[0]).filter(Boolean)),
				error: null,
			};
			if (result.status === "pass") return result;
			attempts.push(result);
		} catch (err) {
			attempts.push(smokeError(err, { tool_name: "computer_use" }));
		}
	}
	return { status: "fail", attempts, error: attempts.at(-1)?.error ?? "all config variants failed" };
}

function explicitOrCandidates(args: Args, ids: string[]): string[] {
	return (args.models.length ? args.models : ids).slice(0, args.candidateLimit);
}

async function importDefault(pkg: string, named: string): Promise<any> {
	try {
		const mod = await import(pkg);
		return mod.default ?? mod[named];
	} catch (err) {
		throw new Error(`failed to import ${pkg}. Run npm install first. ${publicError(err)}`);
	}
}

async function collectAsync(value: any): Promise<any[]> {
	const awaited = await value;
	if (Array.isArray(awaited)) return awaited;
	if (Array.isArray(awaited?.data)) return awaited.data;
	if (Array.isArray(awaited?.models)) return awaited.models;
	if (Array.isArray(awaited?.items)) return awaited.items;
	if (typeof awaited?.[Symbol.asyncIterator] === "function") {
		const out: any[] = [];
		for await (const item of awaited) out.push(item);
		return out;
	}
	if (typeof awaited?.[Symbol.iterator] === "function") return Array.from(awaited);
	return [];
}

function normalizeGeminiModelId(id: unknown): string {
	const value = String(id ?? "");
	return value.startsWith("models/") ? value.slice("models/".length) : value;
}

function smokeError(err: unknown, extra: Record<string, unknown> = {}): SmokeResult {
	return {
		status: isUnsupportedError(err) ? "unsupported" : "fail",
		...extra,
		observed_actions: [],
		response_item_types: [],
		error: publicError(err),
	};
}

function isUnsupportedError(err: unknown): boolean {
	const msg = publicError(err).toLowerCase();
	return msg.includes("unsupported") || msg.includes("not support") || msg.includes("not enabled") || msg.includes("not compatible") || msg.includes("invalid tool");
}

function publicError(err: unknown): string {
	if (err && typeof err === "object" && "status" in err && "message" in err) {
		return `${String((err as { status: unknown }).status)}: ${String((err as { message: unknown }).message)}`;
	}
	return err instanceof Error ? err.message : String(err);
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
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
