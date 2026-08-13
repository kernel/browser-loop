#!/usr/bin/env tsx
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

type Provider = "openai" | "anthropic" | "gemini" | "meta" | "xai" | "moonshot";

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

const PROVIDERS: Provider[] = ["openai", "anthropic", "gemini", "meta", "xai", "moonshot"];
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
  --provider <all|openai|anthropic|gemini|meta|xai|moonshot>
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
		if (provider === "xai") return await discoverXai(args);
		if (provider === "moonshot") return await discoverMoonshot(args);
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
		const screenshot = await readFile(fixtureScreenshotPath());
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

async function discoverXai(args: Args): Promise<Record<string, unknown>> {
	const OpenAI = await importDefault("openai", "OpenAI");
	const client = new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: "https://api.x.ai/v1" });
	const rawModels = await collectAsync(client.models.list());
	const models: ModelResult[] = rawModels.map((m) => ({
		id: String(m.id),
		display_name: String(m.id),
		created_at: typeof m.created === "number" && m.created > 0 ? new Date(m.created * 1000).toISOString() : null,
		raw: m,
		supports_generation: likelyXaiGenerationModel(String(m.id)),
		model_docs: {
			url: String(m.id) === "grok-4.5" ? "https://docs.x.ai/developers/grok-4-5" : "https://docs.x.ai/developers/models",
			responses_endpoint: "supported",
			function_calling: "supported",
			image_input: "verify-per-model",
			coordinate_space: "CUA-defined 0-1000",
		},
	}));
	const candidates = explicitOrCandidates(
		args,
		models
			.filter((model) => model.supports_generation)
			.sort(compareXaiCandidates)
			.map((model) => model.id),
	);
	if (args.smoke) {
		await Promise.all(candidates.map(async (id) => {
			const model = models.find((candidate) => candidate.id === id) ?? { id, display_name: id, supports_generation: true };
			model.computer_use = await smokeXai(client, id);
			if (!models.find((candidate) => candidate.id === id)) models.unshift(model);
		}));
	}
	await annotateCuaSupport("xai", models);
	return { provider: "xai", metadata_source: "xAI models.list()", models, candidates };
}

async function smokeXai(client: any, model: string): Promise<SmokeResult> {
	try {
		const screenshot = await readFile(fixtureScreenshotPath());
		const response = await client.responses.create({
			model,
			store: true,
			parallel_tool_calls: false,
			max_output_tokens: 768,
			reasoning: { effort: "low" },
			instructions: "Coordinates are normalized from 0 to 1000 relative to the screenshot.",
			input: [{
				role: "user",
				content: [
					{ type: "input_text", text: "Call the click tool for the sign in link. Do not answer only in text." },
					{ type: "input_image", image_url: `data:image/png;base64,${screenshot.toString("base64")}`, detail: "high" },
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
			reasoning_effort: "low",
			coordinate_space: "0-1000",
			error: null,
		};
	} catch (err) {
		return smokeError(err, { tool_name: "function_tools" });
	}
}

function likelyXaiGenerationModel(id: string): boolean {
	const lower = id.toLowerCase();
	return lower.startsWith("grok-") && !lower.includes("imagine");
}

async function discoverMoonshot(args: Args): Promise<Record<string, unknown>> {
	const OpenAI = await importDefault("openai", "OpenAI");
	const client = new OpenAI({ apiKey: process.env.MOONSHOT_API_KEY, baseURL: "https://api.moonshot.ai/v1" });
	const rawModels = await collectAsync(client.models.list());
	const models: ModelResult[] = rawModels.map((m) => ({
		id: String(m.id),
		display_name: String(m.id),
		created_at: typeof m.created === "number" && m.created > 0 ? new Date(m.created * 1000).toISOString() : null,
		raw: m,
		supports_generation: String(m.id).toLowerCase().startsWith("kimi-"),
		model_docs: {
			url: "https://platform.kimi.ai/docs/api/tool-use",
			chat_completions_endpoint: "supported",
			function_calling: "supported",
			image_input: "verify-per-model",
			coordinate_space: "CUA-defined 0-1 fractions",
		},
	}));
	const candidates = explicitOrCandidates(
		args,
		models
			.filter((model) => model.supports_generation)
			.sort(compareMoonshotCandidates)
			.map((model) => model.id),
	);
	if (args.smoke) {
		await Promise.all(candidates.map(async (id) => {
			const model = models.find((candidate) => candidate.id === id) ?? { id, display_name: id, supports_generation: true };
			model.computer_use = await smokeMoonshot(client, id);
			if (!models.find((candidate) => candidate.id === id)) models.unshift(model);
		}));
	}
	await annotateCuaSupport("moonshot", models);
	return { provider: "moonshot", metadata_source: "Moonshot models.list()", models, candidates };
}

async function smokeMoonshot(client: any, model: string): Promise<SmokeResult> {
	try {
		const screenshot = await readFile(fixtureScreenshotPath());
		const response = await client.chat.completions.create({
			model,
			parallel_tool_calls: false,
			max_tokens: 8192,
			messages: [
				{
					role: "system",
					content: "Coordinates are fractions of the screenshot, normalized from 0 to 1.",
				},
				{
					role: "user",
					content: [
						{ type: "text", text: "Call the click tool for the sign in link. Do not answer only in text." },
						{ type: "image_url", image_url: { url: `data:image/png;base64,${screenshot.toString("base64")}` } },
					],
				},
			],
			tools: [{
				type: "function",
				function: {
					name: "click",
					description: "Click at coordinates given as 0-1 fractions of the screenshot.",
					parameters: {
						type: "object",
						properties: { x: { type: "number" }, y: { type: "number" } },
						required: ["x", "y"],
						additionalProperties: false,
					},
				},
			}],
		});
		const calls: any[] = response.choices?.[0]?.message?.tool_calls ?? [];
		return {
			status: calls.length > 0 ? "pass" : "inconclusive",
			tool_name: "function_tools",
			tool_version: null,
			beta_header: null,
			observed_actions: unique(calls.map((call) => call?.function?.name).filter(Boolean)),
			response_item_types: unique([response.choices?.[0]?.finish_reason].filter(Boolean)),
			coordinate_space: "0-1 fractions",
			error: null,
		};
	} catch (err) {
		return smokeError(err, { tool_name: "function_tools" });
	}
}

function compareMoonshotCandidates(a: ModelResult, b: ModelResult): number {
	if (a.id === "kimi-k3") return -1;
	if (b.id === "kimi-k3") return 1;
	return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
}

function compareXaiCandidates(a: ModelResult, b: ModelResult): number {
	if (a.id === "grok-4.5") return -1;
	if (b.id === "grok-4.5") return 1;
	return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
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

async function annotateCuaSupport(provider: Provider, models: ModelResult[]): Promise<void> {
	const piProvider = provider === "gemini" ? "google" : provider === "moonshot" ? "moonshotai" : provider;
	const getBuiltinModel = await import("@earendil-works/pi-ai/providers/all").then((mod) => mod.getBuiltinModel).catch(() => undefined);
	for (const model of models) {
		const inRegistry = getBuiltinModel ? !!getBuiltinModel(piProvider as never, model.id as never) : false;
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

function fixtureScreenshotPath(): string {
	const path = [
		join(process.cwd(), "examples", "screenshot.png"),
		join(process.cwd(), "packages", "ai", "examples", "screenshot.png"),
	].find(existsSync);
	if (!path) throw new Error("could not find packages/ai/examples/screenshot.png");
	return path;
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
