import { callerToolIdentity, isCuaToolSpec } from "@onkernel/cua-ai";
import type { CuaCliTool } from "../harness";

/** Where a tool came from, used purely as a display badge. */
export type ToolGroup = "native" | "cua" | "application";

/** One row in the `/tools` picker, derived from a caller-owned tool. */
export interface ToolSelectionItem {
	/**
	 * Stable key matching the catalog compiler's identity scheme in
	 * `@onkernel/cua-ai`: a spec's own `identity`, or `callerToolIdentity(name)`
	 * for a plain pi `AgentTool`.
	 */
	key: string;
	/** Model-facing tool name. */
	label: string;
	group: ToolGroup;
	description?: string;
}

/** Identity key for a caller-owned tool, using cua-ai's canonical identity helper. */
export function toolKey(tool: CuaCliTool): string {
	return isCuaToolSpec(tool) ? tool.identity : callerToolIdentity(tool.name);
}

function toolGroup(tool: CuaCliTool): ToolGroup {
	if (!isCuaToolSpec(tool)) return "application";
	return tool.origin === "provider-native" ? "native" : "cua";
}

function toolDescription(tool: CuaCliTool): string | undefined {
	const raw = isCuaToolSpec(tool) ? tool.declaration.description : tool.description;
	if (typeof raw !== "string") return undefined;
	const firstLine = raw.trim().split("\n")[0]?.trim();
	return firstLine || undefined;
}

/**
 * Describe the baseline tool list for display. Order is preserved exactly as
 * the application composed it (`[...interactionTools, ...applicationTools]`),
 * so applying a selection can filter the baseline in place and keep the
 * provider-native catalog and application policy byte-for-byte identical.
 */
export function describeTools(tools: readonly CuaCliTool[]): ToolSelectionItem[] {
	return tools.map((tool) => {
		const description = toolDescription(tool);
		return {
			key: toolKey(tool),
			label: tool.name,
			group: toolGroup(tool),
			...(description ? { description } : {}),
		};
	});
}

/** Search text for the `/tools` filter: name, group badge, and description. */
export function toolSearchText(item: ToolSelectionItem): string {
	return `${item.label} ${item.group} ${item.key}${item.description ? ` ${item.description}` : ""}`;
}

/** Flip one row. */
export function toggleTool(enabled: ReadonlySet<string>, key: string): Set<string> {
	const next = new Set(enabled);
	if (enabled.has(key)) next.delete(key);
	else next.add(key);
	return next;
}

/** Enable `keys`. */
export function enableTools(enabled: ReadonlySet<string>, keys: readonly string[]): Set<string> {
	const next = new Set(enabled);
	for (const key of keys) next.add(key);
	return next;
}

/** Disable `keys`. */
export function disableTools(enabled: ReadonlySet<string>, keys: readonly string[]): Set<string> {
	const next = new Set(enabled);
	for (const key of keys) next.delete(key);
	return next;
}

/** True when both sets hold exactly the same keys. */
export function sameSelection(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const key of a) if (!b.has(key)) return false;
	return true;
}
