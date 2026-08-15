import type { LoopCatalogModel } from "./model-info";
import { loop } from "./tools";
import { compileLoopToolCatalog, type LoopToolSpec } from "./tool-catalog";

/** Where a menu entry comes from, for grouping in a picker. */
export type LoopToolMenuGroup = "browser" | "computer" | "playwright" | "native";

/** One offerable item: a single tool, or a native toolset selected as a unit. */
export interface LoopToolMenuEntry {
	/** Stable key: the tool's catalog identity, or a `group:` key for a multi-tool entry. */
	readonly key: string;
	/** Model-facing name, or a label for a multi-tool entry. */
	readonly label: string;
	readonly group: LoopToolMenuGroup;
	readonly description?: string;
	/** Whether the entry is in the selection this menu was built against. */
	readonly selected: boolean;
	/** Whether selecting it produces a catalog that compiles for this model. */
	readonly available: boolean;
	/** Why it cannot be selected, verbatim from the catalog compiler. */
	readonly unavailableReason?: string;
	/** The specs this entry contributes to a tool list. */
	readonly tools: readonly LoopToolSpec[];
}

/**
 * Every tool Loop can offer for a model, marked available or not.
 *
 * Availability is decided by compiling the resulting catalog rather than by
 * restating the compiler's rules, so the menu cannot drift from what
 * `compileLoopToolCatalog` accepts: an entry is available exactly when selecting
 * it compiles. `compileLoopToolCatalog` is pure and declaration-only — it builds
 * no executable tools and retains none of its inputs — so probing it per entry
 * is cheap and free of side effects.
 *
 * Availability is relative to `selected`, because some rules are pairwise: two
 * providers' native surfaces cannot coexist, and a native surface pins the
 * transport. Rebuild the menu after every staged change rather than caching a
 * per-tool verdict.
 */
export function loopToolMenu(
	model: LoopCatalogModel,
	selected: readonly LoopToolSpec[] = [],
): LoopToolMenuEntry[] {
	const selectedIdentities = new Set(selected.map((tool) => tool.identity));
	return offerableEntries().map((entry) => {
		const isSelected = entry.tools.every((tool) => selectedIdentities.has(tool.identity));
		const candidate = isSelected
			? [...selected]
			: [...selected.filter((tool) => !entry.tools.some((offered) => offered.identity === tool.identity)), ...entry.tools];
		const failure = compileFailure(model, candidate);
		return {
			key: entry.key,
			label: entry.label,
			group: entry.group,
			...(entry.description ? { description: entry.description } : {}),
			selected: isSelected,
			available: failure === undefined,
			...(failure ? { unavailableReason: failure } : {}),
			tools: entry.tools,
		};
	});
}

function compileFailure(model: LoopCatalogModel, requestedTools: readonly LoopToolSpec[]): string | undefined {
	try {
		compileLoopToolCatalog({ model, requestedTools });
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

interface OfferableEntry {
	readonly key: string;
	readonly label: string;
	readonly group: LoopToolMenuGroup;
	readonly description?: string;
	readonly tools: readonly LoopToolSpec[];
}

/**
 * The full offerable surface, before any model is considered. Native entries
 * are listed for every provider Loop has an adapter for; the compile probe is
 * what decides which of them the selected model can actually take, so this list
 * carries no provider-name rule of its own.
 */
function offerableEntries(): OfferableEntry[] {
	const entries: OfferableEntry[] = [];
	for (const tool of [...loop.toolsets.browser(), loop.tools.browser.act()]) {
		entries.push(single(tool, "browser"));
	}
	for (const tool of loop.toolsets.computer()) {
		entries.push(single(tool, "computer"));
	}
	entries.push(single(loop.tools.playwright(), "playwright"));
	entries.push(single(loop.providers.openai.tools.computer(), "native"));
	entries.push(single(loop.providers.anthropic.tools.computer(), "native"));
	entries.push(single(loop.providers.anthropic.tools.browser(), "native"));
	const googleBrowser = loop.providers.google.toolsets.browser();
	entries.push({
		key: "group:google.native.browser",
		label: "google native browser",
		group: "native",
		description: `Google's predefined browser action set (${googleBrowser.length} actions), selected as one unit.`,
		tools: googleBrowser,
	});
	return entries;
}

function single(tool: LoopToolSpec, group: LoopToolMenuGroup): OfferableEntry {
	const description = firstLine(tool.declaration.description);
	return {
		key: tool.identity,
		label: tool.name,
		group,
		...(description ? { description } : {}),
		tools: [tool],
	};
}

function firstLine(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.trim().split("\n")[0]?.trim() || undefined;
}
