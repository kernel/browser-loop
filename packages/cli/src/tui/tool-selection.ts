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
	/**
	 * Tools that the catalog compiler refuses to accept as a partial set, and
	 * which therefore toggle as one unit. Currently only Yutori's n1 native
	 * action set (`validateToolsetCompatibility` rejects partial n1 subsets).
	 */
	atomicGroup?: string;
}

/** Identity key for a caller-owned tool, using cua-ai's canonical identity helper. */
export function toolKey(tool: CuaCliTool): string {
	return isCuaToolSpec(tool) ? tool.identity : callerToolIdentity(tool.name);
}

function toolGroup(tool: CuaCliTool): ToolGroup {
	if (!isCuaToolSpec(tool)) return "application";
	return tool.origin === "provider-native" ? "native" : "cua";
}

function atomicGroupOf(tool: CuaCliTool): string | undefined {
	if (!isCuaToolSpec(tool)) return undefined;
	const binding = tool.providerBinding;
	if (binding?.kind === "yutori-native" && binding.generation === "n1") {
		return "provider.yutori.native.n1";
	}
	return undefined;
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
		const atomicGroup = atomicGroupOf(tool);
		return {
			key: toolKey(tool),
			label: tool.name,
			group: toolGroup(tool),
			...(description ? { description } : {}),
			...(atomicGroup ? { atomicGroup } : {}),
		};
	});
}

/** Search text for the `/tools` filter: name, group badge, and description. */
export function toolSearchText(item: ToolSelectionItem): string {
	return `${item.label} ${item.group} ${item.key}${item.description ? ` ${item.description}` : ""}`;
}

/** Keys that must move together with `key` (itself included). */
function linkedKeys(items: readonly ToolSelectionItem[], key: string): string[] {
	const item = items.find((candidate) => candidate.key === key);
	if (!item?.atomicGroup) return [key];
	return items.filter((candidate) => candidate.atomicGroup === item.atomicGroup).map((candidate) => candidate.key);
}

/**
 * Flip one row. Atomic groups move as a unit so a Yutori n1 selection can
 * never be staged into a state the catalog compiler would reject.
 */
export function toggleTool(
	enabled: ReadonlySet<string>,
	items: readonly ToolSelectionItem[],
	key: string,
): Set<string> {
	const next = new Set(enabled);
	const keys = linkedKeys(items, key);
	const turnOn = !enabled.has(key);
	for (const linked of keys) {
		if (turnOn) next.add(linked);
		else next.delete(linked);
	}
	return next;
}

/** Enable `keys` (expanding atomic groups). */
export function enableTools(
	enabled: ReadonlySet<string>,
	items: readonly ToolSelectionItem[],
	keys: readonly string[],
): Set<string> {
	const next = new Set(enabled);
	for (const key of keys) for (const linked of linkedKeys(items, key)) next.add(linked);
	return next;
}

/** Disable `keys` (expanding atomic groups). */
export function disableTools(
	enabled: ReadonlySet<string>,
	items: readonly ToolSelectionItem[],
	keys: readonly string[],
): Set<string> {
	const next = new Set(enabled);
	for (const key of keys) for (const linked of linkedKeys(items, key)) next.delete(linked);
	return next;
}

/** True when both sets hold exactly the same keys. */
export function sameSelection(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const key of a) if (!b.has(key)) return false;
	return true;
}
