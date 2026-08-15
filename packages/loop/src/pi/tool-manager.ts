import type { AgentHarnessTool, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { loopModelPreparationTransforms } from "./catalog";
import { getLoopModel, loopModelFacts, type LoopModelRef } from "./models";
import {
	callerToolIdentity,
	compileLoopToolCatalog,
	isLoopToolSpec,
	type LoopCatalogToolInput,
	type LoopToolCatalog,
	type LoopToolSpec,
} from "../core/tool-catalog";
import { LoopExecutionResources, type LoopExecutableTool } from "../core/resources";

/**
 * Caller-owned tool: a declarative Loop spec materialized by this package, or an
 * already executable pi `AgentTool`. Defined here because the tool manager is the
 * only place that holds both halves; the catalog compiler stays declaration-only.
 */
export type LoopAgentTool = LoopToolSpec | AgentTool;

/**
 * Caller-owned tool for a harness: a declarative Loop spec, or an executable pi
 * `AgentHarnessTool` that receives the harness's tool context on every call. A
 * plain `AgentTool` is assignable, since it simply ignores the context.
 */
export type LoopHarnessTool<TContext extends object | undefined = never> = LoopToolSpec | AgentHarnessTool<TContext>;

/**
 * One compiled (model, tools) pair: the caller's list joined back to its
 * declarative catalog by compiled identity, with each spec materialized against
 * the shared browser resources.
 *
 * Immutable by construction. Changing the model or the tool list compiles a new
 * one, which is what lets a caller hand pi a fresh pair instead of mutating a
 * live catalog underneath it.
 */
export class LoopToolManager<TRequested extends LoopHarnessTool<any> = LoopAgentTool> {
	readonly catalog: LoopToolCatalog<Model<Api>>;
	private readonly executables: readonly (AgentTool | AgentHarnessTool<any>)[];
	private readonly specs: ReadonlyMap<string, LoopToolSpec>;

	constructor(
		readonly resources: LoopExecutionResources,
		model: LoopModelRef | Model<Api>,
		requestedTools: readonly TRequested[],
		resolveModel: (model: LoopModelRef) => Model<Api> = getLoopModel,
	) {
		const inputs: LoopCatalogToolInput[] = [];
		const executables = new Map<string, TRequested>();
		const specs = new Map<string, LoopToolSpec>();
		for (const tool of requestedTools) {
			if (isLoopToolSpec(tool)) {
				inputs.push(tool);
				executables.set(tool.identity, tool);
				specs.set(tool.identity, tool);
			} else {
				// Fresh declaration-only projection: execute, label, prepareArguments,
				// and executionMode never cross into the catalog compiler.
				inputs.push({ name: tool.name, description: tool.description, parameters: tool.parameters });
				executables.set(callerToolIdentity(tool.name), tool);
			}
		}
		const resolved = typeof model === "string" ? resolveModel(model) : model;
		this.catalog = compileLoopToolCatalog({
			model: resolved,
			requestedTools: inputs,
			facts: loopModelFacts(resolved),
			preparation: loopModelPreparationTransforms(resolved),
		});

		// Joined strictly by compiled identity, never by position.
		this.executables = this.catalog.entries.map((entry) => {
			const executable = executables.get(entry.identity);
			if (!executable) throw new Error(`compiled catalog entry "${entry.identity}" has no matching requested tool`);
			executables.delete(entry.identity);
			return isLoopToolSpec(executable) ? asAgentTool(resources.materialize(executable)) : (executable as AgentHarnessTool<any>);
		});
		if (executables.size > 0) {
			throw new Error(`requested tool(s) ${[...executables.keys()].join(", ")} missing from the compiled catalog`);
		}
		this.specs = specs;
	}

	/** Pi `AgentTool` view, in catalog entry order. */
	agentTools(): AgentTool[] {
		return [...(this.executables as readonly AgentTool[])];
	}

	/** Context-delivering pi `AgentHarnessTool` view, in catalog entry order. */
	harnessTools(): AgentHarnessTool<any>[] {
		return [...(this.executables as readonly AgentHarnessTool<any>[])];
	}

	/** Execution metadata for one catalog identity. */
	specFor(identity: string): LoopToolSpec | undefined {
		return this.specs.get(identity);
	}
}

/**
 * Cached per executable, and executables are cached per (pool, spec), so pi
 * sees one stable `AgentTool` identity across every recompile of a pair.
 */
const agentToolAdapters = new WeakMap<LoopExecutableTool, AgentTool>();

/** Adapt a neutral Loop executable to pi's `AgentTool` calling convention. */
function asAgentTool(executable: LoopExecutableTool): AgentTool {
	const cached = agentToolAdapters.get(executable);
	if (cached) return cached;
	const { declaration } = executable.spec;
	const tool: AgentTool = {
		name: executable.spec.name,
		label: executable.spec.name,
		description: declaration.description,
		parameters: declaration.parameters,
		executionMode: "sequential",
		execute: (_toolCallId, input, signal) => executable.execute(input, signal),
	};
	agentToolAdapters.set(executable, tool);
	return tool;
}
