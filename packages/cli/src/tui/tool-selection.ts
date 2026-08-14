import { callerToolIdentity, cuaToolMenu, isCuaToolSpec, type CuaModelRef, type CuaToolSpec } from "@onkernel/cua-ai";
import type { CuaCliTool } from "../harness";

/** Where a tool came from, used purely as a display badge. */
export type ToolGroup = "native" | "browser" | "computer" | "playwright" | "application";

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
	/** Whether selecting this row produces a catalog the model accepts. */
	available: boolean;
	/** Why it cannot be selected, from the catalog compiler. */
	unavailableReason?: string;
	/** The tools this row contributes when enabled. */
	tools: readonly CuaCliTool[];
}

/** Identity key for a caller-owned tool, using cua-ai's canonical identity helper. */
export function toolKey(tool: CuaCliTool): string {
	return isCuaToolSpec(tool) ? tool.identity : callerToolIdentity(tool.name);
}



function toolDescription(tool: CuaCliTool): string | undefined {
	const raw = isCuaToolSpec(tool) ? tool.declaration.description : tool.description;
	if (typeof raw !== "string") return undefined;
	const firstLine = raw.trim().split("\n")[0]?.trim();
	return firstLine || undefined;
}

/**
 * Describe everything selectable for a model: CUA's whole tool menu, then the
 * application's own tools.
 *
 * Availability comes from `cuaToolMenu`, which decides it by compiling the
 * resulting catalog, so a row shown as available is one `harness.setTools()`
 * will accept. Some of those rules are pairwise — two providers' native
 * surfaces cannot coexist — so this is rebuilt against each staged selection
 * rather than computed once.
 */
export function describeMenu(
	model: CuaModelRef,
	applicationTools: readonly CuaCliTool[],
	selectedTools: readonly CuaCliTool[],
): ToolSelectionItem[] {
	const selectedSpecs = selectedTools.filter(isCuaToolSpec);
	const items: ToolSelectionItem[] = cuaToolMenu(model, selectedSpecs).map((entry) => ({
		key: entry.key,
		label: entry.label,
		group: entry.group,
		...(entry.description ? { description: entry.description } : {}),
		available: entry.available,
		...(entry.unavailableReason ? { unavailableReason: entry.unavailableReason } : {}),
		tools: entry.tools as readonly CuaCliTool[],
	}));
	for (const tool of applicationTools) {
		const description = toolDescription(tool);
		items.push({
			key: toolKey(tool),
			label: tool.name,
			group: "application",
			...(description ? { description } : {}),
			available: true,
			tools: [tool],
		});
	}
	return items;
}

/** The exact tool list a staged selection produces, in menu order. */
export function toolsForSelection(items: readonly ToolSelectionItem[], enabled: ReadonlySet<string>): CuaCliTool[] {
	return items.filter((item) => enabled.has(item.key)).flatMap((item) => [...item.tools]);
}

/** Keys currently satisfied by a live tool list, for seeding the picker. */
export function selectedKeys(items: readonly ToolSelectionItem[], tools: readonly CuaCliTool[]): Set<string> {
	const present = new Set(tools.map(toolKey));
	return new Set(items.filter((item) => item.tools.every((tool) => present.has(toolKey(tool)))).map((item) => item.key));
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
