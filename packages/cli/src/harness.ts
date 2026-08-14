import {
	CuaAgentHarness,
	type CuaAgentHarnessOptions,
	type CuaHarnessTool,
	formatSkillsForSystemPrompt,
	type KernelBrowser,
	type Session,
	type Skill,
	type ThinkingLevel,
} from "@onkernel/cua-agent";
import {
	type Api,
	cua,
	cuaModelCapabilities,
	type CuaModelRef,
	getCuaModel,
	type Model,
	type Models,
	parseCuaModelRef,
} from "@onkernel/cua-ai";
import type Kernel from "@onkernel/sdk";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ContextFile } from "./harness-skills";

/** CLI harness: a CUA harness whose tool context carries the coding tools' execution environment. */
export type CuaCliHarness = CuaAgentHarness<ExecutionToolContext>;
/** One tool in the CLI harness's caller-owned list. */
export type CuaCliTool = CuaHarnessTool<ExecutionToolContext>;

export interface BuildCuaHarnessOptions {
	cwd: string;
	client: Kernel;
	browser: KernelBrowser;
	session: Session;
	model: CuaModelRef;
	skills?: Skill[];
	contextFiles?: ContextFile[];
	thinkingLevel?: ThinkingLevel;
	/** Override the CLI's explicit interaction + coding tool list. */
	tools?: CuaCliTool[];
	models?: Models;
	toolResultImageReplayLimit?: CuaAgentHarnessOptions["toolResultImageReplayLimit"];
	responseThreading?: CuaAgentHarnessOptions["responseThreading"];
	retry?: CuaAgentHarnessOptions["retry"];
	modelBaseUrl?: string;
}

/** Build the CLI harness with one explicit tool list and a caller-owned prompt. */
export function buildCuaHarness(opts: BuildCuaHarnessOptions): CuaCliHarness {
	const skills = opts.skills ?? [];
	const contextFiles = opts.contextFiles ?? [];
	const model: CuaModelRef | Model<Api> = opts.modelBaseUrl
		? { ...getCuaModel(opts.model), baseUrl: opts.modelBaseUrl }
		: opts.model;
	const tools = opts.tools ?? [
		...defaultInteractionTools(opts.model),
		...defaultApplicationTools(),
	];
	return new CuaAgentHarness<ExecutionToolContext>({
		session: opts.session,
		model,
		models: opts.models,
		browser: opts.browser,
		client: opts.client,
		tools,
		toolContext: { env: new NodeExecutionEnv({ cwd: opts.cwd }) },
		resources: { skills },
		thinkingLevel: opts.thinkingLevel,
		systemPrompt: ({ resources }) => composeSystemPrompt(resources.skills ?? [], contextFiles),
		toolResultImageReplayLimit: opts.toolResultImageReplayLimit,
		responseThreading: opts.responseThreading,
		retry: opts.retry,
	});
}

/** Coding tools owned by the CLI application rather than inferred from a compiled catalog. */
export function defaultApplicationTools(): CuaCliTool[] {
	return [createReadTool(), createBashTool(), createEditTool(), createWriteTool()];
}

/**
 * CLI structured-browser policy. `browser_act` remains outside the reusable
 * base toolset, so the application opts into semantic verified plans explicitly.
 */
function structuredBrowserTools(): CuaCliTool[] {
	return [...cua.toolsets.browser(), cua.tools.browser.act()];
}

/** CLI policy is explicit application composition, not a CuaAgent default. */
export function defaultInteractionTools(model: CuaModelRef): CuaCliTool[] {
	const { provider, model: modelId } = parseCuaModelRef(model);
	switch (provider) {
		case "openai":
			return structuredBrowserTools();
		case "anthropic":
			return cua.providers.anthropic.supports.browser(modelId)
				? [cua.providers.anthropic.tools.browser({ version: "20260701", javascript: true })]
				: structuredBrowserTools();
		case "google":
			return cua.providers.google.toolsets.browser();
		case "xai":
			return structuredBrowserTools();
		case "moonshotai":
		case "openrouter":
			// Kimi's API rejects the request outright once `browser_act`'s schema
			// is attached. OpenRouter fronts several model families, so this is a
			// per-model capability question rather than a per-provider one.
			return cuaModelCapabilities(getCuaModel(model)).acceptsLargeSchemas
				? structuredBrowserTools()
				: cua.toolsets.browser();
	}
}

function composeSystemPrompt(skills: Skill[], contextFiles: ContextFile[]): string {
	const sections: string[] = [];
	const skillBlock = formatSkillsForSystemPrompt(skills).trim();
	if (skillBlock) sections.push(skillBlock);
	const contextBlock = formatContextFiles(contextFiles);
	if (contextBlock) sections.push(contextBlock);
	return sections.length ? `${sections.join("\n\n")}\n` : "";
}

function formatContextFiles(contextFiles: ContextFile[]): string {
	const blocks = contextFiles
		.filter((file) => file.content.trim().length > 0)
		.map((file) => `## ${file.path}\n\n${file.content.trim()}`);
	if (blocks.length === 0) return "";
	return `# Context\n\n${blocks.join("\n\n")}`;
}
