import {
	CuaAgentHarness,
	type CuaAgentHarnessOptions,
	formatSkillsForSystemPrompt,
	type KernelBrowser,
	NodeExecutionEnv,
	type Session,
	type Skill,
	type ThinkingLevel,
} from "@onkernel/cua-agent";
import {
	type Api,
	type CuaMode,
	type CuaModelRef,
	type CuaNativeToolSpec,
	type Model,
	type Models,
	getCuaModel,
	resolveCuaRuntimeSpec,
} from "@onkernel/cua-ai";
import type Kernel from "@onkernel/sdk";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import type { ContextFile } from "./harness-skills";

/** Options for {@link buildCuaHarness}. */
export interface BuildCuaHarnessOptions {
	cwd: string;
	client: Kernel;
	browser: KernelBrowser;
	session: Session;
	model: CuaModelRef;
	skills?: Skill[];
	/** Context files (AGENTS.md, CLAUDE.md, …) appended to the system prompt. */
	contextFiles?: ContextFile[];
	thinkingLevel?: ThinkingLevel;
	/** Which canonical action plane(s) to expose: "computer" (default), "browser", or "hybrid". */
	mode?: CuaMode;
	/** Drive the model through a provider-native tool declaration (validated against `mode`). */
	nativeTool?: CuaNativeToolSpec;
	/** Expose the playwright_execute tool that runs Playwright code against the browser session. */
	playwright?: boolean;
	/** Override the default coding-tools extraTools (bash/read/edit/write/grep/find/ls). */
	extraTools?: CuaAgentHarnessOptions["extraTools"];
	/** Override the pi `Models` collection requests stream through (mainly for tests). */
	models?: Models;
	/** Maximum tool-result images included from message history per provider request. */
	toolResultImageReplayLimit?: CuaAgentHarnessOptions["toolResultImageReplayLimit"];
	/** Chain OpenAI and Tzafon requests through provider-stored response state. Defaults to true. */
	responseThreading?: CuaAgentHarnessOptions["responseThreading"];
	/** Optional CUA-level retries around each provider request. Disabled by default. */
	retry?: CuaAgentHarnessOptions["retry"];
	/** Override the catalog `baseUrl` on the resolved model (e.g. from `<PROVIDER>_BASE_URL`). */
	modelBaseUrl?: string;
}

/**
 * Build a `CuaAgentHarness` wired with cua-cli's defaults: pi `NodeExecutionEnv`,
 * caller-supplied jsonl `Session`, pi-coding-agent's `createCodingTools` as
 * `extraTools`, the shared CUA `Models` collection (env-var API-key
 * resolution via cua-ai conventions), and a `systemPrompt` that composes the
 * runtime spec's default prompt with the formatted skill block.
 */
export function buildCuaHarness(opts: BuildCuaHarnessOptions): CuaAgentHarness {
	const skills = opts.skills ?? [];
	const contextFiles = opts.contextFiles ?? [];
	const extraTools = opts.extraTools ?? createCodingTools(opts.cwd);
	const model: CuaModelRef | Model<Api> = opts.modelBaseUrl
		? { ...getCuaModel(opts.model), baseUrl: opts.modelBaseUrl }
		: opts.model;
	// The system-prompt callback re-resolves per turn and must see the live
	// mode after /mode switches, so it reads it from the harness (late-bound).
	let harness: CuaAgentHarness | undefined;
	harness = new CuaAgentHarness({
		env: new NodeExecutionEnv({ cwd: opts.cwd }),
		session: opts.session,
		model,
		browser: opts.browser,
		client: opts.client,
		extraTools,
		mode: opts.mode,
		nativeTool: opts.nativeTool,
		playwright: opts.playwright,
		resources: { skills },
		thinkingLevel: opts.thinkingLevel,
		systemPrompt: ({ model: activeModel, resources }) => {
			const runtime = resolveCuaRuntimeSpec(activeModel, {
				mode: harness?.getMode() ?? opts.mode,
				nativeTool: opts.nativeTool,
			});
			return composeSystemPrompt(runtime.defaultSystemPrompt, resources.skills ?? [], contextFiles);
		},
		models: opts.models,
		toolResultImageReplayLimit: opts.toolResultImageReplayLimit,
		responseThreading: opts.responseThreading,
		retry: opts.retry,
	});
	return harness;
}

function composeSystemPrompt(base: string, skills: Skill[], contextFiles: ContextFile[]): string {
	const sections = [base.trim()];
	const skillBlock = formatSkillsForSystemPrompt(skills).trim();
	if (skillBlock) sections.push(skillBlock);
	const contextBlock = formatContextFiles(contextFiles);
	if (contextBlock) sections.push(contextBlock);
	return `${sections.join("\n\n")}\n`;
}

function formatContextFiles(contextFiles: ContextFile[]): string {
	const blocks = contextFiles
		.filter((file) => file.content.trim().length > 0)
		.map((file) => `## ${file.path}\n\n${file.content.trim()}`);
	if (blocks.length === 0) return "";
	return `# Context\n\n${blocks.join("\n\n")}`;
}
