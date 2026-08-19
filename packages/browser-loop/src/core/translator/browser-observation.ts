import type { BrowserObservationDiff, BrowserObservationDiffEntry } from "./types";

/** Minimal CDP accessibility node used by browser observations. */
export interface AXNode {
	readonly nodeId: string;
	readonly ignored?: boolean;
	readonly role?: { readonly value?: string };
	readonly name?: { readonly value?: string };
	readonly value?: { readonly value?: unknown };
	readonly properties?: readonly { readonly name: string; readonly value?: { readonly value?: unknown } }[];
	readonly backendDOMNodeId?: number;
	readonly parentId?: string;
	readonly childIds?: readonly string[];
}

/** Role/name cohort positions used when minting and healing refs. */
export interface NthIndex {
	readonly index: ReadonlyMap<string, number>;
	readonly cohorts: ReadonlyMap<string, number>;
}

/** Immutable frame and generation metadata required to mint a ref. */
export interface RenderContext {
	readonly targetId: string;
	readonly frameKey: string;
	readonly sessionId: string;
	readonly generation: number;
	readonly nthIndex: NthIndex;
	readonly cursorIds?: ReadonlySet<number>;
}

/** One normalized accessibility line before its ref is minted. */
export interface ObservationLine {
	readonly text: string;
	readonly refNode?: AXNode;
	readonly ctx: RenderContext;
}

/** Accessibility tree collected for one frame. */
export interface FrameStitch {
	readonly byId: ReadonlyMap<string, AXNode>;
	readonly roots: readonly string[];
	readonly ctx: RenderContext;
}

/** A child frame that could not be collected because it detached or became inaccessible. */
export interface IncompleteFrame {
	readonly backendNodeId: number;
	readonly frameId?: string;
	readonly stage: "describe" | "resolve" | "accessibility";
	readonly reason: string;
}

/** Accessibility node paired with its frame context. */
export interface ObservedNode {
	readonly node: AXNode;
	readonly ctx: RenderContext;
}

/** Stable structured browser state collected before presentation filtering. */
export interface BrowserObservation {
	readonly targetId: string;
	/** Same-document navigation epoch for waits; cross-document changes use generations. */
	readonly navigationEpoch: number;
	readonly url: string;
	readonly title: string;
	readonly tree: FrameStitch;
	readonly stitches: ReadonlyMap<number, FrameStitch>;
	readonly incompleteFrames: readonly IncompleteFrame[];
	/** Target topology revision used only for observation/cache fencing, not ref validity. */
	readonly revision: number;
	readonly generations: ReadonlyMap<string, number>;
}

/** Render-ready projection of one structured browser observation. */
export interface BrowserPresentation {
	readonly observation: BrowserObservation;
	readonly cacheKey: string;
	readonly lines: readonly ObservationLine[];
	readonly shape: string;
}

/** Compare complete presentations while normalizing away snapshot-scoped refs. */
export function diffObservations(before: BrowserPresentation, after: BrowserPresentation): BrowserObservationDiff {
	const beforeCounts = lineCounts(before);
	const afterCounts = lineCounts(after);
	const difference = (source: ReadonlyMap<string, number>, other: ReadonlyMap<string, number>): BrowserObservationDiffEntry[] =>
		[...source].flatMap(([line, count]) => {
			const delta = count - (other.get(line) ?? 0);
			return delta > 0 ? [{ line, count: delta }] : [];
		});
	const added = difference(afterCounts, beforeCounts);
	const removed = difference(beforeCounts, afterCounts);
	const url = before.observation.url === after.observation.url ? undefined : { before: before.observation.url, after: after.observation.url };
	const title = before.observation.title === after.observation.title ? undefined : { before: before.observation.title, after: after.observation.title };
	return { changed: added.length > 0 || removed.length > 0 || !!url || !!title, added, removed, ...(url ? { url } : {}), ...(title ? { title } : {}) };
}

function lineCounts(presentation: BrowserPresentation): ReadonlyMap<string, number> {
	const counts = new Map<string, number>();
	for (const { text } of presentation.lines) {
		const line = text.replace(/\u0000/g, "ref");
		counts.set(line, (counts.get(line) ?? 0) + 1);
	}
	return counts;
}

/** Signals that browser state changed while an observation was collected. */
export class ObservationChangedError extends Error {
	constructor(message = "Browser observation changed during collection") {
		super(message);
		this.name = "ObservationChangedError";
	}
}

/** Signals that a scoped ref could not be verified in an incompletely collected frame. */
export class IncompleteObservationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IncompleteObservationError";
	}
}

export const REF_PLACEHOLDER = "\u0000";

export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
	"button",
	"link",
	"textbox",
	"searchbox",
	"checkbox",
	"radio",
	"combobox",
	"listbox",
	"option",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"slider",
	"spinbutton",
	"switch",
	"tab",
	"treeitem",
]);

export const FRAME_ROLES: ReadonlySet<string> = new Set(["Iframe", "IframePresentational"]);

const SKIPPED_ROLES: ReadonlySet<string> = new Set(["none", "generic", "InlineTextBox", "LineBreak", "StaticText"]);

/** Non-interactive roles that get refs when named, so scroll_to / ref-scoped snapshots can target them. */
const CONTENT_ROLES: ReadonlySet<string> = new Set([
	"heading",
	"cell",
	"gridcell",
	"columnheader",
	"rowheader",
	"row",
	"listitem",
	"article",
	"region",
	"main",
	"navigation",
	"banner",
	"contentinfo",
	"complementary",
	"tabpanel",
	"figure",
	"image",
]);

/** Index each ref-healing candidate by its position among nodes with the same role and name, in tree order. */
export function buildNthIndex(nodes: readonly AXNode[]): NthIndex {
	const cohorts = new Map<string, number>();
	const index = new Map<string, number>();
	for (const node of nodes) {
		if (node.ignored || node.backendDOMNodeId === undefined) continue;
		const key = cohortKey(node.role?.value ?? "", node.name?.value ?? "");
		const nth = cohorts.get(key) ?? 0;
		cohorts.set(key, nth + 1);
		index.set(node.nodeId, nth);
	}
	return { index, cohorts };
}

/** Build the stable key for a role/name ref-healing cohort. */
export function cohortKey(role: string, name: string): string {
	return `${role}\u0000${name}`;
}

/** Iterate an observation without eagerly allocating a wrapper for every AX node. */
export function* observedNodes(observation: BrowserObservation): IterableIterator<ObservedNode> {
	for (const node of observation.tree.byId.values()) yield { node, ctx: observation.tree.ctx };
	for (const stitch of observation.stitches.values()) {
		for (const node of stitch.byId.values()) yield { node, ctx: stitch.ctx };
	}
}

/** Merge a run of two or more consecutive StaticText siblings (text split by inline markup) into one node. */
export function staticTextRun(
	tree: ReadonlyMap<string, AXNode>,
	childIds: readonly string[],
	start: number,
): { node: AXNode; end: number } | undefined {
	let end = start;
	const parts: string[] = [];
	while (end < childIds.length) {
		const node = tree.get(childIds[end]!);
		if (!node || node.ignored || node.role?.value !== "StaticText") break;
		const text = node.name?.value ?? "";
		if (text) parts.push(text);
		end += 1;
	}
	if (end - start < 2) return undefined;
	const first = tree.get(childIds[start]!)!;
	return { node: { ...first, name: { value: parts.join(" ") }, childIds: [] }, end: end - 1 };
}

export function renderObservationNode(
	node: AXNode,
	depth: number,
	parentName: string,
	ctx: RenderContext,
	interactiveOnly: boolean,
): { text: string; refNode?: AXNode } | undefined {
	const role = node.role?.value ?? "";
	const name = node.name?.value ?? "";
	const interactive = INTERACTIVE_ROLES.has(role);
	const pointer = node.backendDOMNodeId !== undefined && (ctx.cursorIds?.has(node.backendDOMNodeId) ?? false);
	if (interactiveOnly && !interactive && !pointer) return undefined;
	if (role === "StaticText" && name === parentName) return undefined;
	if (!interactiveOnly && !name && !interactive && !pointer && SKIPPED_ROLES.has(role)) return undefined;
	let line = `${"  ".repeat(Math.min(depth, 20))}${role || "node"}${name ? ` ${JSON.stringify(name)}` : ""}`;
	let refNode: AXNode | undefined;
	const refWorthy = interactive || pointer || FRAME_ROLES.has(role) || (name !== "" && CONTENT_ROLES.has(role));
	if (node.backendDOMNodeId !== undefined && refWorthy) {
		line += ` [${REF_PLACEHOLDER}]`;
		refNode = node;
	}
	const states = collectStates(node);
	if (pointer && !interactive) states.push("cursor:pointer");
	if (states.length > 0) line += ` [${states.join(", ")}]`;
	return { text: line, refNode };
}

function collectStates(node: AXNode): string[] {
	const states: string[] = [];
	for (const property of node.properties ?? []) {
		const value = property.value?.value;
		switch (property.name) {
			case "checked":
			case "pressed":
			case "expanded":
				// False is meaningful here: it distinguishes an unchecked checkbox or
				// collapsed disclosure from an element without the state at all.
				if (value === true || value === "true") states.push(property.name);
				else if (value === false || value === "false") states.push(`${property.name}=false`);
				else if (value === "mixed") states.push(`${property.name}=mixed`);
				break;
			case "disabled":
			case "selected":
			case "required":
				if (value === true || value === "true") states.push(property.name);
				break;
			case "level":
				if (typeof value === "number") states.push(`level=${value}`);
				break;
		}
	}
	const value = node.value?.value;
	if (value !== undefined && value !== "" && String(value) !== (node.name?.value ?? "")) {
		states.push(`value=${JSON.stringify(String(value))}`);
	}
	return states;
}
