import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	callerToolIdentity,
	compileCuaToolCatalog,
	getCuaModel,
	isCuaToolSpec,
	modelSupportsDeferredTools,
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
 * One atomically committable tools state. `requested` is the sole caller-owned
 * source of truth; `catalog` is its pure declarative projection; `tools` are
 * the wrapped executables joined back by identity after compilation.
 */
export interface PreparedCuaTools {
	readonly requested: readonly CuaAgentTool[];
	readonly catalog: CuaToolCatalog;
	readonly tools: readonly AgentTool[];
	/** Identity → CUA spec, for execution metadata (e.g. stop-on-failure policy). */
	readonly specs: ReadonlyMap<string, CuaToolSpec>;
	/** Declaration fingerprint composed with implementation identity, in entry order. */
	readonly fingerprints: readonly string[];
}

interface ToolExecutionScope {
	readonly toolName: string;
	readonly executionMode: AgentTool["executionMode"];
	readonly baseline: PreparedCuaTools;
}

/**
 * Implementation identity, owned by cua-agent: keyed on a caller tool's
 * `execute` function (a new wrapper reusing the same function retains
 * identity) and on the spec object itself (a freshly created spec is
 * conservatively a replacement, the same object stays stable).
 */
const implementationIds = new WeakMap<object, number>();
let nextImplementationId = 1;

function implementationId(key: object): number {
	let id = implementationIds.get(key);
	if (id === undefined) {
		id = nextImplementationId++;
		implementationIds.set(key, id);
	}
	return id;
}

/** Owns the caller's requested list and its compiled catalog while browser resources live independently. */
export class CuaToolManager {
	private readonly execution = new AsyncLocalStorage<ToolExecutionScope>();
	private current: PreparedCuaTools;

	constructor(
		readonly resources: CuaExecutionResources,
		model: CuaModelRef | Model<Api>,
		requestedTools: readonly CuaAgentTool[],
		private readonly resolveModel: (model: CuaModelRef) => Model<Api> = getCuaModel,
	) {
		this.current = this.prepare(model, requestedTools);
	}

	get catalog(): CuaToolCatalog {
		return this.current.catalog;
	}

	getTools(): readonly CuaAgentTool[] {
		return [...this.current.requested];
	}

	/** Wrapped executable tools for a prepared (or the committed) state, in entry order. */
	agentTools(prepared: PreparedCuaTools = this.current): AgentTool[] {
		return [...prepared.tools];
	}

	/** Execution metadata for one committed catalog identity. */
	specFor(identity: string): CuaToolSpec | undefined {
		return this.current.specs.get(identity);
	}

	prepareTools(tools: readonly CuaAgentTool[]): PreparedCuaTools {
		this.assertMutationScope("setTools");
		return this.prepare(this.current.catalog.model, tools);
	}

	prepareModel(model: CuaModelRef | Model<Api>): PreparedCuaTools {
		this.assertMutationScope("setModel");
		return this.prepare(model, this.current.requested);
	}

	commit(prepared: PreparedCuaTools): void {
		this.current = prepared;
	}

	/**
	 * Compile and materialize without touching committed state. Ordinary
	 * AgentTools are projected into fresh declaration-only objects before
	 * compilation, then joined back strictly by compiled identity — never by
	 * position. Any failure leaves the committed state untouched.
	 */
	private prepare(model: CuaModelRef | Model<Api>, tools: readonly CuaAgentTool[]): PreparedCuaTools {
		const requested = Object.freeze([...tools]);
		const inputs: CuaCatalogToolInput[] = [];
		const executables = new Map<string, CuaAgentTool>();
		const implementations = new Map<string, object>();
		const specs = new Map<string, CuaToolSpec>();
		for (const tool of requested) {
			if (isCuaToolSpec(tool)) {
				inputs.push(tool);
				executables.set(tool.identity, tool);
				implementations.set(tool.identity, tool);
				specs.set(tool.identity, tool);
			} else {
				const identity = callerToolIdentity(tool.name);
				// Fresh declaration-only projection: execute, label, prepareArguments,
				// and executionMode never cross into cua-ai.
				inputs.push({ name: tool.name, description: tool.description, parameters: tool.parameters });
				executables.set(identity, tool);
				implementations.set(identity, tool.execute);
			}
		}
		const catalog = compileCuaToolCatalog({
			model: typeof model === "string" ? this.resolveModel(model) : model,
			requestedTools: inputs,
			viewport: this.resources.viewport,
		});

		const fingerprints: string[] = [];
		const wrapped = catalog.entries.map((entry) => {
			const executable = executables.get(entry.identity);
			const implementation = implementations.get(entry.identity);
			if (!executable || !implementation) {
				throw new Error(`compiled catalog entry "${entry.identity}" has no matching requested tool`);
			}
			executables.delete(entry.identity);
			fingerprints.push(`${entry.fingerprint}#impl-${implementationId(implementation)}`);
			const agentTool = isCuaToolSpec(executable) ? this.resources.materialize(executable) : executable;
			return this.wrapExecutable(agentTool);
		});
		if (executables.size > 0) {
			throw new Error(`requested tool(s) ${[...executables.keys()].join(", ")} missing from the compiled catalog`);
		}

		return Object.freeze({
			requested,
			catalog,
			tools: Object.freeze(wrapped),
			specs,
			fingerprints: Object.freeze(fingerprints),
		});
	}

	private wrapExecutable(tool: AgentTool): AgentTool {
		return {
			...tool,
			execute: async (toolCallId, input, signal, onUpdate) => {
				const scope: ToolExecutionScope = {
					toolName: tool.name,
					executionMode: tool.executionMode,
					baseline: this.current,
				};
				return this.execution.run(scope, async () => {
					const result = await tool.execute(toolCallId, input, signal, onUpdate);
					return mergeAddedToolNames(result, cachePreservingAdditions(scope.baseline, this.current) ?? []);
				});
			},
		};
	}

	private assertMutationScope(api: "setTools" | "setModel"): void {
		const scope = this.execution.getStore();
		if (scope && scope.executionMode !== "sequential") {
			throw new Error(`tool "${scope.toolName}" must declare executionMode: "sequential" before calling ${api}() during execution`);
		}
	}
}

function cachePreservingAdditions(previous: PreparedCuaTools, next: PreparedCuaTools): string[] | undefined {
	const previousModel = previous.catalog.model;
	const nextModel = next.catalog.model;
	if (previousModel.provider !== nextModel.provider || previousModel.id !== nextModel.id || previousModel.api !== nextModel.api) return undefined;
	if (next.fingerprints.length <= previous.fingerprints.length) return undefined;
	for (let index = 0; index < previous.fingerprints.length; index += 1) {
		if (previous.fingerprints[index] !== next.fingerprints[index]) return undefined;
	}
	const added = next.catalog.entries.slice(previous.fingerprints.length);
	if (!modelSupportsDeferredTools(nextModel) || added.some((entry) => entry.dynamicLoading !== "eligible")) return undefined;
	return added.map((entry) => entry.name);
}

function mergeAddedToolNames<T>(result: AgentToolResult<T>, names: readonly string[]): AgentToolResult<T> {
	if (names.length === 0) return result;
	return {
		...result,
		addedToolNames: [...new Set([...(result.addedToolNames ?? []), ...names])],
	};
}
