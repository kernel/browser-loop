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

export interface NthIndex {
	index: Map<string, number>;
	cohorts: Map<string, number>;
}

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

export interface ObservationLine {
	text: string;
	refNode?: AXNode;
	ctx: RenderContext;
}

export interface FrameStitch {
	byId: Map<string, AXNode>;
	roots: string[];
	ctx: RenderContext;
}

export interface ObservedNode {
	node: AXNode;
	ctx: RenderContext;
}

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

export interface BrowserPresentation {
	observation: BrowserObservation;
	cacheKey: string;
	lines: ObservationLine[];
	shape: string;
}

export function frameStitchKey(parentFrameKey: string, backendNodeId: number): string {
	return `${parentFrameKey}\u0000${backendNodeId}`;
}

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
