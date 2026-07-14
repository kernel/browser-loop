import type { BrowserObservationDiff } from "./types";

/** Minimal CDP accessibility node used by browser observations. */
export interface AXNode {
	nodeId: string;
	ignored?: boolean;
	role?: { value?: string };
	name?: { value?: string };
	value?: { value?: unknown };
	properties?: Array<{ name: string; value?: { value?: unknown } }>;
	backendDOMNodeId?: number;
	parentId?: string;
	childIds?: string[];
}

/** Role/name cohort positions used when minting and healing refs. */
export interface NthIndex {
	index: Map<string, number>;
	cohorts: Map<string, number>;
}

/** Frame and generation metadata required to render an observed node. */
export interface RenderContext {
	targetId: string;
	frameKey: string;
	/** Target whose CDP session owns this frame (page target or OOPIF target). */
	sessionTargetId: string;
	sessionId: string;
	generation: number;
	interactiveOnly: boolean;
	nthIndex: NthIndex;
	cursorIds?: ReadonlySet<number>;
}

/** One normalized accessibility line before its ref is minted. */
export interface ObservationLine {
	text: string;
	refNode?: AXNode;
	ctx: RenderContext;
}

/** Accessibility tree collected for one stitched child frame. */
export interface FrameStitch {
	byId: Map<string, AXNode>;
	roots: string[];
	ctx: RenderContext;
}

/** Accessibility node paired with its frame context. */
export interface ObservedNode {
	node: AXNode;
	ctx: RenderContext;
}

/** Stable structured browser state collected before presentation filtering. */
export interface BrowserObservation {
	targetId: string;
	navigationEpoch: number;
	tree: FrameStitch;
	stitches: Map<string, FrameStitch>;
	nodes: ObservedNode[];
	url: string;
	title: string;
	generations: Map<string, number>;
	complete: boolean;
}

/** Render-ready projection of one structured browser observation. */
export interface BrowserPresentation {
	observation: BrowserObservation;
	cacheKey: string;
	lines: ObservationLine[];
	shape: string;
}

/** Compare complete presentations while normalizing away snapshot-scoped refs. */
export function diffObservations(before: BrowserPresentation, after: BrowserPresentation): BrowserObservationDiff {
	const normalize = (line: string) => line.replace(/\u0000/g, "ref");
	const counts = new Map<string, number>();
	for (const { text } of before.lines) {
		const line = normalize(text);
		counts.set(line, (counts.get(line) ?? 0) + 1);
	}
	const added: string[] = [];
	for (const entry of after.lines) {
		const line = normalize(entry.text);
		const count = counts.get(line) ?? 0;
		if (count === 0) added.push(line);
		else counts.set(line, count - 1);
	}
	const removed = [...counts].flatMap(([line, count]) => Array.from({ length: count }, () => line));
	const url = before.observation.url === after.observation.url ? undefined : { before: before.observation.url, after: after.observation.url };
	const title = before.observation.title === after.observation.title ? undefined : { before: before.observation.title, after: after.observation.title };
	return { changed: added.length > 0 || removed.length > 0 || !!url || !!title, added, removed, ...(url ? { url } : {}), ...(title ? { title } : {}) };
}

/** Build the lookup key for an iframe node's stitched child tree. */
export function frameStitchKey(parentFrameKey: string, backendNodeId: number): string {
	return `${parentFrameKey}\u0000${backendNodeId}`;
}

/** Signals that browser state changed while an observation was collected. */
export class ObservationChangedError extends Error {
	constructor(message = "Browser observation changed during collection") {
		super(message);
		this.name = "ObservationChangedError";
	}
}

/** Index each ref-eligible node by its position among nodes with the same role and name, in tree order. */
export function buildNthIndex(nodes: AXNode[]): NthIndex {
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

/** Merge a run of two or more consecutive StaticText siblings (text split by inline markup) into one node. */
export function staticTextRun(tree: Map<string, AXNode>, childIds: string[], start: number): { node: AXNode; end: number } | undefined {
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
