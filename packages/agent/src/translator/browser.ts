import {
	normalizeGotoUrl,
	type CuaActionBrowserAct,
	type CuaBrowserActStep,
	type CuaBrowserExpectation,
	type CuaActionBrowserClick,
	type CuaActionBrowserDrag,
	type CuaActionBrowserFill,
	type CuaActionBrowserFind,
	type CuaActionBrowserHover,
	type CuaActionBrowserKey,
	type CuaActionBrowserNavigate,
	type CuaActionBrowserScroll,
	type CuaActionBrowserScrollTo,
	type CuaActionBrowserSnapshot,
	type CuaBrowserAction,
} from "@onkernel/cua-ai";
import { CdpConnection, type CdpEventMessage } from "./cdp";
import type {
	BatchReadResult,
	BrowserActResult,
	BrowserActStepResult,
	BrowserExpectationEvidence,
	BrowserObservationDiff,
} from "./types";

const SNAPSHOT_CHAR_LIMIT = 50_000;
const DEFAULT_SNAPSHOT_DEPTH = 15;
const FIND_MATCH_LIMIT = 20;
const REF_LIMIT_PER_TARGET = 1000;
const SCROLL_NOTCH_PX = 120;
const EXPECTATION_TIMEOUT_MS = 2_000;
const EXPECTATION_POLL_MS = 50;

const STALE_REF_HINT = "Call snapshot (or find) to get fresh element references.";
const REF_PLACEHOLDER = "\u0000";
const UNCHANGED_SNAPSHOT = "Page unchanged since the last snapshot; previous element refs are still valid.";

interface AXNode {
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

interface RefEntry {
	backendNodeId: number;
	targetId: string;
	/** Generation key: the owning page target id for main-frame refs, the frame id for iframe refs. */
	frameId: string;
	/** Target whose CDP session owns this frame; omitted only by ref state exported before this field existed. */
	sessionTargetId?: string;
	/** Session to route DOM/Input calls through: the frame's own session for OOPIFs, the page session otherwise. */
	sessionId: string;
	generation: number;
	role: string;
	name: string;
	nth: number;
	/** Size of the (role, name) cohort in the tree the ref was minted from. */
	cohort: number;
}

interface NthIndex {
	index: Map<string, number>;
	cohorts: Map<string, number>;
}

interface RenderContext {
	targetId: string;
	frameKey: string;
	sessionTargetId: string;
	sessionId: string;
	generation: number;
	nthIndex: NthIndex;
	cursorIds?: ReadonlySet<number>;
}

interface ObservationLine {
	text: string;
	refNode?: AXNode;
	ctx: RenderContext;
}

interface ObservedNode {
	node: AXNode;
	ctx: RenderContext;
}

interface BrowserObservation {
	targetId: string;
	tree: FrameStitch;
	stitches: Map<string, FrameStitch>;
	nodes: ObservedNode[];
	url: string;
	title: string;
	generations: Map<string, number>;
	complete: boolean;
}

interface BrowserPresentation {
	observation: BrowserObservation;
	key: string;
	lines: ObservationLine[];
	shape: string;
}

interface FrameStitch {
	byId: Map<string, AXNode>;
	roots: string[];
	ctx: RenderContext;
}

interface FrameStitchResult {
	frames: Map<string, FrameStitch>;
	complete: boolean;
}

export interface BrowserFindCandidate {
	ref: string;
	role: string;
	name: string;
	score: number;
}

/**
 * Serializable ref state, so refs minted in one process (e.g. a `cua
 * snapshot` invocation) can be resolved in a later one against the same
 * browser. Session ids are process-local and deliberately not exported;
 * imported refs rebind lazily. Backend node ids stay valid for the life of
 * the document, and the usual generation/self-heal machinery covers pages
 * that changed in between.
 */
export interface BrowserRefState {
	refCounter: number;
	activeTargetId?: string;
	generations: Array<[string, number]>;
	refs: Array<[string, Omit<RefEntry, "sessionId">]>;
	frameParents?: Array<[string, string]>;
}

/**
 * Executes browser-plane canonical actions over CDP.
 *
 * Element refs are snapshot-scoped: each snapshot/find mints `e<N>` ids
 * mapped to CDP backend node ids for the target's current generation. Any
 * main-frame navigation — our own navigate() or a page-initiated one seen
 * via Page.frameNavigated — bumps the generation and prunes that target's
 * refs, so refs from earlier generations resolve to a stale-ref error whose
 * message tells the model how to recover.
 *
 * A ref whose backend node vanished without a navigation (DOM churn) is
 * self-healed: the AX tree is re-fetched and the ref re-resolved by the
 * (role, name, nth) triple recorded at mint time, but only when the fresh
 * cohort has the same size as at mint time.
 *
 * Snapshots stitch iframe content under each iframe node: same-process
 * frames via the page session's AX tree with a frameId, out-of-process
 * frames via their auto-attached session. Refs record their frame and
 * session so actions resolve through the right one, and each frame's refs
 * are invalidated independently when that frame navigates. Re-snapshotting
 * an unchanged page with the same params returns a short unchanged notice
 * instead of the full tree.
 *
 * Native JavaScript dialogs are auto-handled so they never wedge the CDP
 * session: alert and beforeunload dialogs are accepted (so navigation can
 * proceed), confirm and prompt dialogs are dismissed. The dialog message
 * is surfaced as an extra read result on the next executed action.
 */
export class BrowserExecutor {
	private readonly refs = new Map<string, RefEntry>();
	private readonly generations = new Map<string, number>();
	private readonly targetsBySession = new Map<string, string>();
	private readonly frameSessions = new Map<string, string>();
	private readonly frameTargets = new Set<string>();
	private readonly frameParents = new Map<string, string>();
	private readonly lastSnapshots = new Map<string, BrowserPresentation>();
	private readonly selfNavigations = new Set<string>();
	private readonly dialogNotes: string[] = [];
	private refCounter = 0;
	private activeTargetId?: string;
	private readonly cdp: CdpConnection;

	constructor(cdp: string | CdpConnection) {
		this.cdp = typeof cdp === "string" ? new CdpConnection(cdp) : cdp;
		this.cdp.onEvent((event) => this.handleCdpEvent(event));
	}

	private handleCdpEvent(event: CdpEventMessage): void {
		switch (event.method) {
			case "Page.frameNavigated": {
				const frame = event.params.frame as { id?: string; parentId?: string } | undefined;
				if (!event.sessionId || !frame) return;
				const targetId = this.targetsBySession.get(event.sessionId);
				if (!targetId) return;
				if (this.frameTargets.has(targetId)) {
					this.invalidateSessionTarget(targetId);
					return;
				}
				if (frame.parentId) {
					if (frame.id) this.invalidateFrame(frame.id);
					return;
				}
				if (!this.selfNavigations.delete(targetId)) this.invalidateRefs(targetId);
				return;
			}
			case "Page.navigatedWithinDocument": {
				// A navigate() that turns out same-document never fires frameNavigated;
				// consume the pending flag here so it can't swallow the next real navigation.
				if (!event.sessionId) return;
				const targetId = this.targetsBySession.get(event.sessionId);
				const { frameId } = event.params as { frameId?: string };
				if (targetId && frameId === targetId) this.selfNavigations.delete(targetId);
				return;
			}
			case "Target.attachedToTarget": {
				const { sessionId, targetInfo } = event.params as { sessionId?: string; targetInfo?: { targetId?: string; type?: string } };
				if (!sessionId || !targetInfo?.targetId || targetInfo.type !== "iframe") return;
				this.frameSessions.set(targetInfo.targetId, sessionId);
				this.frameTargets.add(targetInfo.targetId);
				this.targetsBySession.set(sessionId, targetInfo.targetId);
				void this.cdp.send("Page.enable", {}, sessionId).catch(() => {});
				return;
			}
			case "Page.javascriptDialogOpening": {
				if (!event.sessionId) return;
				const { type, message } = event.params as { type?: string; message?: string };
				const accept = type === "alert" || type === "beforeunload";
				void this.cdp.send("Page.handleJavaScriptDialog", { accept }, event.sessionId).catch(() => {});
				const summary =
					type === "beforeunload"
						? "Accepted a beforeunload dialog so navigation could proceed"
						: accept
							? "Acknowledged a JavaScript alert dialog"
							: `Dismissed a JavaScript ${type ?? "dialog"} dialog (answered No/cancel)`;
				this.dialogNotes.push(`${summary}: ${JSON.stringify(message ?? "")}`);
				return;
			}
			case "Target.detachedFromTarget": {
				const sessionId = event.params.sessionId;
				if (typeof sessionId !== "string") return;
				const targetId = this.targetsBySession.get(sessionId);
				this.targetsBySession.delete(sessionId);
				if (targetId) this.dropTarget(targetId);
				return;
			}
		}
	}

	/** Close the CDP connection. Safe to call when never connected. */
	close(): void {
		this.cdp.close();
	}

	/** Snapshot the ref table for persistence across invocations; see {@link BrowserRefState}. */
	exportRefState(): BrowserRefState {
		return {
			refCounter: this.refCounter,
			...(this.activeTargetId ? { activeTargetId: this.activeTargetId } : {}),
			generations: [...this.generations],
			refs: [...this.refs].map(([ref, { sessionId: _sessionId, ...entry }]) => [ref, entry]),
			frameParents: [...this.frameParents],
		};
	}

	/** Restore a ref table exported by a previous invocation against the same browser. */
	importRefState(state: BrowserRefState): void {
		this.refCounter = Math.max(this.refCounter, state.refCounter);
		this.activeTargetId = state.activeTargetId ?? this.activeTargetId;
		for (const [frameId, generation] of state.generations) this.generations.set(frameId, generation);
		for (const [ref, entry] of state.refs) this.refs.set(ref, { ...entry, sessionId: "" });
		for (const [frameId, parentId] of state.frameParents ?? []) this.frameParents.set(frameId, parentId);
	}

	async execute(action: CuaBrowserAction): Promise<BatchReadResult[]> {
		const results = await this.dispatch(action);
		const dialogs = this.drainDialogNotes();
		if (dialogs) results.push({ type: "browser_text", label: "dialog", text: dialogs });
		return results;
	}

	private async dispatch(action: CuaBrowserAction): Promise<BatchReadResult[]> {
		switch (action.type) {
			case "browser_snapshot":
				return [{ type: "browser_text", label: "snapshot", text: await this.snapshot(action) }];
			case "browser_act":
				return [{ type: "browser_act", result: await this.act(action) }];
			case "browser_text":
				return [{ type: "browser_text", label: "text", text: await this.pageText(tabOf(action)) }];
			case "browser_find":
				return [{ type: "browser_text", label: "find", text: await this.find(action) }];
			case "browser_click":
				await this.click(action);
				return [];
			case "browser_hover":
				await this.hover(action);
				return [];
			case "browser_drag":
				await this.drag(action);
				return [];
			case "browser_fill":
				await this.fill(action);
				return [];
			case "browser_scroll_to":
				await this.scrollTo(action);
				return [];
			case "browser_scroll":
				await this.scroll(action);
				return [];
			case "browser_type": {
				const session = await this.session(tabOf(action));
				await this.cdp.send("Input.insertText", { text: action.text }, session);
				return [];
			}
			case "browser_key":
				await this.key(action);
				return [];
			case "browser_navigate":
				return [{ type: "browser_text", label: "navigate", text: await this.navigate(action) }];
			case "browser_list_tabs":
				return [{ type: "browser_text", label: "tabs", text: await this.listTabs() }];
			case "browser_new_tab":
				return [{ type: "browser_text", label: "new_tab", text: await this.newTab() }];
			case "browser_screenshot":
				return [{ type: "screenshot", ...(await this.screenshot(action.region, action.tab_id)) }];
			case "browser_evaluate":
				return [{ type: "browser_text", label: "evaluate", text: await this.evaluate(action.code, tabOf(action)) }];
		}
	}

	async screenshot(region?: [number, number, number, number], tabId?: string): Promise<{ data: Buffer; mimeType: string }> {
		const session = await this.session(tabId);
		const clip = region
			? {
					clip: {
						x: Math.min(region[0], region[2]),
						y: Math.min(region[1], region[3]),
						width: Math.max(1, Math.abs(region[2] - region[0])),
						height: Math.max(1, Math.abs(region[3] - region[1])),
						scale: 1,
					},
				}
			: {};
		const { data } = await this.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", ...clip }, session);
		return { data: Buffer.from(data, "base64"), mimeType: "image/png" };
	}

	private async snapshot(action: CuaActionBrowserSnapshot): Promise<string> {
		const presentation = this.presentObservation(await this.observe(action.tab_id), action);
		const cached = this.lastSnapshots.get(presentation.observation.targetId);
		this.lastSnapshots.set(presentation.observation.targetId, presentation);
		if (cached && cached.key === presentation.key && cached.shape === presentation.shape) return UNCHANGED_SNAPSHOT;
		return this.renderObservation(presentation);
	}

	/** Build a generation-fenced observation before applying presentation options or minting refs. */
	private async observe(tabId?: string): Promise<BrowserObservation> {
		let changed: ObservationChangedError | undefined;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				return await this.collectObservation(tabId);
			} catch (err) {
				if (!(err instanceof ObservationChangedError)) throw err;
				changed = err;
			}
		}
		throw changed ?? new ObservationChangedError();
	}

	private async collectObservation(tabId?: string): Promise<BrowserObservation> {
		const targetId = await this.resolveTarget(tabId);
		const pageSession = await this.attach(targetId);
		const targetsBefore = await this.cdp.pageTargets();
		const targetBefore = targetsBefore.find((candidate) => candidate.targetId === targetId);
		if (!targetBefore) throw new ObservationChangedError();
		const generationBefore = this.trackGeneration(targetId);
		const { nodes, sessionId } = await this.frameAxTree(targetId, targetId, pageSession);
		const ctx: RenderContext = {
			targetId,
			frameKey: targetId,
			sessionTargetId: targetId,
			sessionId,
			generation: generationBefore,
			nthIndex: buildNthIndex(nodes),
			cursorIds: await this.cursorPointerIds(pageSession),
		};
		const tree: FrameStitch = {
			byId: new Map(nodes.map((node) => [node.nodeId, node])),
			roots: nodes.filter((node) => !node.parentId).map((node) => node.nodeId),
			ctx,
		};
		const { frames: stitches, complete } = await this.stitchFrames(nodes, targetId, pageSession);
		const observedNodes: ObservedNode[] = nodes.map((node) => ({ node, ctx }));
		for (const stitch of stitches.values()) {
			for (const node of stitch.byId.values()) observedNodes.push({ node, ctx: stitch.ctx });
		}
		const targetsAfter = await this.cdp.pageTargets();
		const targetAfter = targetsAfter.find((candidate) => candidate.targetId === targetId);
		if (
			!targetAfter ||
			generationBefore !== this.generation(targetId) ||
			targetBefore.url !== targetAfter.url ||
			targetBefore.title !== targetAfter.title
		) {
			throw new ObservationChangedError();
		}
		const generations = new Map<string, number>([[targetId, ctx.generation]]);
		for (const stitch of stitches.values()) generations.set(stitch.ctx.frameKey, stitch.ctx.generation);
		if ([...generations].some(([frameKey, generation]) => this.generation(frameKey) !== generation)) {
			throw new ObservationChangedError();
		}
		this.pruneFrameState(targetId, new Set(generations.keys()));
		return {
			targetId,
			tree,
			stitches,
			nodes: observedNodes,
			url: targetAfter.url,
			title: targetAfter.title,
			generations,
			complete,
		};
	}

	private presentObservation(observation: BrowserObservation, action: CuaActionBrowserSnapshot): BrowserPresentation {
		let tree = observation.tree;
		let rootIds = tree.roots;
		if (action.ref) {
			const entry = this.resolveRef(action.ref, observation.targetId);
			const frameTree =
				entry.frameId === observation.tree.ctx.frameKey
					? observation.tree
					: [...observation.stitches.values()].find((candidate) => candidate.ctx.frameKey === entry.frameId);
			if (!frameTree) throw staleRefError(action.ref);
			tree = frameTree;
			const nodes = [...tree.byId.values()];
			const rootNode = nodes.find((node) => node.backendDOMNodeId === entry.backendNodeId) ?? this.healEntry(action.ref, entry, nodes);
			rootIds = [rootNode.nodeId];
		}

		const interactiveOnly = action.filter === "interactive";
		const maxDepth = action.depth ?? DEFAULT_SNAPSHOT_DEPTH;
		const lines: ObservationLine[] = [];
		const walk = (nodes: Map<string, AXNode>, treeCtx: RenderContext, nodeId: string, depth: number, parentName: string): void => {
			const node = nodes.get(nodeId);
			if (!node) return;
			let childDepth = depth;
			if (!node.ignored) {
				const rendered = this.renderNode(node, depth, parentName, treeCtx, interactiveOnly);
				if (rendered) {
					lines.push({ ...rendered, ctx: treeCtx });
					childDepth = depth + 1;
				}
			}
			if (childDepth > maxDepth) return;
			const stitch =
				node.backendDOMNodeId === undefined
					? undefined
					: observation.stitches.get(frameStitchKey(treeCtx.frameKey, node.backendDOMNodeId));
			if (stitch) {
				for (const frameRootId of stitch.roots) walk(stitch.byId, stitch.ctx, frameRootId, childDepth, "");
				return;
			}
			const name = node.name?.value ?? "";
			const childName = name || parentName;
			const childIds = node.childIds ?? [];
			for (let index = 0; index < childIds.length; index += 1) {
				const run = staticTextRun(nodes, childIds, index);
				if (run) {
					const rendered = this.renderNode(run.node, childDepth, childName, treeCtx, interactiveOnly);
					if (rendered) lines.push({ ...rendered, ctx: treeCtx });
					index = run.end;
					continue;
				}
				walk(nodes, treeCtx, childIds[index]!, childDepth, childName);
			}
		};
		for (const rootId of rootIds) walk(tree.byId, tree.ctx, rootId, 0, "");

		const frameGenerations = [...observation.generations].map(([key, generation]) => `${key}:${generation}`);
		return {
			observation,
			key: [action.ref ?? "", action.depth ?? "", action.filter ?? "", ...frameGenerations].join("|"),
			lines,
			shape: lines.map((line) => line.text).join("\n"),
		};
	}

	private renderObservation(presentation: BrowserPresentation): string {
		let text = "";
		for (const line of presentation.lines) {
			if (text.length > SNAPSHOT_CHAR_LIMIT) break;
			const rendered = line.refNode ? line.text.replace(REF_PLACEHOLDER, this.mintRef(line.refNode, line.ctx)) : line.text;
			text = text ? `${text}\n${rendered}` : rendered;
		}
		if (text.length > SNAPSHOT_CHAR_LIMIT) {
			text = `${text.slice(0, SNAPSHOT_CHAR_LIMIT)}\n… truncated at ${SNAPSHOT_CHAR_LIMIT} characters. Re-request with a smaller depth, filter: "interactive", or a ref to narrow the subtree.`;
		}
		this.pruneRefs(presentation.observation.targetId);
		return text || "(empty accessibility tree)";
	}

	private async act(action: CuaActionBrowserAct): Promise<BrowserActResult> {
		const observationAction: CuaActionBrowserSnapshot = { type: "browser_snapshot", tab_id: action.tab_id, ...action.successor };
		const completeObservationAction: CuaActionBrowserSnapshot = {
			type: "browser_snapshot",
			tab_id: action.tab_id,
			depth: Number.MAX_SAFE_INTEGER,
		};
		const baseline = await this.observe(action.tab_id);
		let current = baseline;
		let currentTargets = await this.pageTargetIds();
		let currentDialogCount = this.dialogNotes.length;
		const steps: BrowserActStepResult[] = [];
		let stoppedAt: number | undefined;
		let stopReason: BrowserActResult["stop_reason"];

		for (let index = 0; index < action.steps.length; index += 1) {
			const step = action.steps[index]!;
			const evidence: string[] = [];
			let beforeObservation: BrowserObservation;
			let beforeTargets: string[];
			try {
				beforeObservation = await this.observe(action.tab_id);
				beforeTargets = await this.pageTargetIds();
			} catch (err) {
				evidence.push(`pre-action observation failed: ${errorMessage(err)}`);
				steps.push({ index, type: step.type, outcome: "unknown", evidence });
				stoppedAt = index;
				stopReason = "control_flow";
				break;
			}

			const boundary = browserControlChange(
				current,
				beforeObservation,
				this.generations,
				currentTargets,
				beforeTargets,
				currentDialogCount,
				this.dialogNotes.length,
			);
			current = beforeObservation;
			currentTargets = beforeTargets;
			currentDialogCount = this.dialogNotes.length;
			if (boundary) {
				evidence.push(`${boundary} detected before input delivery`);
				steps.push({ index, type: step.type, outcome: "unknown", evidence });
				stoppedAt = index;
				stopReason = boundary;
				break;
			}

			const before = step.expect ? this.evaluateExpectation(step.expect, beforeObservation, baseline) : undefined;
			const dialogCount = currentDialogCount;
			let actionError: unknown;
			try {
				await this.executeActStep(step, action.tab_id);
				evidence.push("input delivered");
			} catch (err) {
				actionError = err;
				evidence.push(errorMessage(err));
			}

			let expectation: BrowserExpectationEvidence | undefined;
			let observationError: unknown;
			let boundaryAfter: BrowserActResult["stop_reason"];
			const deadline = Date.now() + EXPECTATION_TIMEOUT_MS;
			while (true) {
				try {
					await delay(0);
					const afterObservation = await this.observe(action.tab_id);
					await delay(0);
					const afterTargets = await this.pageTargetIds();
					boundaryAfter = browserControlChange(
						beforeObservation,
						afterObservation,
						this.generations,
						beforeTargets,
						afterTargets,
						dialogCount,
						this.dialogNotes.length,
					);
					current = afterObservation;
					currentTargets = afterTargets;
					currentDialogCount = this.dialogNotes.length;
					if (step.expect) expectation = expectationEvidence(before!, this.evaluateExpectation(step.expect, current, baseline));
					if (boundaryAfter && expectation?.status === "failed") {
						expectation = { ...expectation, status: "unverifiable", details: [...expectation.details, `${boundaryAfter} interrupted verification`] };
					}
					if (boundaryAfter || !step.expect || expectation?.status !== "failed" || Date.now() >= deadline) break;
					await delay(EXPECTATION_POLL_MS);
				} catch (err) {
					observationError = err;
					if (step.expect) {
						expectation = {
							status: "unverifiable",
							before: before?.truth,
							details: [...(before?.details ?? []), errorMessage(err)],
						};
					}
					break;
				}
			}

			let outcome: BrowserActStepResult["outcome"] = "unknown";
			const staleRef = actionError !== undefined && /ref .* stale/.test(errorMessage(actionError));
			if (expectation?.status === "newly_verified" && actionError === undefined) outcome = "worked";
			else if (expectation?.status === "failed" || staleRef) outcome = "didnt";
			if (expectation) evidence.push(`expectation ${expectation.status}`);
			if (observationError) evidence.push(`post-action observation failed: ${errorMessage(observationError)}`);
			steps.push({ index, type: step.type, outcome, evidence, ...(expectation ? { expectation } : {}) });

			if (boundaryAfter) {
				stopReason = boundaryAfter;
			} else if (observationError || expectation?.status === "unverifiable") {
				stopReason = "control_flow";
			} else if (actionError) {
				stopReason = staleRef ? "stale_ref" : "action_failed";
			} else if (expectation?.status === "failed") {
				stopReason = "expectation_failed";
			}
			if (stopReason) {
				stoppedAt = index;
				break;
			}
		}

		let finalExpectation: BrowserExpectationEvidence | undefined;
		const terminalNavigation =
			stopReason === "navigation" &&
			stoppedAt === action.steps.length - 1 &&
			steps.length === action.steps.length &&
			steps.at(-1)?.evidence.includes("input delivered") === true;
		if (action.expect && (!stopReason || terminalNavigation)) {
			const before = this.evaluateExpectation(action.expect, baseline, baseline);
			const deadline = Date.now() + EXPECTATION_TIMEOUT_MS;
			while (true) {
				try {
					const afterObservation = await this.observe(action.tab_id);
					await delay(0);
					const afterTargets = await this.pageTargetIds();
					const boundary = browserControlChange(
						current,
						afterObservation,
						this.generations,
						currentTargets,
						afterTargets,
						currentDialogCount,
						this.dialogNotes.length,
					);
					current = afterObservation;
					currentTargets = afterTargets;
					currentDialogCount = this.dialogNotes.length;
					if (boundary) {
						finalExpectation = {
							status: "unverifiable",
							before: before.truth,
							details: [...(finalExpectation?.details ?? before.details), `${boundary} interrupted verification`],
						};
						stopReason = boundary;
						break;
					}
					finalExpectation = expectationEvidence(before, this.evaluateExpectation(action.expect, current, baseline));
					if (finalExpectation.status !== "failed" || Date.now() >= deadline) break;
					await delay(EXPECTATION_POLL_MS);
				} catch (err) {
					finalExpectation = { status: "unverifiable", before: before.truth, details: [...before.details, errorMessage(err)] };
					stopReason = "control_flow";
					break;
				}
			}
			if (finalExpectation?.status === "failed") {
				stopReason = "expectation_failed";
				stoppedAt = action.steps.length;
			} else if (finalExpectation?.status === "unverifiable") {
				stopReason ??= "control_flow";
				stoppedAt = action.steps.length;
			}
		}

		let successor: BrowserActResult["successor"] | undefined;
		let successorError: unknown;
		for (let attempt = 0; attempt < 3 && !successor; attempt += 1) {
			try {
				const successorObservation = await this.observe(action.tab_id);
				await delay(0);
				const successorTargets = await this.pageTargetIds();
				const lateBoundary = browserControlChange(
					current,
					successorObservation,
					this.generations,
					currentTargets,
					successorTargets,
					currentDialogCount,
					this.dialogNotes.length,
				);
				current = successorObservation;
				currentTargets = successorTargets;
				currentDialogCount = this.dialogNotes.length;
				if (lateBoundary) {
					if (!stopReason || stopReason === "control_flow") stopReason = lateBoundary;
					stoppedAt ??= action.steps.length;
					successorError = new ObservationChangedError();
					continue;
				}
				const baselineComplete = this.presentObservation(baseline, completeObservationAction);
				const currentComplete = this.presentObservation(current, completeObservationAction);
				const currentPresentation = this.presentObservation(current, observationAction);
				successor = {
					status: "observed",
					text: this.renderObservation(currentPresentation),
					url: current.url,
					title: current.title,
					diff: diffObservations(baselineComplete, currentComplete),
				};
				this.lastSnapshots.set(current.targetId, currentPresentation);
			} catch (err) {
				successorError = err;
			}
		}
		if (!successor) {
			successor = { status: "unavailable", error: errorMessage(successorError ?? new ObservationChangedError()) };
			stopReason ??= "control_flow";
			stoppedAt ??= action.steps.length;
		}

		const completed = steps.length === action.steps.length && (!stopReason || terminalNavigation);
		const definitiveFailure = steps.some((step) => step.outcome === "didnt") || finalExpectation?.status === "failed";
		const semanticallyVerified = action.expect
			? finalExpectation?.status === "newly_verified"
			: steps.length > 0 && steps.every((step) => step.outcome === "worked");
		const outcome = definitiveFailure ? "didnt" : completed && semanticallyVerified ? "worked" : "unknown";
		return {
			outcome,
			steps,
			...(stoppedAt !== undefined ? { stopped_at: stoppedAt } : {}),
			...(stopReason ? { stop_reason: stopReason } : {}),
			...(finalExpectation ? { final_expectation: finalExpectation } : {}),
			successor,
		};
	}

	private async executeActStep(step: CuaBrowserActStep, tabId?: string): Promise<void> {
		switch (step.type) {
			case "click":
				return this.click({
					type: "browser_click",
					tab_id: tabId,
					ref: step.ref,
					button: step.button,
					num_clicks: step.num_clicks,
					modifiers: step.modifiers,
				});
			case "hover":
				return this.hover({ type: "browser_hover", tab_id: tabId, ref: step.ref });
			case "fill":
				return this.fill({ type: "browser_fill", tab_id: tabId, ref: step.ref, value: step.value });
			case "type": {
				const session = await this.session(tabId);
				await this.cdp.send("Input.insertText", { text: step.text }, session);
				return;
			}
			case "key":
				return this.key({ type: "browser_key", tab_id: tabId, text: step.text, repeat: step.repeat });
			case "scroll_to":
				return this.scrollTo({ type: "browser_scroll_to", tab_id: tabId, ref: step.ref });
			case "wait":
				await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(0, step.ms ?? 1000), 30_000)));
		}
	}

	private evaluateExpectation(
		expectation: CuaBrowserExpectation,
		observation: BrowserObservation,
		baseline: BrowserObservation,
	): ExpectationEvaluation {
		if ("all" in expectation) {
			const children = expectation.all.map((child) => this.evaluateExpectation(child, observation, baseline));
			const truth = children.some((child) => child.truth === false)
				? false
				: children.some((child) => child.truth === undefined)
					? undefined
					: true;
			return { truth, details: children.flatMap((child) => child.details) };
		}
		if ("any" in expectation) {
			const children = expectation.any.map((child) => this.evaluateExpectation(child, observation, baseline));
			const truth = children.some((child) => child.truth === true)
				? true
				: children.some((child) => child.truth === undefined)
					? undefined
					: false;
			return { truth, details: children.flatMap((child) => child.details) };
		}
		if (expectation.type === "text") {
			const found = observation.nodes.some(
				({ node }) => !node.ignored && (node.name?.value ?? "").toLowerCase().includes(expectation.text.toLowerCase()),
			);
			const truth = !found && !observation.complete ? undefined : found === (expectation.exists ?? true);
			const completeness = observation.complete ? "" : "; observation incomplete";
			return { truth, details: [`text ${JSON.stringify(expectation.text)} ${found ? "present" : "absent"}${completeness}`] };
		}
		if (expectation.type === "role_name") {
			const found = observation.nodes.some(
				({ node }) =>
					!node.ignored &&
					(expectation.role === undefined || (node.role?.value ?? "") === expectation.role) &&
					(expectation.name === undefined || (node.name?.value ?? "") === expectation.name),
			);
			const truth = !found && !observation.complete ? undefined : found === (expectation.exists ?? true);
			const completeness = observation.complete ? "" : "; observation incomplete";
			return { truth, details: [`role/name ${found ? "present" : "absent"}${completeness}`] };
		}
		if (expectation.type === "url" || expectation.type === "title") {
			const value = observation[expectation.type];
			const initial = baseline[expectation.type];
			const checks = [
				expectation.equals === undefined || value === expectation.equals,
				expectation.contains === undefined || value.includes(expectation.contains),
				expectation.changed === undefined || (value !== initial) === expectation.changed,
			];
			return { truth: checks.every(Boolean), details: [`${expectation.type}=${JSON.stringify(value)}`] };
		}
		if (expectation.type !== "ref") return { truth: undefined, details: ["unsupported expectation"] };

		const entry = this.refs.get(expectation.ref);
		if (!entry || entry.targetId !== observation.targetId || entry.generation !== this.generation(entry.frameId)) {
			return { truth: undefined, details: [`ref ${expectation.ref} is stale`] };
		}
		const frameNodes = observation.nodes.filter(({ ctx }) => ctx.frameKey === entry.frameId).map(({ node }) => node);
		let observed = frameNodes.find((node) => node.backendDOMNodeId === entry.backendNodeId);
		if (!observed) {
			try {
				observed = this.healEntry(expectation.ref, entry, frameNodes);
			} catch {
				return { truth: undefined, details: [`ref ${expectation.ref} was not observable`] };
			}
		}
		const checks: boolean[] = [];
		if (expectation.value !== undefined) checks.push(String(observed.value?.value ?? "") === expectation.value);
		for (const state of ["checked", "selected", "expanded"] as const) {
			const expected = expectation[state];
			if (expected === undefined) continue;
			const actual = observed.properties?.find((property) => property.name === state)?.value?.value;
			checks.push(normalizeState(actual) === expected);
		}
		return {
			truth: checks.length > 0 ? checks.every(Boolean) : undefined,
			details: [`ref ${expectation.ref} value/state ${checks.every(Boolean) ? "matched" : "did not match"}`],
		};
	}

	private renderNode(
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

	/** Fetch a frame's AX tree: OOPIFs through their own session, same-process frames through the page session with a frameId. */
	private async frameAxTree(frameKey: string, targetId: string, pageSession: string): Promise<{ nodes: AXNode[]; sessionId: string }> {
		const frameSession = this.frameSessions.get(frameKey);
		if (frameSession) {
			const { nodes } = await this.cdp.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", {}, frameSession);
			return { nodes, sessionId: frameSession };
		}
		const params = frameKey === targetId ? {} : { frameId: frameKey };
		const { nodes } = await this.cdp.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", params, pageSession);
		return { nodes, sessionId: pageSession };
	}

	/** Resolve iframe nodes recursively and fetch each child frame's AX tree for stitching. */
	private async stitchFrames(nodes: AXNode[], targetId: string, pageSession: string): Promise<FrameStitchResult> {
		const stitches = new Map<string, FrameStitch>();
		const visitedFrames = new Set<string>([targetId]);
		let complete = true;
		const visit = async (
			frameNodes: AXNode[],
			parentFrameKey: string,
			parentSession: string,
			parentSessionTargetId: string,
		): Promise<void> => {
			for (const node of frameNodes) {
				if (node.ignored || !FRAME_ROLES.has(node.role?.value ?? "") || node.backendDOMNodeId === undefined) continue;
				try {
					const { node: dom } = await this.cdp.send<{ node: { frameId?: string; contentDocument?: { frameId?: string } } }>(
						"DOM.describeNode",
						{ backendNodeId: node.backendDOMNodeId, depth: 1 },
						parentSession,
					);
					const frameId = dom.contentDocument?.frameId ?? dom.frameId;
					if (!frameId) {
						complete = false;
						continue;
					}
					if (frameId === targetId) continue;
					if (visitedFrames.has(frameId)) {
						complete = false;
						continue;
					}
					visitedFrames.add(frameId);
					this.frameParents.set(frameId, parentFrameKey);
					const generation = this.trackGeneration(frameId);
					const { nodes: childNodes, sessionId } = await this.frameAxTree(frameId, targetId, parentSession);
					if (generation !== this.generation(frameId)) throw new ObservationChangedError();
					const sessionTargetId = this.frameSessions.has(frameId) ? frameId : parentSessionTargetId;
					const stitch: FrameStitch = {
						byId: new Map(childNodes.map((child) => [child.nodeId, child])),
						roots: childNodes.filter((child) => !child.parentId).map((child) => child.nodeId),
						ctx: {
							targetId,
							frameKey: frameId,
							sessionTargetId,
							sessionId,
							generation,
							nthIndex: buildNthIndex(childNodes),
						},
					};
					stitches.set(frameStitchKey(parentFrameKey, node.backendDOMNodeId), stitch);
					await visit(childNodes, frameId, sessionId, sessionTargetId);
				} catch (err) {
					if (err instanceof ObservationChangedError) throw err;
					complete = false;
				}
			}
		};
		await visit(nodes, targetId, pageSession, targetId);
		return { frames: stitches, complete };
	}

	/** Resolve backend node ids for elements whose own computed cursor is "pointer", without touching the DOM. */
	private async cursorPointerIds(session: string): Promise<ReadonlySet<number>> {
		const ids = new Set<number>();
		const { result } = await this.cdp.send<{ result: { objectId?: string } }>(
			"Runtime.evaluate",
			{ expression: CURSOR_POINTER_SCAN, returnByValue: false, objectGroup: CURSOR_SCAN_GROUP },
			session,
		);
		if (!result.objectId) return ids;
		try {
			const { result: properties } = await this.cdp.send<{ result: Array<{ name: string; value?: { objectId?: string } }> }>(
				"Runtime.getProperties",
				{ objectId: result.objectId, ownProperties: true },
				session,
			);
			const objectIds = properties
				.filter((property) => /^\d+$/.test(property.name) && property.value?.objectId)
				.map((property) => property.value!.objectId!);
			const described = await Promise.all(
				objectIds.map((objectId) => this.cdp.send<{ node: { backendNodeId?: number } }>("DOM.describeNode", { objectId }, session)),
			);
			for (const { node } of described) {
				if (node.backendNodeId !== undefined) ids.add(node.backendNodeId);
			}
		} finally {
			await this.cdp.send("Runtime.releaseObjectGroup", { objectGroup: CURSOR_SCAN_GROUP }, session).catch(() => {});
		}
		return ids;
	}

	private async find(action: CuaActionBrowserFind): Promise<string> {
		const candidates = await this.findCandidates(action.query, action.tab_id);
		if (candidates.length === 0) return `No elements matched ${JSON.stringify(action.query)}. Try snapshot for the full tree.`;
		return candidates
			.map(({ ref, role, name }) => `${role || "node"}${name ? ` ${JSON.stringify(name)}` : ""} [${ref}]`)
			.join("\n");
	}

	/**
	 * Score elements against a natural-language query and mint refs for the
	 * matches, best first. Structured counterpart of the `browser_find` action.
	 */
	async findCandidates(query: string, tabId?: string, roles?: ReadonlySet<string>): Promise<BrowserFindCandidate[]> {
		const observation = await this.observe(tabId);
		const queryTokens = tokenize(query);
		const scored = observation.nodes
			.filter(
				({ node }) => !node.ignored && node.backendDOMNodeId !== undefined && (node.name?.value || INTERACTIVE_ROLES.has(node.role?.value ?? "")),
			)
			.map(({ node, ctx }) => ({ node, ctx, score: overlapScore(queryTokens, tokenize(`${node.role?.value ?? ""} ${node.name?.value ?? ""}`)) }))
			.filter((entry) => entry.score > 0 && (!roles || roles.has(entry.node.role?.value ?? "")))
			.sort((a, b) => b.score - a.score)
			.slice(0, FIND_MATCH_LIMIT);
		const candidates = scored.map(({ node, ctx, score }) => ({
			ref: this.mintRef(node, ctx),
			role: node.role?.value ?? "",
			name: node.name?.value ?? "",
			score,
		}));
		this.pruneRefs(observation.targetId);
		return candidates;
	}

	private async click(action: CuaActionBrowserClick): Promise<void> {
		const targetId = await this.resolveTarget(action.tab_id);
		const session = await this.attach(targetId);
		const point = await this.resolvePoint(action, targetId, session);
		const modifiers = modifierBits(action.modifiers);
		const button = action.button ?? "left";
		const clicks = action.num_clicks ?? 1;
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, modifiers }, point.session);
		// Native multi-clicks are separate press/release cycles with an
		// incrementing clickCount; a single pair with the final count is not how
		// real input arrives and can register as one click.
		for (let clickCount = 1; clickCount <= clicks; clickCount++) {
			await this.cdp.send(
				"Input.dispatchMouseEvent",
				{ type: "mousePressed", x: point.x, y: point.y, button, clickCount, modifiers },
				point.session,
			);
			await this.cdp.send(
				"Input.dispatchMouseEvent",
				{ type: "mouseReleased", x: point.x, y: point.y, button, clickCount, modifiers },
				point.session,
			);
		}
	}

	private async hover(action: CuaActionBrowserHover): Promise<void> {
		const targetId = await this.resolveTarget(action.tab_id);
		const session = await this.attach(targetId);
		const point = await this.resolvePoint(action, targetId, session);
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, point.session);
	}

	private async drag(action: CuaActionBrowserDrag): Promise<void> {
		const session = await this.session(tabOf(action));
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: action.from.x, y: action.from.y, button: "left", clickCount: 1 }, session);
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: action.to.x, y: action.to.y, button: "left" }, session);
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: action.to.x, y: action.to.y, button: "left", clickCount: 1 }, session);
	}

	private async fill(action: CuaActionBrowserFill): Promise<void> {
		const targetId = await this.resolveTarget(action.tab_id);
		const entry = this.resolveRef(action.ref, targetId);
		const session = await this.refSession(entry);
		const objectId = await this.resolveObject(entry, action.ref, session);
		const { exceptionDetails } = await this.cdp.send<{ exceptionDetails?: { exception?: { description?: string } } }>(
			"Runtime.callFunctionOn",
			{
				objectId,
				functionDeclaration: FILL_FUNCTION,
				arguments: [{ value: action.value }],
			},
			session,
		);
		if (exceptionDetails) {
			const description = exceptionDetails.exception?.description ?? "element rejected the value";
			const message = description.split("\n", 1)[0]?.replace(/^[A-Za-z]*(?:Error|Exception): /, "") || "element rejected the value";
			throw new Error(`browser_fill failed: ${message}`);
		}
	}

	private async scrollTo(action: CuaActionBrowserScrollTo): Promise<void> {
		const targetId = await this.resolveTarget(action.tab_id);
		const entry = this.resolveRef(action.ref, targetId);
		await this.scrollIntoView(entry, action.ref, await this.refSession(entry));
	}

	private async scroll(action: CuaActionBrowserScroll): Promise<void> {
		const session = await this.session(tabOf(action));
		const notches = action.amount ?? 3;
		const delta = Math.trunc(notches) * SCROLL_NOTCH_PX;
		const deltaX = action.direction === "left" ? -delta : action.direction === "right" ? delta : 0;
		const deltaY = action.direction === "up" ? -delta : action.direction === "down" ? delta : 0;
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: action.x, y: action.y, deltaX, deltaY }, session);
	}

	private async key(action: CuaActionBrowserKey): Promise<void> {
		const session = await this.session(tabOf(action));
		const repeat = Math.min(Math.max(1, Math.trunc(action.repeat ?? 1)), 100);
		const chords = action.text.trim().split(/\s+/).filter(Boolean);
		for (let iteration = 0; iteration < repeat; iteration += 1) {
			for (const chord of chords) {
				await this.dispatchChord(chord, session);
			}
		}
	}

	private async dispatchChord(chord: string, session: string): Promise<void> {
		const parts = chord.split("+").filter(Boolean);
		const keyPart = parts[parts.length - 1] ?? "";
		const modifierParts = parts.slice(0, -1);
		const modifiers = modifierBits(modifierParts);
		const key = resolveKey(keyPart);
		const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers };
		await this.cdp.send("Input.dispatchKeyEvent", { type: key.text ? "keyDown" : "rawKeyDown", ...base, ...(key.text ? { text: key.text } : {}) }, session);
		await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, session);
	}

	private async navigate(action: CuaActionBrowserNavigate): Promise<string> {
		const targetId = await this.resolveTarget(action.tab_id);
		const session = await this.attach(targetId);
		const direction = action.url.trim().toLowerCase();
		if (direction === "back" || direction === "forward") {
			const history = await this.cdp.send<{ currentIndex: number; entries: Array<{ id: number; url: string }> }>(
				"Page.getNavigationHistory",
				{},
				session,
			);
			const entry = history.entries[history.currentIndex + (direction === "back" ? -1 : 1)];
			if (!entry) throw new Error(`cannot go ${direction}: no history entry`);
			await this.selfNavigate(targetId, () => this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, session));
			this.invalidateRefs(targetId);
			return `Navigated ${direction}.\n${await this.tabContext(targetId)}`;
		}
		const url = normalizeGotoUrl(action.url);
		if (!url) throw new Error("invalid url");
		const { errorText } = await this.selfNavigate(targetId, () =>
			this.cdp.send<{ errorText?: string }>("Page.navigate", { url }, session),
		);
		if (errorText) {
			this.selfNavigations.delete(targetId);
			throw new Error(`navigation to ${url} failed: ${errorText}`);
		}
		this.invalidateRefs(targetId);
		return `Navigated to ${url}.\n${await this.tabContext(targetId)}`;
	}

	/**
	 * Run a navigation command with the self-navigation flag armed. The flag
	 * must be set before the command (frameNavigated can arrive first), and
	 * must not survive a rejected command — it would swallow the next real
	 * navigation's invalidation.
	 */
	private async selfNavigate<T>(targetId: string, command: () => Promise<T>): Promise<T> {
		this.selfNavigations.add(targetId);
		try {
			return await command();
		} catch (err) {
			this.selfNavigations.delete(targetId);
			throw err;
		}
	}

	/** URL of the active tab. */
	async currentUrl(): Promise<string> {
		const targetId = await this.resolveTarget();
		const targets = await this.cdp.pageTargets();
		return targets.find((target) => target.targetId === targetId)?.url ?? "";
	}

	private async listTabs(): Promise<string> {
		const targets = await this.cdp.pageTargets();
		if (targets.length === 0) return "No open tabs.";
		return targets.map((target) => `tab_id ${shortTabId(target.targetId)}: ${JSON.stringify(target.title)} (${target.url})`).join("\n");
	}

	private async newTab(): Promise<string> {
		const targetId = await this.cdp.createTarget("about:blank");
		this.activeTargetId = targetId;
		return `Opened tab_id ${shortTabId(targetId)}.\n${await this.tabContext(targetId)}`;
	}

	private async evaluate(code: string, tabId?: string): Promise<string> {
		const session = await this.session(tabId);
		const { result, exceptionDetails } = await this.cdp.send<{
			result: { value?: unknown; description?: string; type?: string };
			exceptionDetails?: { exception?: { description?: string } };
		}>("Runtime.evaluate", { expression: code, returnByValue: true, awaitPromise: true }, session);
		if (exceptionDetails) throw new Error(`browser_evaluate failed: ${exceptionDetails.exception?.description ?? "evaluation threw"}`);
		if (result.value === undefined) return result.description ?? String(result.type ?? "undefined");
		return typeof result.value === "string" ? result.value : JSON.stringify(result.value);
	}

	private async pageText(tabId?: string): Promise<string> {
		return this.evaluate("document.body ? document.body.innerText : ''", tabId);
	}

	private async tabContext(executedOn: string): Promise<string> {
		const targets = await this.cdp.pageTargets();
		const lines = targets.map((target) => `  • tab_id ${shortTabId(target.targetId)}: ${JSON.stringify(target.title)} (${target.url})`);
		return [`Tab Context:`, `- Executed on tab_id: ${shortTabId(executedOn)}`, `- Available tabs:`, ...lines].join("\n");
	}

	private async resolvePoint(
		action: CuaActionBrowserClick | CuaActionBrowserHover,
		targetId: string,
		session: string,
	): Promise<{ x: number; y: number; session: string }> {
		if (action.ref !== undefined) {
			const entry = this.resolveRef(action.ref, targetId);
			const refSession = await this.refSession(entry);
			await this.scrollIntoView(entry, action.ref, refSession);
			const { model } = await this.cdp.send<{ model: { content: number[] } }>(
				"DOM.getBoxModel",
				{ backendNodeId: entry.backendNodeId },
				refSession,
			);
			const quad = model.content;
			// Box-model quads are main-viewport coordinates even through an OOPIF's
			// session, so input always dispatches on the page target's session.
			return { x: (quad[0]! + quad[4]!) / 2, y: (quad[1]! + quad[5]!) / 2, session };
		}
		if (typeof action.x === "number" && typeof action.y === "number") return { x: action.x, y: action.y, session };
		throw new Error("page target required: pass a ref or viewport coordinates");
	}

	private async scrollIntoView(entry: RefEntry, ref: string, session: string): Promise<void> {
		try {
			await this.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: entry.backendNodeId }, session);
		} catch (err) {
			await this.healRef(ref, entry, err);
			await this.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: entry.backendNodeId }, session);
		}
	}

	private async resolveObject(entry: RefEntry, ref: string, session: string): Promise<string> {
		try {
			const { object } = await this.cdp.send<{ object: { objectId: string } }>(
				"DOM.resolveNode",
				{ backendNodeId: entry.backendNodeId },
				session,
			);
			return object.objectId;
		} catch (err) {
			await this.healRef(ref, entry, err);
			const { object } = await this.cdp.send<{ object: { objectId: string } }>(
				"DOM.resolveNode",
				{ backendNodeId: entry.backendNodeId },
				session,
			);
			return object.objectId;
		}
	}

	private async healRef(ref: string, entry: RefEntry, cause: unknown): Promise<void> {
		const { nodes } = await this.frameAxTree(entry.frameId, entry.targetId, await this.refSession(entry));
		this.healEntry(ref, entry, nodes, cause);
	}

	/**
	 * Re-resolve a stale entry by its (role, name, nth) triple against a fresh
	 * AX tree. Heals only when the fresh role+name cohort has the same size as
	 * at mint time, so the nth position still identifies the same element.
	 */
	private healEntry(ref: string, entry: RefEntry, nodes: AXNode[], cause?: unknown): AXNode {
		const candidates = nodes.filter(
			(node) =>
				!node.ignored &&
				node.backendDOMNodeId !== undefined &&
				(node.role?.value ?? "") === entry.role &&
				(node.name?.value ?? "") === entry.name,
		);
		const match =
			(entry.role || entry.name) && candidates.length === entry.cohort && entry.nth < candidates.length
				? candidates[entry.nth]
				: undefined;
		if (!match) throw staleRefError(ref, cause);
		entry.backendNodeId = match.backendDOMNodeId!;
		return match;
	}

	private mintRef(node: AXNode, ctx: RenderContext): string {
		const role = node.role?.value ?? "";
		const name = node.name?.value ?? "";
		this.refCounter += 1;
		const ref = `e${this.refCounter}`;
		this.refs.set(ref, {
			backendNodeId: node.backendDOMNodeId!,
			targetId: ctx.targetId,
			frameId: ctx.frameKey,
			sessionTargetId: ctx.sessionTargetId,
			sessionId: ctx.sessionId,
			generation: ctx.generation,
			role,
			name,
			nth: ctx.nthIndex.index.get(node.nodeId) ?? 0,
			cohort: ctx.nthIndex.cohorts.get(cohortKey(role, name)) ?? 1,
		});
		return ref;
	}

	/**
	 * Session for a ref's DOM/Input calls. Imported refs (see
	 * {@link importRefState}) carry no live session and rebind here: the
	 * frame's own session for OOPIFs when auto-attach has surfaced it, the
	 * page session otherwise.
	 */
	private async refSession(entry: RefEntry): Promise<string> {
		if (!entry.sessionId) {
			const pageSession = await this.attach(entry.targetId);
			if (entry.sessionTargetId === undefined) {
				entry.sessionId = this.frameSessions.get(entry.frameId) ?? pageSession;
				return entry.sessionId;
			}
			const frameSession = this.frameSessions.get(entry.sessionTargetId);
			if (entry.sessionTargetId !== entry.targetId && !frameSession) {
				throw new Error("owning frame session is unavailable; the element ref is stale");
			}
			entry.sessionId = frameSession ?? pageSession;
		}
		return entry.sessionId;
	}

	private resolveRef(ref: string, targetId: string): RefEntry {
		const entry = this.refs.get(ref);
		// Entries are deleted eagerly on invalidation; the generation check only
		// guards refs resolved while a navigation event is still in flight.
		if (!entry || entry.targetId !== targetId || entry.generation !== this.generation(entry.frameId)) {
			throw staleRefError(ref);
		}
		return entry;
	}

	private generation(targetId: string): number {
		return this.generations.get(targetId) ?? 0;
	}

	private trackGeneration(targetId: string): number {
		const generation = this.generation(targetId);
		if (!this.generations.has(targetId)) this.generations.set(targetId, generation);
		return generation;
	}

	private invalidateRefs(targetId: string): void {
		this.invalidateFrame(targetId);
		for (const [ref, entry] of this.refs) {
			if (entry.targetId === targetId) this.refs.delete(ref);
		}
	}

	private pruneFrameState(targetId: string, observed: ReadonlySet<string>): void {
		const stale = new Set<string>();
		for (const frameId of this.frameParents.keys()) {
			if (observed.has(frameId)) continue;
			const visited = new Set<string>([frameId]);
			let parent = this.frameParents.get(frameId);
			while (parent && !visited.has(parent)) {
				if (parent === targetId) {
					stale.add(frameId);
					break;
				}
				visited.add(parent);
				parent = this.frameParents.get(parent);
			}
		}
		for (const frameId of stale) {
			this.frameParents.delete(frameId);
			this.frameSessions.delete(frameId);
			this.generations.delete(frameId);
		}
		for (const [ref, entry] of this.refs) {
			if (stale.has(entry.frameId) || (entry.sessionTargetId !== undefined && stale.has(entry.sessionTargetId))) {
				this.refs.delete(ref);
			}
		}
	}

	private invalidateFrame(frameKey: string): void {
		let tracked = this.generations.has(frameKey) || this.frameParents.has(frameKey) || this.frameSessions.has(frameKey);
		if (!tracked) {
			for (const entry of this.refs.values()) {
				if (entry.frameId === frameKey || entry.sessionTargetId === frameKey) {
					tracked = true;
					break;
				}
			}
		}
		if (!tracked) return;
		const invalidated = new Set<string>([frameKey]);
		let found = true;
		while (found) {
			found = false;
			for (const [child, parent] of this.frameParents) {
				if (invalidated.has(parent) && !invalidated.has(child)) {
					invalidated.add(child);
					found = true;
				}
			}
		}
		for (const invalidatedFrame of invalidated) {
			if (invalidatedFrame === frameKey) this.generations.set(invalidatedFrame, this.generation(invalidatedFrame) + 1);
			else {
				this.generations.delete(invalidatedFrame);
				this.frameParents.delete(invalidatedFrame);
			}
		}
		for (const [ref, entry] of this.refs) {
			if (invalidated.has(entry.frameId)) this.refs.delete(ref);
		}
	}

	private invalidateSessionTarget(targetId: string): void {
		const ownedFrames = new Set<string>();
		for (const entry of this.refs.values()) {
			if (entry.sessionTargetId === targetId) ownedFrames.add(entry.frameId);
		}
		this.invalidateFrame(targetId);
		for (const frameKey of ownedFrames) this.invalidateFrame(frameKey);
	}

	private dropTarget(targetId: string): void {
		this.invalidateFrame(targetId);
		this.selfNavigations.delete(targetId);
		this.lastSnapshots.delete(targetId);
		this.frameSessions.delete(targetId);
		this.frameTargets.delete(targetId);
		this.frameParents.delete(targetId);
		const invalidatedFrames = new Set<string>();
		for (const [ref, entry] of this.refs) {
			if (entry.targetId === targetId || entry.frameId === targetId || entry.sessionTargetId === targetId) {
				if (entry.frameId !== targetId) invalidatedFrames.add(entry.frameId);
				this.refs.delete(ref);
			}
		}
		for (const frameId of invalidatedFrames) this.generations.delete(frameId);
		this.generations.delete(targetId);
	}

	/** SPAs can mint refs indefinitely without ever navigating; bound per-target growth by evicting the oldest. */
	private pruneRefs(targetId: string): void {
		const owned: string[] = [];
		for (const [ref, entry] of this.refs) {
			if (entry.targetId === targetId) owned.push(ref);
		}
		for (const ref of owned.slice(0, Math.max(0, owned.length - REF_LIMIT_PER_TARGET))) this.refs.delete(ref);
	}

	private drainDialogNotes(): string | undefined {
		if (this.dialogNotes.length === 0) return undefined;
		const text = this.dialogNotes.join("\n");
		this.dialogNotes.length = 0;
		return text;
	}

	private async session(tabId?: string): Promise<string> {
		return this.attach(await this.resolveTarget(tabId));
	}

	private async attach(targetId: string): Promise<string> {
		const session = await this.cdp.attachToTarget(targetId);
		if (!this.targetsBySession.has(session)) {
			this.targetsBySession.set(session, targetId);
			await this.cdp.send("Page.enable", {}, session);
			await this.cdp.send("Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: false }, session);
		}
		return session;
	}

	private async pageTargetIds(): Promise<string[]> {
		return (await this.cdp.pageTargets()).map((target) => target.targetId).sort();
	}

	private async resolveTarget(tabId?: string): Promise<string> {
		const targets = await this.cdp.pageTargets();
		if (targets.length === 0) throw new Error("no open browser tabs");
		if (tabId) {
			const match = targets.find((target) => shortTabId(target.targetId) === tabId || target.targetId === tabId);
			if (!match) throw new Error(`unknown tab_id "${tabId}". Call list_tabs for current tabs.`);
			this.activeTargetId = match.targetId;
			return match.targetId;
		}
		if (this.activeTargetId && targets.some((target) => target.targetId === this.activeTargetId)) {
			return this.activeTargetId;
		}
		this.activeTargetId = targets[0]!.targetId;
		return this.activeTargetId;
	}
}

class ObservationChangedError extends Error {
	constructor() {
		super("page changed while collecting the browser observation");
	}
}

interface ExpectationEvaluation {
	truth?: boolean;
	details: string[];
}

function expectationEvidence(before: ExpectationEvaluation, after: ExpectationEvaluation): BrowserExpectationEvidence {
	const details = [...before.details.map((detail) => `before: ${detail}`), ...after.details.map((detail) => `after: ${detail}`)];
	if (before.truth === undefined || after.truth === undefined) {
		return { status: "unverifiable", before: before.truth, after: after.truth, details };
	}
	if (before.truth && after.truth) return { status: "preexisting", before: true, after: true, details };
	if (!before.truth && after.truth) return { status: "newly_verified", before: false, after: true, details };
	return { status: "failed", before: before.truth, after: after.truth, details };
}

function normalizeState(value: unknown): boolean | "mixed" | undefined {
	if (value === true || value === "true") return true;
	if (value === false || value === "false") return false;
	if (value === "mixed") return "mixed";
	return undefined;
}

function observationGenerationsChanged(
	before: BrowserObservation,
	after: BrowserObservation,
	live: ReadonlyMap<string, number>,
): boolean {
	for (const [key, generation] of after.generations) {
		if (generation !== (live.get(key) ?? 0)) return true;
		const previous = before.generations.get(key);
		if (previous !== undefined && previous !== generation) return true;
	}
	return false;
}

function browserControlChange(
	before: BrowserObservation,
	after: BrowserObservation,
	liveGenerations: ReadonlyMap<string, number>,
	beforeTargets: readonly string[],
	afterTargets: readonly string[],
	beforeDialogCount: number,
	afterDialogCount: number,
): BrowserActResult["stop_reason"] {
	if (afterDialogCount > beforeDialogCount) return "dialog";
	if (observationGenerationsChanged(before, after, liveGenerations)) return "navigation";
	if (targetsChanged(beforeTargets, afterTargets)) return "control_flow";
	return undefined;
}

function targetsChanged(before: readonly string[], after: readonly string[]): boolean {
	return before.length !== after.length || before.some((targetId, index) => targetId !== after[index]);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function diffObservations(before: BrowserPresentation, after: BrowserPresentation): BrowserObservationDiff {
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

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function tabOf(action: { tab_id?: string }): string | undefined {
	return action.tab_id;
}

function staleRefError(ref: string, cause?: unknown): Error {
	return new Error(`ref ${ref} is stale or not on the current page. ${STALE_REF_HINT}`, cause === undefined ? undefined : { cause });
}

/** Index each ref-eligible node by its position among nodes with the same role and name, in tree order. */
function buildNthIndex(nodes: AXNode[]): NthIndex {
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

function cohortKey(role: string, name: string): string {
	return `${role}\u0000${name}`;
}

function frameStitchKey(parentFrameKey: string, backendNodeId: number): string {
	return `${parentFrameKey}\u0000${backendNodeId}`;
}

/** Merge a run of two or more consecutive StaticText siblings (text split by inline markup) into one node. */
function staticTextRun(tree: Map<string, AXNode>, childIds: string[], start: number): { node: AXNode; end: number } | undefined {
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

function shortTabId(targetId: string): string {
	return targetId.slice(0, 10).toUpperCase();
}

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 1);
}

function overlapScore(query: string[], candidate: string[]): number {
	if (query.length === 0 || candidate.length === 0) return 0;
	const set = new Set(candidate);
	return query.reduce((score, token) => score + (set.has(token) ? 1 : 0), 0);
}

function modifierBits(modifiers: readonly string[] | undefined): number {
	let bits = 0;
	for (const modifier of modifiers ?? []) {
		switch (modifier.trim().toLowerCase()) {
			case "alt":
			case "option":
				bits |= 1;
				break;
			case "ctrl":
			case "control":
				bits |= 2;
				break;
			case "meta":
			case "cmd":
			case "command":
			case "super":
				bits |= 4;
				break;
			case "shift":
				bits |= 8;
				break;
		}
	}
	return bits;
}

interface ResolvedKey {
	key: string;
	code: string;
	keyCode: number;
	text?: string;
}

const NAMED_KEYS: Record<string, ResolvedKey> = {
	enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
	return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
	tab: { key: "Tab", code: "Tab", keyCode: 9 },
	escape: { key: "Escape", code: "Escape", keyCode: 27 },
	esc: { key: "Escape", code: "Escape", keyCode: 27 },
	backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
	delete: { key: "Delete", code: "Delete", keyCode: 46 },
	space: { key: " ", code: "Space", keyCode: 32, text: " " },
	up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
	down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
	left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
	right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
	arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
	arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
	arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
	arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
	home: { key: "Home", code: "Home", keyCode: 36 },
	end: { key: "End", code: "End", keyCode: 35 },
	pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
	page_up: { key: "PageUp", code: "PageUp", keyCode: 33 },
	pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
	page_down: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

function resolveKey(value: string): ResolvedKey {
	const named = NAMED_KEYS[value.toLowerCase()];
	if (named) return named;
	if (value.length === 1) {
		const upper = value.toUpperCase();
		const code = /[a-z]/i.test(value) ? `Key${upper}` : /[0-9]/.test(value) ? `Digit${value}` : "";
		return { key: value, code, keyCode: upper.charCodeAt(0), text: value };
	}
	return { key: value, code: value, keyCode: 0 };
}

const FILL_FUNCTION = `function(value) {
	const el = this;
	const tag = el.tagName ? el.tagName.toLowerCase() : "";
	if (tag === "select") {
		const str = String(value);
		const options = Array.from(el.options);
		const match = options.find((o) => o.value === str) ?? options.find((o) => (o.label || o.textContent || "").trim() === str);
		if (!match) throw new Error("no option matches " + JSON.stringify(str));
		el.value = match.value;
	} else if (el.type === "checkbox" || el.type === "radio") {
		el.checked = Boolean(value);
	} else if (tag === "input" || tag === "textarea") {
		const proto = Object.getPrototypeOf(el);
		const setter = Object.getOwnPropertyDescriptor(proto, "value");
		if (setter && setter.set) setter.set.call(el, String(value));
		else el.value = String(value);
	} else if (el.isContentEditable) {
		el.textContent = String(value);
	} else {
		throw new Error("element is not a form control");
	}
	el.focus();
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
}`;

const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
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

const SKIPPED_ROLES: ReadonlySet<string> = new Set(["none", "generic", "InlineTextBox", "LineBreak", "StaticText"]);

const FRAME_ROLES: ReadonlySet<string> = new Set(["Iframe", "IframePresentational"]);

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

const CURSOR_SCAN_GROUP = "cua-cursor-scan";

const CURSOR_POINTER_SCAN = `(() => {
	const matches = [];
	if (!document.body) return matches;
	for (const el of document.body.querySelectorAll("*")) {
		if (matches.length >= 100) break;
		if (el.closest("a, button, input, select, textarea, summary")) continue;
		if (getComputedStyle(el).cursor !== "pointer") continue;
		const parent = el.parentElement;
		if (parent && getComputedStyle(parent).cursor === "pointer") continue;
		const rect = el.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) continue;
		matches.push(el);
	}
	return matches;
})()`;


