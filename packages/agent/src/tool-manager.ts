import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	compileCuaToolCatalog,
	modelSupportsDeferredTools,
	type CuaAgentTool,
	type CuaModelRef,
	type CuaToolCatalog,
	type CuaToolInfo,
} from "@onkernel/cua-ai";
import { CuaExecutionResources } from "./resources";

interface ToolExecutionScope {
	readonly toolName: string;
	readonly executionMode: AgentTool["executionMode"];
	readonly baseline: CuaToolCatalog;
}

/** Owns the single compiled catalog while browser resources live independently. */
export class CuaToolManager {
	private readonly execution = new AsyncLocalStorage<ToolExecutionScope>();
	private current: CuaToolCatalog;

	constructor(
		readonly resources: CuaExecutionResources,
		model: CuaModelRef | Model<Api>,
		requestedTools: readonly CuaAgentTool[],
	) {
		this.current = compileCuaToolCatalog({ model, requestedTools, resources });
	}

	get catalog(): CuaToolCatalog {
		return this.current;
	}

	getTools(): readonly CuaAgentTool[] {
		return [...this.current.requested];
	}

	inspectTools(): readonly CuaToolInfo[] {
		return this.current.entries.map((entry) => ({
			identity: entry.identity,
			name: entry.name,
			preferredName: entry.preferredName,
			origin: entry.origin,
			transport: entry.transport,
			dynamicLoading: entry.dynamicLoading,
			declaration: entry.declaration,
			...(entry.coordinates ? { coordinates: entry.coordinates } : {}),
			...(entry.requestGrounding ? { requestGrounding: entry.requestGrounding } : {}),
		}));
	}

	prepareTools(tools: readonly CuaAgentTool[]): CuaToolCatalog {
		this.assertMutationScope();
		return compileCuaToolCatalog({ model: this.current.model, requestedTools: tools, resources: this.resources });
	}

	prepareModel(model: CuaModelRef | Model<Api>): CuaToolCatalog {
		return compileCuaToolCatalog({ model, requestedTools: this.current.requested, resources: this.resources });
	}

	commit(next: CuaToolCatalog): void {
		this.current = next;
	}

	agentTools(catalog: CuaToolCatalog = this.current): AgentTool[] {
		return catalog.entries.map((entry) => {
			const tool = entry.agentTool;
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
		});
	}

	private assertMutationScope(): void {
		const scope = this.execution.getStore();
		if (scope && scope.executionMode !== "sequential") {
			throw new Error(`tool "${scope.toolName}" must declare executionMode: "sequential" before calling setTools() during execution`);
		}
	}
}

function cachePreservingAdditions(previous: CuaToolCatalog, next: CuaToolCatalog): string[] | undefined {
	if (previous.model.provider !== next.model.provider || previous.model.id !== next.model.id || previous.model.api !== next.model.api) return undefined;
	if (next.entries.length <= previous.entries.length) return undefined;
	for (let index = 0; index < previous.entries.length; index += 1) {
		if (previous.entries[index]?.fingerprint !== next.entries[index]?.fingerprint) return undefined;
	}
	const added = next.entries.slice(previous.entries.length);
	if (!modelSupportsDeferredTools(next.model) || added.some((entry) => entry.dynamicLoading !== "eligible")) return undefined;
	return added.map((entry) => entry.name);
}

function mergeAddedToolNames<T>(result: AgentToolResult<T>, names: readonly string[]): AgentToolResult<T> {
	if (names.length === 0) return result;
	return {
		...result,
		addedToolNames: [...new Set([...(result.addedToolNames ?? []), ...names])],
	};
}
