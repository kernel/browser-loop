/** Minimal accessibility node shape consumed by browser observation rendering. */
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

/** Indexes node ref ordinals within role/name cohorts for stable references. */
export interface NthIndex {
	index: Map<string, number>;
	cohorts: Map<string, number>;
}

/** Carries frame/session metadata needed to render and trace an observed node. */
export interface RenderContext {
	targetId: string;
	frameKey: string;
	sessionId: string;
	generation: number;
	interactiveOnly: boolean;
	nthIndex: NthIndex;
	cursorIds?: ReadonlySet<number>;
}

/** One rendered observation line plus source node and render context. */
export interface ObservationLine {
	text: string;
	refNode?: AXNode;
	ctx: RenderContext;
}

/** Stitched frame tree with node lookup and per-frame render context. */
export interface FrameStitch {
	byId: Map<string, AXNode>;
	roots: string[];
	ctx: RenderContext;
}

/** Flattened observed node entry paired with the context it came from. */
export interface ObservedNode {
	node: AXNode;
	ctx: RenderContext;
}

/** Full browser observation snapshot assembled from stitched frame trees. */
export interface BrowserObservation {
	targetId: string;
	tree: FrameStitch;
	stitches: Map<number, FrameStitch>;
	nodes: ObservedNode[];
	url: string;
	title: string;
	generations: Map<string, number>;
}

/** Cached presentation artifact derived from a browser observation snapshot. */
export interface BrowserPresentation {
	observation: BrowserObservation;
	cacheKey: string;
	lines: ObservationLine[];
	shape: string;
}

/** Signals that observation data changed mid-collection and must be retried. */
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

/** Builds a stable cohort identifier from a node's role/name pair. */
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
