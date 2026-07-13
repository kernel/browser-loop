import type { BrowserObservationDiff } from "./types";

export const REF_PLACEHOLDER = "\u0000";

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
	sessionTargetId: string;
	sessionId: string;
	generation: number;
	nthIndex: NthIndex;
	cursorIds?: ReadonlySet<number>;
}

export interface ObservationLine {
	text: string;
	refNode?: AXNode;
	ctx: RenderContext;
}

export interface ObservedNode {
	node: AXNode;
	ctx: RenderContext;
}

export interface FrameStitch {
	byId: Map<string, AXNode>;
	roots: string[];
	ctx: RenderContext;
}

export interface FrameStitchResult {
	frames: Map<string, FrameStitch>;
	complete: boolean;
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
	key: string;
	lines: ObservationLine[];
	shape: string;
}

export class ObservationChangedError extends Error {
	constructor() {
		super("page changed while collecting the browser observation");
	}
}

export class MissingFrameObservationError extends Error {}

export function diffObservations(before: BrowserPresentation, after: BrowserPresentation): BrowserObservationDiff {
	const oldLines = before.lines.map((line) => line.text.replace(REF_PLACEHOLDER, "ref"));
	const newLines = after.lines.map((line) => line.text.replace(REF_PLACEHOLDER, "ref"));
	const remaining = new Map<string, number>();
	for (const line of oldLines) remaining.set(line, (remaining.get(line) ?? 0) + 1);
	const added: string[] = [];
	for (const line of newLines) {
		const count = remaining.get(line) ?? 0;
		if (count === 0) added.push(line);
		else remaining.set(line, count - 1);
	}
	const removed: string[] = [];
	for (const [line, count] of remaining) {
		for (let index = 0; index < count; index += 1) removed.push(line);
	}
	const url =
		before.observation.url === after.observation.url
			? undefined
			: { before: before.observation.url, after: after.observation.url };
	const title =
		before.observation.title === after.observation.title
			? undefined
			: { before: before.observation.title, after: after.observation.title };
	return {
		changed: added.length > 0 || removed.length > 0 || url !== undefined || title !== undefined,
		added,
		removed,
		...(url ? { url } : {}),
		...(title ? { title } : {}),
	};
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

export function frameStitchKey(parentFrameKey: string, backendNodeId: number): string {
	return `${parentFrameKey}\u0000${backendNodeId}`;
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
