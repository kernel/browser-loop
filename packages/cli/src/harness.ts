import {
	CuaAgentHarness,
	type CuaAgentHarnessOptions,
	type CuaAgentTool,
	formatSkillsForSystemPrompt,
	type KernelBrowser,
	NodeExecutionEnv,
	type Session,
	type Skill,
	type ThinkingLevel,
} from "@onkernel/cua-agent";
import {
	type Api,
	cua,
	type CuaModelRef,
	getCuaModel,
	type Model,
	type Models,
	parseCuaModelRef,
} from "@onkernel/cua-ai";
import type Kernel from "@onkernel/sdk";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import type { ContextFile } from "./harness-skills";

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
	tools?: CuaAgentTool[];
	models?: Models;
	toolResultImageReplayLimit?: CuaAgentHarnessOptions["toolResultImageReplayLimit"];
	responseThreading?: CuaAgentHarnessOptions["responseThreading"];
	retry?: CuaAgentHarnessOptions["retry"];
	modelBaseUrl?: string;
}

/** Build the CLI harness with one explicit tool list and a caller-owned prompt. */
export function buildCuaHarness(opts: BuildCuaHarnessOptions): CuaAgentHarness {
	const skills = opts.skills ?? [];
	const contextFiles = opts.contextFiles ?? [];
	const model: CuaModelRef | Model<Api> = opts.modelBaseUrl
		? { ...getCuaModel(opts.model), baseUrl: opts.modelBaseUrl }
		: opts.model;
	const tools = opts.tools ?? [
		...defaultInteractionTools(opts.model),
		...defaultApplicationTools(opts.cwd),
	];
	return new CuaAgentHarness({
		env: new NodeExecutionEnv({ cwd: opts.cwd }),
		session: opts.session,
		model,
		browser: opts.browser,
		client: opts.client,
		tools,
		resources: { skills },
		thinkingLevel: opts.thinkingLevel,
		systemPrompt: ({ resources }) => composeSystemPrompt(resources.skills ?? [], contextFiles),
		models: opts.models,
		toolResultImageReplayLimit: opts.toolResultImageReplayLimit,
		responseThreading: opts.responseThreading,
		retry: opts.retry,
	});
}

/** Coding tools owned by the CLI application rather than inferred from a compiled catalog. */
export function defaultApplicationTools(cwd: string): CuaAgentTool[] {
	return createCodingTools(cwd);
}

/**
 * CLI structured-browser policy. `browser_act` remains outside the reusable
 * base toolset, so the application opts into semantic verified plans explicitly.
 */
function structuredBrowserTools(): CuaAgentTool[] {
	return [...cua.toolsets.browser(), cua.tools.browser.act()];
}

/** CLI policy is explicit application composition, not a CuaAgent default. */
export function defaultInteractionTools(model: CuaModelRef): CuaAgentTool[] {
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
		case "tzafon":
			return [cua.providers.tzafon.tools.computer()];
		case "yutori":
			return [
				...(modelId.startsWith("n1.5")
					? cua.providers.yutori.toolsets.n15Core()
					: cua.providers.yutori.toolsets.n1()),
				cua.tools.computer.screenshot(),
			];
		case "meta":
		case "xai":
			return structuredBrowserTools();
		case "moonshotai":
			// Moonshot's API rejects the request outright once `browser_act`'s
			// schema is attached, so Kimi keeps the browser primitives only.
			return cua.toolsets.browser();
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
