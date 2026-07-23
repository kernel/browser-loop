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
