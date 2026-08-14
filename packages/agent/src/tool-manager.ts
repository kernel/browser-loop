import type { AgentHarnessTool, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	callerToolIdentity,
	compileCuaToolCatalog,
	getCuaModel,
	isCuaToolSpec,
	type CuaCatalogToolInput,
	type CuaModelRef,
	type CuaToolCatalog,
	type CuaToolSpec,
} from "@onkernel/cua-ai";
import { CuaExecutionResources } from "./resources";

/**
 * Caller-owned tool: a declarative CUA spec materialized by this package, or an
 * already executable pi `AgentTool`. Defined here because cua-agent is the only
 * package that holds both halves; cua-ai compiles declaration-only catalogs.
 */
export type CuaAgentTool = CuaToolSpec | AgentTool;

/**
 * Caller-owned tool for a harness: a declarative CUA spec, or an executable pi
 * `AgentHarnessTool` that receives the harness's tool context on every call. A
 * plain `AgentTool` is assignable, since it simply ignores the context.
 */
export type CuaHarnessTool<TContext extends object | undefined = never> = CuaToolSpec | AgentHarnessTool<TContext>;

/**
 * One compiled (model, tools) pair: the caller's list joined back to its
 * declarative catalog by compiled identity, with each spec materialized against
 * the shared browser resources.
 *
 * Immutable by construction. Changing the model or the tool list compiles a new
 * one, which is what lets a caller hand pi a fresh pair instead of mutating a
 * live catalog underneath it.
 */
export class CuaToolManager<TRequested extends CuaHarnessTool<any> = CuaAgentTool> {
	readonly catalog: CuaToolCatalog;
	private readonly executables: readonly (AgentTool | AgentHarnessTool<any>)[];
	private readonly specs: ReadonlyMap<string, CuaToolSpec>;

	constructor(
		readonly resources: CuaExecutionResources,
		model: CuaModelRef | Model<Api>,
		requestedTools: readonly TRequested[],
		resolveModel: (model: CuaModelRef) => Model<Api> = getCuaModel,
	) {
		const inputs: CuaCatalogToolInput[] = [];
		const executables = new Map<string, TRequested>();
		const specs = new Map<string, CuaToolSpec>();
		for (const tool of requestedTools) {
			if (isCuaToolSpec(tool)) {
				inputs.push(tool);
				executables.set(tool.identity, tool);
				specs.set(tool.identity, tool);
			} else {
				// Fresh declaration-only projection: execute, label, prepareArguments,
				// and executionMode never cross into cua-ai.
				inputs.push({ name: tool.name, description: tool.description, parameters: tool.parameters });
				executables.set(callerToolIdentity(tool.name), tool);
			}
		}
		this.catalog = compileCuaToolCatalog({
			model: typeof model === "string" ? resolveModel(model) : model,
			requestedTools: inputs,
		});

		// Joined strictly by compiled identity, never by position.
		this.executables = this.catalog.entries.map((entry) => {
			const executable = executables.get(entry.identity);
			if (!executable) throw new Error(`compiled catalog entry "${entry.identity}" has no matching requested tool`);
			executables.delete(entry.identity);
			return isCuaToolSpec(executable) ? resources.materialize(executable) : (executable as AgentHarnessTool<any>);
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
	specFor(identity: string): CuaToolSpec | undefined {
		return this.specs.get(identity);
	}
}
