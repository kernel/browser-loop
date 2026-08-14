import {
	AgentHarness,
	attach,
	type CuaAttachOptions,
	type CuaBrowserHandle,
	type CuaHarnessTool,
	type CuaModelInput,
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
	cuaNativeSurfaces,
	type CuaModelRef,
	getCuaModel,
	type Model,
	type Models,
	parseCuaModelRef,
} from "@onkernel/cua-ai";
import type Kernel from "@onkernel/sdk";
import {
	type AgentHarnessTool,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ExecutionToolContext,
	type PromptTemplate,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ContextFile } from "./harness-skills";

/** One tool in the CLI harness's caller-owned list. */
export type CuaCliTool = CuaHarnessTool<ExecutionToolContext>;

/**
 * The CLI's harness: stock pi, with no CUA class wrapping it. Its tool type is
 * pi's own — {@link CuaCliTool} is the caller-owned input the catalog compiles
 * from, and a CUA spec is not executable until the handle materializes it.
 */
export type CuaCliHarness = AgentHarness<ExecutionToolContext, Skill, PromptTemplate, AgentHarnessTool<ExecutionToolContext>>;

/**
 * The live (model, tools) selection, and the compile-then-swap that changes it.
 *
 * `attach()` hands back an immutable compiled pair, so the current selection
 * lives with whoever can change it — here, `/model` and `/tools`. Both steps
 * fail safe: `compile()` throws before anything mutates, and `apply()` restores
 * the previous pair if pi rejects the new one, so a rejected selection leaves
 * the session exactly as it was.
 */
export class CuaCliCatalog {
	private selection: CuaModelInput;
	private requested: readonly CuaCliTool[];

	constructor(
		private readonly handle: CuaBrowserHandle,
		private readonly harness: CuaCliHarness,
		selection: CuaModelInput,
		requested: readonly CuaCliTool[],
	) {
		this.selection = selection;
		this.requested = [...requested];
	}

	/** The caller-owned tool list, as selected — CUA specs, not materialized pi tools. */
	getTools(): readonly CuaCliTool[] {
		return [...this.requested];
	}

	setTools(tools: readonly CuaCliTool[]): Promise<void> {
		return this.swap(this.selection, tools);
	}

	setModel(model: CuaModelInput): Promise<void> {
		return this.swap(model, this.requested);
	}

	/**
	 * Select a model and its tool list in one compile. Staging the two in
	 * sequence would compile an intermediate catalog whose derived transport
	 * differs from both the old and the new one.
	 */
	setModelAndTools(model: CuaModelInput, tools: readonly CuaCliTool[]): Promise<void> {
		return this.swap(model, tools);
	}

	private async swap(model: CuaModelInput, tools: readonly CuaCliTool[]): Promise<void> {
		const compiled = this.handle.compile<ExecutionToolContext>({ model, tools });
		await compiled.apply(this.harness);
		this.selection = model;
		this.requested = [...tools];
	}
}

/** A CLI session: stock pi driving the agent, a CUA handle owning the browser. */
export interface CuaCliSession {
	readonly harness: CuaCliHarness;
	readonly catalog: CuaCliCatalog;
}

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
	toolResultImageReplayLimit?: CuaAttachOptions["toolResultImageReplayLimit"];
	responseThreading?: CuaAttachOptions["responseThreading"];
	retry?: CuaAttachOptions["retry"];
	modelBaseUrl?: string;
}

/** Build the CLI session with one explicit tool list and a caller-owned prompt. */
export function buildCuaHarness(opts: BuildCuaHarnessOptions): CuaCliSession {
	const skills = opts.skills ?? [];
	const contextFiles = opts.contextFiles ?? [];
	const model: CuaModelRef | Model<Api> = opts.modelBaseUrl
		? { ...getCuaModel(opts.model), baseUrl: opts.modelBaseUrl }
		: opts.model;
	const tools = opts.tools ?? [
		...defaultInteractionTools(opts.model),
		...defaultApplicationTools(),
	];
	const handle = attach({
		browser: opts.browser,
		client: opts.client,
		models: opts.models,
		toolResultImageReplayLimit: opts.toolResultImageReplayLimit,
		responseThreading: opts.responseThreading,
		retry: opts.retry,
	});
	const compiled = handle.compile<ExecutionToolContext>({ model, tools });
	const harness: CuaCliHarness = new AgentHarness({
		session: opts.session,
		model: compiled.model,
		models: compiled.models,
		tools: [...compiled.tools],
		activeToolNames: compiled.tools.map((tool) => tool.name),
		toolContext: { env: new NodeExecutionEnv({ cwd: opts.cwd }) },
		resources: { skills },
		thinkingLevel: opts.thinkingLevel,
		systemPrompt: ({ resources }) => composeSystemPrompt(resources.skills ?? [], contextFiles),
	});
	compiled.activate(harness);
	return { harness, catalog: new CuaCliCatalog(handle, harness, model, tools) };
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

/**
 * CLI interaction policy, asked of the model rather than switched on its
 * provider: a model with a provider-native browser surface gets that surface,
 * and everything else gets CUA's CDP browser tools, with `browser_act` included
 * only where the model accepts its schema.
 *
 * OpenAI's native computer tool is deliberately not a default: it is a distinct
 * interaction style callers opt into through `--tools` or the `/tools` picker.
 */
export function defaultInteractionTools(model: CuaModelRef): CuaCliTool[] {
	const { provider } = parseCuaModelRef(model);
	const resolved = getCuaModel(model);
	if (cuaNativeSurfaces(resolved).includes("browser")) {
		if (provider === "anthropic") {
			return [cua.providers.anthropic.tools.browser({ version: "20260701", javascript: true })];
		}
		if (provider === "google") return cua.providers.google.toolsets.browser();
	}
	return cuaModelCapabilities(resolved).acceptsLargeSchemas
		? structuredBrowserTools()
		: cua.toolsets.browser();
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
