import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentHarnessTool, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
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
 * Caller-owned tool for {@link CuaAgent}: a declarative CUA spec materialized
 * by this package, or an already executable pi `AgentTool`. Defined here
 * because cua-agent is the only package that holds both halves; cua-ai
 * compiles declaration-only catalogs.
 */
export type CuaAgentTool = CuaToolSpec | AgentTool;

/**
 * Caller-owned tool for {@link CuaAgentHarness}: a declarative CUA spec
 * materialized by this package, or an executable pi `AgentHarnessTool` that
 * receives the harness's tool context on every call. A plain `AgentTool` is
 * assignable (it simply ignores the context), but the two APIs are kept
 * distinct: `CuaAgent` takes `CuaAgentTool`, `CuaAgentHarness` takes this.
 */
export type CuaHarnessTool<TContext extends object | undefined = never> = CuaToolSpec | AgentHarnessTool<TContext>;

/**
 * One atomically committable tools state. `requested` is the sole caller-owned
 * source of truth; `catalog` is its pure declarative projection; `tools` and
 * `harnessTools` are the wrapped executables joined back by identity after
 * compilation, viewed as pi `AgentTool`s (for `CuaAgent`) or as
 * context-delivering `AgentHarnessTool`s (for `CuaAgentHarness`).
 */
export interface PreparedCuaTools<TRequested extends CuaHarnessTool<any> = CuaAgentTool> {
	readonly requested: readonly TRequested[];
	readonly catalog: CuaToolCatalog;
	readonly tools: readonly AgentTool[];
	readonly harnessTools: readonly AgentHarnessTool<any>[];
	/** Identity → CUA spec, for execution metadata (e.g. stop-on-failure policy). */
	readonly specs: ReadonlyMap<string, CuaToolSpec>;
	/** Declaration fingerprint composed with implementation identity, in entry order. */
	readonly fingerprints: readonly string[];
}

interface ToolExecutionScope {
	readonly toolName: string;
	readonly executionMode: AgentTool["executionMode"];
	readonly baseline: PreparedCuaTools<any>;
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
export class CuaToolManager<TRequested extends CuaHarnessTool<any> = CuaAgentTool> {
	private readonly execution = new AsyncLocalStorage<ToolExecutionScope>();
	private current: PreparedCuaTools<TRequested>;

	constructor(
		readonly resources: CuaExecutionResources,
		model: CuaModelRef | Model<Api>,
		requestedTools: readonly TRequested[],
		private readonly resolveModel: (model: CuaModelRef) => Model<Api> = getCuaModel,
	) {
		this.current = this.prepare(model, requestedTools);
	}

	get catalog(): CuaToolCatalog {
		return this.current.catalog;
	}

	getTools(): TRequested[] {
		return [...this.current.requested];
	}

	/** Wrapped pi `AgentTool` view of a prepared (or the committed) state, in entry order. */
	agentTools(prepared: PreparedCuaTools<TRequested> = this.current): AgentTool[] {
		return [...prepared.tools];
	}

	/** Wrapped pi `AgentHarnessTool` view of a prepared (or the committed) state, in entry order. */
	harnessTools(prepared: PreparedCuaTools<TRequested> = this.current): AgentHarnessTool<any>[] {
		return [...prepared.harnessTools];
	}

	/** Execution metadata for one committed catalog identity. */
	specFor(identity: string): CuaToolSpec | undefined {
		return this.current.specs.get(identity);
	}

	prepareTools(tools: readonly TRequested[]): PreparedCuaTools<TRequested> {
		this.assertMutationScope("setTools");
		return this.prepare(this.current.catalog.model, tools);
	}

	prepareModel(model: CuaModelRef | Model<Api>): PreparedCuaTools<TRequested> {
		this.assertMutationScope("setModel");
		return this.prepare(model, this.current.requested);
	}

	commit(prepared: PreparedCuaTools<TRequested>): void {
		this.current = prepared;
	}

	/**
	 * Compile and materialize without touching committed state. Ordinary
	 * AgentTools are projected into fresh declaration-only objects before
	 * compilation, then joined back strictly by compiled identity — never by
	 * position. Any failure leaves the committed state untouched.
	 */
	private prepare(model: CuaModelRef | Model<Api>, tools: readonly TRequested[]): PreparedCuaTools<TRequested> {
		const requested = Object.freeze([...tools]);
		const inputs: CuaCatalogToolInput[] = [];
		const executables = new Map<string, TRequested>();
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
		const joined: Array<AgentTool | AgentHarnessTool<any>> = catalog.entries.map((entry) => {
			const executable = executables.get(entry.identity);
			const implementation = implementations.get(entry.identity);
			if (!executable || !implementation) {
				throw new Error(`compiled catalog entry "${entry.identity}" has no matching requested tool`);
			}
			executables.delete(entry.identity);
			fingerprints.push(`${entry.fingerprint}#impl-${implementationId(implementation)}`);
			return isCuaToolSpec(executable) ? this.resources.materialize(executable) : (executable as AgentHarnessTool<any>);
		});
		if (executables.size > 0) {
			throw new Error(`requested tool(s) ${[...executables.keys()].join(", ")} missing from the compiled catalog`);
		}

		return Object.freeze({
			requested,
			catalog,
			tools: Object.freeze(joined.map((tool) => this.wrapAgentExecutable(tool as AgentTool))),
			harnessTools: Object.freeze(joined.map((tool) => this.wrapHarnessExecutable(tool))),
			specs,
			fingerprints: Object.freeze(fingerprints),
		});
	}

	/** Low-level `AgentTool` view for {@link CuaAgent}; caller tools there never declare a harness context. */
	private wrapAgentExecutable(tool: AgentTool): AgentTool {
		return {
			...tool,
			execute: (toolCallId, input, signal, onUpdate) =>
				this.executeWithScope(tool, () => tool.execute(toolCallId, input, signal, onUpdate)),
		};
	}

	/** Context-delivering `AgentHarnessTool` view for {@link CuaAgentHarness}. */
	private wrapHarnessExecutable(tool: AgentHarnessTool<any>): AgentHarnessTool<any> {
		return {
			...tool,
			execute: (toolCallId, params, signal, onUpdate, context) =>
				this.executeWithScope(tool, () => tool.execute(toolCallId, params, signal, onUpdate, context)),
		};
	}

	private async executeWithScope<TDetails>(
		tool: { readonly name: string; readonly executionMode?: AgentTool["executionMode"] },
		call: () => Promise<AgentToolResult<TDetails>>,
	): Promise<AgentToolResult<TDetails>> {
		const scope: ToolExecutionScope = {
			toolName: tool.name,
			executionMode: tool.executionMode,
			baseline: this.current,
		};
		return this.execution.run(scope, async () => {
			const result = await call();
			return mergeAddedToolNames(result, cachePreservingAdditions(scope.baseline, this.current) ?? []);
		});
	}

	private assertMutationScope(api: "setTools" | "setModel"): void {
		const scope = this.execution.getStore();
		if (scope && scope.executionMode !== "sequential") {
			throw new Error(`tool "${scope.toolName}" must declare executionMode: "sequential" before calling ${api}() during execution`);
		}
	}
}

function cachePreservingAdditions(previous: PreparedCuaTools<any>, next: PreparedCuaTools<any>): string[] | undefined {
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
