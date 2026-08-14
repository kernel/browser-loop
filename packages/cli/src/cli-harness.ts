import {
	InMemorySessionRepo,
	type JsonlSessionMetadata,
	type JsonlSessionRepo,
	NodeExecutionEnv,
	type Session,
	type Skill,
} from "@onkernel/cua-agent";
import {
	cuaApiKeyEnvVarsForProvider,
	type CuaModelRef,
	type CuaToolMenuEntry,
	cuaToolMenu,
	isCuaToolSpec,
	parseCuaModelRef,
	requireCuaEnvApiKey,
} from "@onkernel/cua-ai";
import { parseArgs } from "node:util";
import { stderr, stdout } from "node:process";
import type { CuaBrowserHandle } from "./harness-browser";
import {
	type ActionRequest,
	type ModelActionType,
} from "./action/prompts";
import { runAction, emitCompact } from "./action/harness-runner";
import { buildCuaHarness, defaultApplicationTools, defaultInteractionTools } from "./harness";
import { provisionBrowser } from "./harness-browser";
import { DEFAULT_CUA_MODEL_REF, listSupportedModels, resolveCuaModelRef } from "./harness-models";
import {
	attachNamedSession,
	formatRelativeAge,
	listNamedSessions,
	type NamedSessionMetadata,
	readNamedSession,
	recordSessionModel,
	recordTranscriptPath,
	shortKernelId,
	startNamedSession,
	stopNamedSession,
	validateSlug,
} from "./harness-named-sessions";
import {
	appendBrowserEntry,
	createSession,
	createSessionRepo,
	findLatestSession,
	listSessionsForCwd,
	openSession,
	readMetadataFromFile,
	resolveSessionRef,
} from "./harness-sessions";
import { type ContextFile, discoverCuaSkills } from "./harness-skills";
import { runPrint } from "./print";

const MODELS_HELP = `cua models — list selectable -m/--model values

Usage:
  cua models
  cua models -p openai
  cua models --provider anthropic
  cua models --json

Options:
  -p, --provider <id>  Filter by provider id (any pi-ai provider; gemini/moonshot are aliases)
      --json           Output JSON
  -h, --help           Show this help
`;

interface ModelsFlags {
	provider?: string;
	json: boolean;
	help: boolean;
}

function parseModelsArgs(argv: string[]): ModelsFlags {
	const parsed = parseArgs({
		args: argv,
		options: {
			provider: { type: "string", short: "p" },
			json: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: true,
		strict: true,
	});
	const positionalProvider = parsed.positionals[0];
	if (parsed.positionals.length > 1) {
		throw new Error(`unexpected arguments: ${parsed.positionals.slice(1).join(" ")}`);
	}
	return {
		provider: (parsed.values.provider as string | undefined) ?? positionalProvider,
		json: !!parsed.values.json,
		help: !!parsed.values.help,
	};
}

/** `cua models` subcommand backed by cua-ai's `listCuaModels()`. */
export async function runModelsSubcommand(argv: string[]): Promise<number> {
	let flags: ModelsFlags;
	try {
		flags = parseModelsArgs(argv);
	} catch (err) {
		stderr.write(`${(err as Error).message}\n\n${MODELS_HELP}`);
		return 2;
	}
	if (flags.help) {
		stdout.write(MODELS_HELP);
		return 0;
	}
	let models;
	try {
		models = listSupportedModels(flags.provider);
	} catch (err) {
		stderr.write(`${(err as Error).message}\n`);
		return 2;
	}
	if (flags.json) {
		stdout.write(`${JSON.stringify(models, null, 2)}\n`);
		return 0;
	}
	stdout.write(formatModelsTable(models));
	return 0;
}

function formatModelsTable(models: ReturnType<typeof listSupportedModels>): string {
	const rows = models.map((entry) => ({
		ref: entry.ref,
		provider: entry.provider,
		model: entry.model,
		default: entry.ref === DEFAULT_CUA_MODEL_REF ? "yes" : "",
		native: entry.nativeSurfaces.join(","),
		name: entry.name,
	}));
	const headers = { ref: "REF", provider: "PROVIDER", model: "MODEL", default: "DEFAULT", native: "NATIVE", name: "NAME" };
	const widths = {
		ref: columnWidth(headers.ref, rows.map((r) => r.ref)),
		provider: columnWidth(headers.provider, rows.map((r) => r.provider)),
		model: columnWidth(headers.model, rows.map((r) => r.model)),
		default: columnWidth(headers.default, rows.map((r) => r.default)),
		native: columnWidth(headers.native, rows.map((r) => r.native)),
		name: columnWidth(headers.name, rows.map((r) => r.name)),
	};
	const lines = [
		[
			headers.ref.padEnd(widths.ref),
			headers.provider.padEnd(widths.provider),
			headers.model.padEnd(widths.model),
			headers.default.padEnd(widths.default),
			headers.native.padEnd(widths.native),
			headers.name,
		].join("  "),
		[
			"-".repeat(widths.ref),
			"-".repeat(widths.provider),
			"-".repeat(widths.model),
			"-".repeat(widths.default),
			"-".repeat(widths.native),
			"-".repeat(widths.name),
		].join("  "),
	];
	for (const row of rows) {
		lines.push(
			[
				row.ref.padEnd(widths.ref),
				row.provider.padEnd(widths.provider),
				row.model.padEnd(widths.model),
				row.default.padEnd(widths.default),
				row.native.padEnd(widths.native),
				row.name,
			].join("  "),
		);
	}
	return `${lines.join("\n")}\n`;
}

const TOOLS_HELP = `cua tools — list the tools CUA can offer for a model

Usage:
  cua tools
  cua tools -m anthropic:claude-opus-5
  cua tools --json

Options:
  -m, --model <ref>    Model to build the menu for (default: the CLI default model)
      --json           Output JSON
  -h, --help           Show this help

Availability is decided by compiling the resulting catalog, so a tool listed as
available is one the selected model will accept.
`;

interface ToolsFlags {
	model?: string;
	json: boolean;
	help: boolean;
}

function parseToolsArgs(argv: string[]): ToolsFlags {
	const parsed = parseArgs({
		args: argv,
		options: {
			model: { type: "string", short: "m" },
			json: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: true,
		strict: true,
	});
	if (parsed.positionals.length > 0) {
		throw new Error(`unexpected arguments: ${parsed.positionals.join(" ")}`);
	}
	return {
		model: parsed.values.model as string | undefined,
		json: !!parsed.values.json,
		help: !!parsed.values.help,
	};
}

/** `cua tools` subcommand: the model-derived tool menu, as `cua models` is to the catalog. */
export async function runToolsSubcommand(argv: string[]): Promise<number> {
	let flags: ToolsFlags;
	try {
		flags = parseToolsArgs(argv);
	} catch (err) {
		stderr.write(`${(err as Error).message}\n\n${TOOLS_HELP}`);
		return 2;
	}
	if (flags.help) {
		stdout.write(TOOLS_HELP);
		return 0;
	}
	let menu: CuaToolMenuEntry[];
	let modelRef: CuaModelRef;
	try {
		modelRef = resolveCuaModelRef(flags.model);
		menu = cuaToolMenu(modelRef, defaultInteractionTools(modelRef).filter(isCuaToolSpec));
	} catch (err) {
		stderr.write(`${(err as Error).message}\n`);
		return 2;
	}
	if (flags.json) {
		stdout.write(`${JSON.stringify({ model: modelRef, tools: menu.map(toJsonEntry) }, null, 2)}\n`);
		return 0;
	}
	stdout.write(formatToolsTable(modelRef, menu));
	return 0;
}

function toJsonEntry(entry: CuaToolMenuEntry) {
	return {
		key: entry.key,
		label: entry.label,
		group: entry.group,
		selected: entry.selected,
		available: entry.available,
		...(entry.unavailableReason ? { unavailable_reason: entry.unavailableReason } : {}),
		...(entry.description ? { description: entry.description } : {}),
	};
}

function formatToolsTable(modelRef: CuaModelRef, menu: readonly CuaToolMenuEntry[]): string {
	const rows = menu.map((entry) => ({
		tool: entry.label,
		group: entry.group,
		state: entry.available ? (entry.selected ? "default" : "available") : "unavailable",
		note: entry.available ? entry.description ?? "" : entry.unavailableReason ?? "",
	}));
	const headers = { tool: "TOOL", group: "GROUP", state: "STATE", note: "NOTE" };
	const widths = {
		tool: columnWidth(headers.tool, rows.map((r) => r.tool)),
		group: columnWidth(headers.group, rows.map((r) => r.group)),
		state: columnWidth(headers.state, rows.map((r) => r.state)),
	};
	const lines = [
		`model: ${modelRef}`,
		"",
		[headers.tool.padEnd(widths.tool), headers.group.padEnd(widths.group), headers.state.padEnd(widths.state), headers.note].join("  "),
		["-".repeat(widths.tool), "-".repeat(widths.group), "-".repeat(widths.state), "-".repeat(headers.note.length)].join("  "),
	];
	for (const row of rows) {
		lines.push([row.tool.padEnd(widths.tool), row.group.padEnd(widths.group), row.state.padEnd(widths.state), row.note].join("  "));
	}
	return `${lines.join("\n")}\n`;
}

function columnWidth(header: string, values: string[]): number {
	return Math.max(header.length, ...values.map((value) => value.length));
}

export interface HarnessCliFlags {
	verbose: boolean;
	profileSaveChanges: boolean;
	continueLatest: boolean;
	resumePicker: boolean;
	noSession: boolean;
	noSkills: boolean;
	debugTui: boolean;
	jsonlIncludeDeltas: boolean;
	jsonlIncludeImages: boolean;
	model?: string;
	thinking?: string;
	browserProfile?: string;
	browserProxy?: string;
	browserTimeout?: number;
	maxSteps?: number;
	out?: string;
	output?: string;
	filter?: string;
	imageProtocol?: string;
	namedSession?: string;
	sessionRef?: string;
	sessionDir?: string;
	skillPaths: string[];
}

export interface KernelAuth {
	kernelApiKey: string;
	kernelBaseUrl?: string;
}

interface ResolvedAuth extends KernelAuth {
	modelRef: CuaModelRef;
}

export function requireKernelApiKey(): { apiKey: string; baseUrl?: string } {
	const apiKey = process.env.KERNEL_API_KEY?.trim();
	if (!apiKey) throw new Error("missing Kernel API key (set KERNEL_API_KEY)");
	const baseUrl = process.env.KERNEL_BASE_URL?.trim() || undefined;
	return { apiKey, baseUrl };
}

function resolveAuth(flags: HarnessCliFlags): ResolvedAuth {
	const { apiKey, baseUrl } = requireKernelApiKey();
	const modelRef = resolveCuaModelRef(flags.model);
	const { provider } = parseCuaModelRef(modelRef);
	// Preflight only where CUA documents the variable names; for any other
	// pi-ai provider the credential is pi's to resolve when it streams, and
	// failing here would refuse a model that works.
	if (cuaApiKeyEnvVarsForProvider(provider).length > 0) requireCuaEnvApiKey(provider);
	return { kernelApiKey: apiKey, kernelBaseUrl: baseUrl, modelRef };
}

export interface ProvisionedBrowser {
	handle: CuaBrowserHandle;
	named?: NamedSessionMetadata;
}

export async function provisionForFlags(flags: HarnessCliFlags, auth: KernelAuth): Promise<ProvisionedBrowser> {
	if (flags.namedSession) {
		const { client, browser, meta } = await attachNamedSession({
			name: flags.namedSession,
			apiKey: auth.kernelApiKey,
			baseUrl: auth.kernelBaseUrl,
		});
		if (flags.verbose) {
			stderr.write(`[cua] attached named session "${meta.name}" (browser=${browser.session_id})\n`);
			if (browser.browser_live_view_url) stderr.write(`[cua] live view=${browser.browser_live_view_url}\n`);
		}
		const handle: CuaBrowserHandle = {
			client,
			browser,
			profileId: meta.profile_id,
			async close(): Promise<void> {
				// no-op: named-session browsers are torn down via `cua session stop`.
			},
		};
		return { handle, named: meta };
	}
	if (flags.verbose) stderr.write("[cua] provisioning Kernel browser...\n");
	const handle = await provisionBrowser({
		apiKey: auth.kernelApiKey,
		baseUrl: auth.kernelBaseUrl,
		timeoutSeconds: flags.browserTimeout,
		profileSelector: flags.browserProfile,
		saveChanges: flags.profileSaveChanges,
		proxySelector: flags.browserProxy,
	});
	if (flags.verbose) {
		stderr.write(`[cua] browser session=${handle.browser.session_id}\n`);
		if (handle.browser.browser_live_view_url) {
			stderr.write(`[cua] live view=${handle.browser.browser_live_view_url}\n`);
		}
	}
	return { handle };
}

interface ResolvedSession {
	session: Session;
	transcriptPath: string;
	resumed: boolean;
}

async function resolveSession(
	repo: JsonlSessionRepo,
	cwd: string,
	flags: HarnessCliFlags,
	namedMeta?: NamedSessionMetadata,
): Promise<ResolvedSession | undefined> {
	if (flags.noSession) return undefined;
	if (flags.sessionRef) {
		const metadata = await resolveSessionRef(repo, cwd, flags.sessionRef);
		return { session: await openSession(repo, metadata), transcriptPath: metadata.path, resumed: true };
	}
	if (flags.continueLatest) {
		const latest = await findLatestSession(repo, cwd);
		if (!latest) {
			stderr.write("[cua] no previous session for this cwd; starting fresh\n");
			const fresh = await createSession(repo, cwd);
			const metadata = await fresh.getMetadata();
			return { session: fresh, transcriptPath: metadata.path, resumed: false };
		}
		return { session: await openSession(repo, latest), transcriptPath: latest.path, resumed: true };
	}
	if (flags.resumePicker) {
		const sessions = await listSessionsForCwd(repo, cwd);
		if (sessions.length === 0) {
			stderr.write("[cua] no previous sessions for this cwd; starting fresh\n");
			const fresh = await createSession(repo, cwd);
			const metadata = await fresh.getMetadata();
			return { session: fresh, transcriptPath: metadata.path, resumed: false };
		}
		const picked = await pickSession(sessions);
		if (!picked) {
			const fresh = await createSession(repo, cwd);
			const metadata = await fresh.getMetadata();
			return { session: fresh, transcriptPath: metadata.path, resumed: false };
		}
		return { session: await openSession(repo, picked), transcriptPath: picked.path, resumed: true };
	}
	if (namedMeta?.transcript_path) {
		const direct = await readMetadataFromFile(namedMeta.transcript_path);
		if (direct) {
			return { session: await openSession(repo, direct), transcriptPath: direct.path, resumed: true };
		}
	}
	const fresh = await createSession(repo, cwd);
	const metadata = await fresh.getMetadata();
	return { session: fresh, transcriptPath: metadata.path, resumed: false };
}

async function pickSession(sessions: JsonlSessionMetadata[]): Promise<JsonlSessionMetadata | undefined> {
	const sorted = [...sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	stderr.write("\nResume which session?\n");
	const limit = Math.min(sorted.length, 20);
	for (let i = 0; i < limit; i++) {
		const s = sorted[i]!;
		stderr.write(`  [${i + 1}] ${s.id.slice(0, 8)} · ${s.createdAt}\n`);
	}
	if (sorted.length > limit) {
		stderr.write(`  (${sorted.length - limit} more not shown; use --session <prefix> to select directly)\n`);
	}
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (await rl.question("Pick a number (or blank to skip): ")).trim();
		if (!answer) return undefined;
		const n = Number(answer);
		if (!Number.isFinite(n) || n < 1 || n > limit) {
			stderr.write("[cua] invalid selection; starting fresh\n");
			return undefined;
		}
		return sorted[n - 1];
	} finally {
		rl.close();
	}
}

interface HarnessRuntime {
	handle: CuaBrowserHandle;
	resolved: ResolvedSession | undefined;
	session: Session;
	skills: Skill[];
	contextFiles: ContextFile[];
	applicationTools: ReturnType<typeof defaultApplicationTools>;
	harness: ReturnType<typeof buildCuaHarness>;
	provider: string;
	modelRef: CuaModelRef;
}

export interface SetupHarnessRuntimeOptions {
	/**
	 * When true, never create or open a JsonlSession; use an InMemorySession instead.
	 * One-shot action subcommands without -s/-c/-r/--session pass this so they
	 * don't pollute the on-disk transcript list. The print path always persists
	 * (so `-c` / `--session latest` keeps working).
	 */
	skipDiskSession?: boolean;
}

/** Default -m from a named session's stored model when not passed explicitly. */
export function applyNamedSessionDefaults(flags: HarnessCliFlags, meta: NamedSessionMetadata): HarnessCliFlags {
	return { ...flags, model: flags.model ?? meta.model };
}

async function setupHarnessRuntime(
	flags: HarnessCliFlags,
	opts: SetupHarnessRuntimeOptions = {},
): Promise<HarnessRuntime> {
	if (flags.namedSession) {
		const named = await readNamedSession(flags.namedSession);
		if (named) flags = applyNamedSessionDefaults(flags, named);
	}
	const auth = resolveAuth(flags);
	const cwd = process.cwd();
	const env = new NodeExecutionEnv({ cwd });
	const { skills, contextFiles } = await discoverCuaSkills({
		cwd,
		env,
		extraPaths: flags.skillPaths,
		disabled: flags.noSkills,
	});

	const provisioned = await provisionForFlags(flags, auth);
	try {
		return await finishHarnessRuntime(flags, auth, provisioned, { cwd, skills, contextFiles, skipDisk: opts.skipDiskSession === true });
	} catch (err) {
		await provisioned.handle.close().catch(() => {});
		throw err;
	}
}

interface FinishHarnessRuntimeContext {
	cwd: string;
	skills: Skill[];
	contextFiles: ContextFile[];
	skipDisk: boolean;
}

async function finishHarnessRuntime(
	flags: HarnessCliFlags,
	auth: ResolvedAuth,
	provisioned: ProvisionedBrowser,
	context: FinishHarnessRuntimeContext,
): Promise<HarnessRuntime> {
	const { cwd, skills, contextFiles } = context;
	const repo = createSessionRepo(flags.sessionDir);

	const skipDisk = context.skipDisk && !hasExplicitSessionFlag(flags);
	const resolved = skipDisk ? undefined : await resolveSession(repo, cwd, flags, provisioned.named);

	let inMemorySession: Session | undefined;
	if (!resolved) {
		const memRepo = new InMemorySessionRepo();
		inMemorySession = await memRepo.create();
	}

	const session = resolved?.session ?? inMemorySession!;
	const { provider } = parseCuaModelRef(auth.modelRef);

	if (resolved) {
		await appendBrowserEntry(session, {
			sessionId: provisioned.handle.browser.session_id,
			liveUrl: provisioned.handle.browser.browser_live_view_url,
			profileId: provisioned.handle.profileId,
			createdAt: Date.now(),
		});
		if (provisioned.named) {
			await recordTranscriptPath(provisioned.named.name, resolved.transcriptPath);
			await recordSessionModel(provisioned.named.name, { model: auth.modelRef });
		}
		if (flags.verbose) {
			stderr.write(`[cua] session=${resolved.transcriptPath}\n`);
			if (resolved.resumed) stderr.write("[cua] resumed prior session into fresh browser\n");
		}
	}

	const thinkingLevel = mapThinkingLevel(flags.thinking);
	const baseUrlOverride = providerBaseUrlOverride(provider);
	const applicationTools = defaultApplicationTools();
	const harness = buildCuaHarness({
		cwd,
		client: provisioned.handle.client,
		browser: provisioned.handle.browser,
		session,
		model: auth.modelRef,
		skills,
		contextFiles,
		thinkingLevel,
		tools: [...defaultInteractionTools(auth.modelRef), ...applicationTools],
		modelBaseUrl: baseUrlOverride,
	});

	return {
		handle: provisioned.handle,
		resolved,
		session,
		skills,
		contextFiles,
		applicationTools,
		harness,
		provider,
		modelRef: auth.modelRef,
	};
}

function hasExplicitSessionFlag(flags: HarnessCliFlags): boolean {
	return (
		!!flags.sessionRef ||
		flags.continueLatest ||
		flags.resumePicker ||
		!!flags.namedSession
	);
}

function providerBaseUrlOverride(provider: string): string | undefined {
	const envName = `${provider.toUpperCase()}_BASE_URL`;
	const value = process.env[envName]?.trim();
	return value && value.length > 0 ? value : undefined;
}

/** Map a `--thinking` flag value to pi's thinking level; unset/empty defaults to `"low"`, and invalid values throw. */
export function mapThinkingLevel(raw: string | undefined): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
	const v = (raw ?? "low").trim().toLowerCase();
	switch (v) {
		case "off":
		case "none":
			return "off";
		case "minimal":
			return "minimal";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return "xhigh";
		case "max":
			return "max";
		case "low":
		case "":
			return "low";
		default:
			throw new Error(
				`invalid --thinking value "${raw}"; expected one of: off | minimal | low | medium | high | xhigh | max`,
			);
	}
}

/** Run a single prompt through the new harness wiring (`--print`). */
export async function runPrintCommand(prompt: string, flags: HarnessCliFlags): Promise<number> {
	const runtime = await setupHarnessRuntime(flags);
	const jsonlMode = (flags.output ?? "text").toLowerCase() === "jsonl";
	try {
		return await runPrint({
			harness: runtime.harness,
			browserHandle: runtime.handle,
			modelRef: runtime.modelRef,
			provider: runtime.provider,
			prompt,
			skills: runtime.skills,
			verbose: flags.verbose,
			jsonlMode,
			jsonlIncludeDeltas: flags.jsonlIncludeDeltas,
			jsonlIncludeImages: flags.jsonlIncludeImages,
		});
	} finally {
		try {
			await runtime.handle.close();
		} catch (err) {
			stderr.write(`[cua] cleanup warning: ${(err as Error).message}\n`);
		}
	}
}

/** Run the interactive TUI through the new harness wiring. */
export async function runInteractiveCommand(
	initialPrompt: string,
	flags: HarnessCliFlags,
): Promise<number> {
	const runtime = await setupHarnessRuntime(flags);
	const { runInteractive } = await import("./tui/main");
	try {
		return await runInteractive({
			cwd: process.cwd(),
			harness: runtime.harness,
			browserHandle: runtime.handle,
			session: runtime.session,
			skills: runtime.skills,
			contextFiles: runtime.contextFiles,
			modelRef: runtime.modelRef,
			provider: runtime.provider,
			applicationTools: runtime.applicationTools,
			interactionToolsForModel: defaultInteractionTools,
			initialPrompt: initialPrompt || undefined,
			imageProtocol: flags.imageProtocol,
			debugTui: flags.debugTui,
			resumed: runtime.resolved?.resumed === true,
			transcriptPath: runtime.resolved?.transcriptPath,
			namedSession: flags.namedSession,
		});
	} finally {
		try {
			await runtime.handle.close();
		} catch (err) {
			stderr.write(`[cua] cleanup warning: ${(err as Error).message}\n`);
		}
	}
}

/** Run a one-shot model-mediated action subcommand through the harness wiring. */
export async function runActionCommand(
	action: ModelActionType,
	rest: string[],
	flags: HarnessCliFlags,
): Promise<number> {
	const runtime = await setupHarnessRuntime(flags, { skipDiskSession: true });
	const req: ActionRequest = buildActionRequest(action, rest);
	if (flags.maxSteps !== undefined) req.maxTurns = flags.maxSteps;
	try {
		const res = await runAction(req, {
			harness: runtime.harness,
		});
		return emitCompact(res);
	} finally {
		try {
			await runtime.handle.close();
		} catch (err) {
			stderr.write(`[cua] cleanup warning: ${(err as Error).message}\n`);
		}
	}
}

function buildActionRequest(action: ModelActionType, rest: string[]): ActionRequest {
	switch (action) {
		case "click":
			return { action, target: rest.join(" ") };
		case "type":
			return { action, target: rest[0], text: rest[1] };
		case "observe":
			return { action, text: rest.join(" ") };
		case "do":
			return { action, text: rest.join(" ") };
	}
}

/** Named-session subcommand handlers wired to the new SDK-backed implementation. */
export async function runSessionSubcommand(args: string[], flags: HarnessCliFlags): Promise<number> {
	const sub = args[0];
	if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
		stdout.write(`${sessionHelp()}\n`);
		return 0;
	}
	const auth = resolveAuthOrFail();
	switch (sub) {
		case "start": {
			const name = (args[1] ?? "").trim() || generateSessionSlug();
			validateSlug(name);
			const { meta, metadataPath, browser } = await startNamedSession({
				name,
				apiKey: auth.kernelApiKey,
				baseUrl: auth.kernelBaseUrl,
				browserTimeoutSeconds: flags.browserTimeout,
				profileSelector: flags.browserProfile,
				saveProfileChanges: flags.profileSaveChanges,
				proxySelector: flags.browserProxy,
				model: flags.model ? resolveCuaModelRef(flags.model) : undefined,
			});
			stdout.write(`name=${meta.name}\n`);
			stdout.write(`kernel_session_id=${browser.session_id}\n`);
			if (browser.browser_live_view_url) stdout.write(`live_url=${browser.browser_live_view_url}\n`);
			stdout.write(`metadata=${metadataPath}\n`);
			stdout.write(`\nUse: cua -s ${meta.name} <subcommand>...\n`);
			return 0;
		}
		case "stop": {
			const name = (args[1] ?? "").trim();
			if (!name) {
				stderr.write("usage: cua session stop <name>\n");
				return 2;
			}
			validateSlug(name);
			const result = await stopNamedSession({
				name,
				apiKey: auth.kernelApiKey,
				baseUrl: auth.kernelBaseUrl,
			});
			if (!result.existed) {
				stderr.write(`no named session "${name}"\n`);
				return 1;
			}
			stdout.write(
				result.kernelDeleted
					? `stopped ${name} (kernel browser deleted)\n`
					: `stopped ${name} (kernel browser was already gone)\n`,
			);
			return 0;
		}
		case "list": {
			const sessions = await listNamedSessions();
			if (sessions.length === 0) {
				stdout.write("(no named sessions; run `cua session start [name]`)\n");
				return 0;
			}
			const header = ["NAME", "KERNEL_ID", "AGE", "LIVE_URL"].join("\t");
			stdout.write(`${header}\n`);
			for (const s of sessions) {
				stdout.write(
					[
						s.name,
						shortKernelId(s.kernel_session_id),
						formatRelativeAge(s.created_at),
						s.live_url ?? "-",
					].join("\t") + "\n",
				);
			}
			return 0;
		}
		case "show": {
			const name = (args[1] ?? "").trim();
			if (!name) {
				stderr.write("usage: cua session show <name>\n");
				return 2;
			}
			validateSlug(name);
			const sessions = await listNamedSessions();
			const meta = sessions.find((s) => s.name === name);
			if (!meta) {
				stderr.write(`no named session "${name}"\n`);
				return 1;
			}
			stdout.write(`${JSON.stringify(meta, null, 2)}\n`);
			return 0;
		}
		default:
			stderr.write(`unknown session subcommand: ${sub}\n${sessionHelp()}\n`);
			return 2;
	}
}

function resolveAuthOrFail(): { kernelApiKey: string; kernelBaseUrl?: string } {
	const { apiKey, baseUrl } = requireKernelApiKey();
	return { kernelApiKey: apiKey, kernelBaseUrl: baseUrl };
}

function generateSessionSlug(): string {
	const adjectives = ["calm", "brisk", "swift", "quiet", "bright", "sharp"];
	const nouns = ["fox", "owl", "lynx", "hawk", "wolf", "moth"];
	const adj = adjectives[Math.floor(Math.random() * adjectives.length)] ?? "calm";
	const noun = nouns[Math.floor(Math.random() * nouns.length)] ?? "fox";
	const stamp = Date.now().toString(36).slice(-4);
	return `${adj}-${noun}-${stamp}`;
}

function sessionHelp(): string {
	return [
		"cua session start [name]   Start a new named browser session.",
		"cua session stop  <name>   Tear down a named session.",
		"cua session list           List existing named sessions.",
		"cua session show  <name>   Print full metadata for a named session.",
		"",
		"Use `-s <name>` on any other command to reuse the named session's",
		"browser (e.g. `cua -s login open https://...`).",
	].join("\n");
}
