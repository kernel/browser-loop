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
import { runBrowserAct, type ExpectationEvaluation } from "./browser-act";
import {
	buildNthIndex,
	cohortKey,
	frameStitchKey,
	MissingFrameObservationError,
	ObservationChangedError,
	REF_PLACEHOLDER,
	staticTextRun,
	type AXNode,
	type BrowserObservation,
	type BrowserPresentation,
	type FrameStitch,
	type FrameStitchResult,
	type ObservationLine,
	type ObservedNode,
	type RenderContext,
} from "./browser-observation";
import { CdpConnection, type CdpEventMessage } from "./cdp";
import type { BatchReadResult, BrowserActResult } from "./types";

const SNAPSHOT_CHAR_LIMIT = 50_000;
const DEFAULT_SNAPSHOT_DEPTH = 15;
const FIND_MATCH_LIMIT = 20;
const REF_LIMIT_PER_TARGET = 1000;
const FRAME_STATE_LIMIT = 1000;
const SCROLL_NOTCH_PX = 120;

const STALE_REF_HINT = "Call snapshot (or find) to get fresh element references.";
const UNCHANGED_SNAPSHOT = "Page unchanged since the last snapshot; previous element refs are still valid.";

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
	private readonly navigationEpochs = new Map<string, number>();
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
					if (frame.id && frame.id !== targetId) this.invalidateFrame(frame.id);
					else this.invalidateSessionTarget(targetId);
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
				if (!targetId || !frameId) return;
				if (frameId === targetId && this.selfNavigations.delete(targetId)) return;
				const root = this.rootFrame(frameId);
				this.navigationEpochs.set(root, this.navigationEpoch(root) + 1);
				return;
			}
			case "Page.frameDetached": {
				const { frameId } = event.params as { frameId?: string };
				if (frameId) this.invalidateFrame(frameId);
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
		const observation = await this.observe(action.tab_id);
		let presentation: BrowserPresentation;
		try {
			presentation = this.presentObservation(observation, action);
		} catch (err) {
			if (!(err instanceof MissingFrameObservationError) || !action.ref) throw err;
			presentation = await this.observeReferencedFrame({ ...action, ref: action.ref }, observation.targetId);
		}
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
		const navigationEpoch = this.navigationEpoch(targetId);
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
			navigationEpoch !== this.navigationEpoch(targetId) ||
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
		const observedFrames = new Set(generations.keys());
		if (complete) this.pruneFrameState(targetId, observedFrames);
		else this.boundFrameState(observedFrames);
		return {
			targetId,
			navigationEpoch,
			tree,
			stitches,
			nodes: observedNodes,
			url: targetAfter.url,
			title: targetAfter.title,
			generations,
			complete,
		};
	}

	private async observeReferencedFrame(action: CuaActionBrowserSnapshot & { ref: string }, targetId: string): Promise<BrowserPresentation> {
		let changed: ObservationChangedError | undefined;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				const entry = this.resolveRef(action.ref, targetId);
				const pageSession = await this.attach(targetId);
				const targetsBefore = await this.cdp.pageTargets();
				const targetBefore = targetsBefore.find((candidate) => candidate.targetId === targetId);
				if (!targetBefore) throw new ObservationChangedError();
				const targetGeneration = this.trackGeneration(targetId);
				const frameGeneration = this.trackGeneration(entry.frameId);
				const navigationEpoch = this.navigationEpoch(targetId);
				const { nodes, sessionId } = await this.frameAxTree(entry.frameId, targetId, pageSession);
				const sessionTargetId = entry.sessionTargetId ?? (this.frameSessions.has(entry.frameId) ? entry.frameId : targetId);
				const ctx: RenderContext = {
					targetId,
					frameKey: entry.frameId,
					sessionTargetId,
					sessionId,
					generation: frameGeneration,
					nthIndex: buildNthIndex(nodes),
				};
				const { frames: stitches, complete } = await this.stitchFrames(
					nodes,
					targetId,
					sessionId,
					entry.frameId,
					sessionTargetId,
				);
				const targetsAfter = await this.cdp.pageTargets();
				const targetAfter = targetsAfter.find((candidate) => candidate.targetId === targetId);
				const generations = new Map<string, number>([[targetId, targetGeneration], [entry.frameId, frameGeneration]]);
				for (const stitch of stitches.values()) generations.set(stitch.ctx.frameKey, stitch.ctx.generation);
				if (
					!targetAfter ||
					navigationEpoch !== this.navigationEpoch(targetId) ||
					targetBefore.url !== targetAfter.url ||
					targetBefore.title !== targetAfter.title ||
					[...generations].some(([frameKey, generation]) => this.generation(frameKey) !== generation)
				) {
					throw new ObservationChangedError();
				}
				const observedNodes: ObservedNode[] = nodes.map((node) => ({ node, ctx }));
				for (const stitch of stitches.values()) {
					for (const node of stitch.byId.values()) observedNodes.push({ node, ctx: stitch.ctx });
				}
				this.boundFrameState(new Set(generations.keys()));
				const observation: BrowserObservation = {
					targetId,
					navigationEpoch,
					tree: {
						byId: new Map(nodes.map((node) => [node.nodeId, node])),
						roots: nodes.filter((node) => !node.parentId).map((node) => node.nodeId),
						ctx,
					},
					stitches,
					nodes: observedNodes,
					url: targetAfter.url,
					title: targetAfter.title,
					generations,
					complete,
				};
				return this.presentObservation(observation, action);
			} catch (err) {
				if (!(err instanceof ObservationChangedError)) throw err;
				changed = err;
			}
		}
		throw changed ?? new ObservationChangedError();
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
			if (!frameTree) throw new MissingFrameObservationError();
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

	private act(action: CuaActionBrowserAct): Promise<BrowserActResult> {
		return runBrowserAct(action, {
			observe: (tabId) => this.observe(tabId),
			targetIds: () => this.pageTargetIds(),
			dialogCount: () => this.dialogNotes.length,
			generations: () => this.generations,
			executeStep: (step, tabId) => this.executeActStep(step, tabId),
			evaluateRefExpectation: (expectation, observation) => this.evaluateRefExpectation(expectation, observation),
			presentObservation: (observation, snapshot) => this.presentObservation(observation, snapshot),
			renderObservation: (presentation) => this.renderObservation(presentation),
			rememberPresentation: (presentation) => {
				this.lastSnapshots.set(presentation.observation.targetId, presentation);
			},
		});
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

	private evaluateRefExpectation(
		expectation: Extract<CuaBrowserExpectation, { type: "ref" }>,
		observation: BrowserObservation,
	): ExpectationEvaluation {
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
	private async stitchFrames(
		nodes: AXNode[],
		targetId: string,
		pageSession: string,
		rootFrameKey = targetId,
		rootSessionTargetId = targetId,
	): Promise<FrameStitchResult> {
		const stitches = new Map<string, FrameStitch>();
		const visitedFrames = new Set<string>([targetId, rootFrameKey]);
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
		await visit(nodes, rootFrameKey, pageSession, rootSessionTargetId);
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

	private navigationEpoch(targetId: string): number {
		return this.navigationEpochs.get(targetId) ?? 0;
	}

	private rootFrame(frameKey: string): string {
		const visited = new Set<string>();
		let root = frameKey;
		while (!visited.has(root)) {
			visited.add(root);
			const parent = this.frameParents.get(root);
			if (!parent) break;
			root = parent;
		}
		if (root === frameKey) {
			for (const entry of this.refs.values()) {
				if (entry.frameId === frameKey || entry.sessionTargetId === frameKey) return entry.targetId;
			}
		}
		return root;
	}

	private invalidateRefs(targetId: string): void {
		this.invalidateFrame(targetId);
		for (const [ref, entry] of this.refs) {
			if (entry.targetId === targetId) this.refs.delete(ref);
		}
	}

	private boundFrameState(observed: ReadonlySet<string>): void {
		const protectedFrames = new Set(observed);
		for (const frameId of this.frameSessions.keys()) protectedFrames.add(frameId);
		for (const entry of this.refs.values()) {
			protectedFrames.add(entry.frameId);
			if (entry.sessionTargetId) protectedFrames.add(entry.sessionTargetId);
		}
		let added = true;
		while (added) {
			added = false;
			for (const [child, parent] of this.frameParents) {
				if (protectedFrames.has(child) && !protectedFrames.has(parent)) {
					protectedFrames.add(parent);
					added = true;
				}
			}
		}
		for (const frameId of this.frameParents.keys()) {
			if (this.frameParents.size <= FRAME_STATE_LIMIT) break;
			if (!protectedFrames.has(frameId)) {
				this.frameParents.delete(frameId);
				this.generations.delete(frameId);
			}
		}
		for (const frameId of this.generations.keys()) {
			if (this.generations.size <= FRAME_STATE_LIMIT) break;
			if (!protectedFrames.has(frameId)) this.generations.delete(frameId);
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
		const targetId = this.rootFrame(frameKey);
		this.navigationEpochs.set(targetId, this.navigationEpoch(targetId) + 1);
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
			if (invalidated.has(entry.frameId) || (entry.sessionTargetId !== undefined && invalidated.has(entry.sessionTargetId))) {
				this.refs.delete(ref);
			}
		}
	}

	private invalidateSessionTarget(targetId: string): void {
		const ownedFrames = new Set<string>();
		for (const entry of this.refs.values()) {
			if (entry.sessionTargetId === targetId && entry.frameId !== targetId) ownedFrames.add(entry.frameId);
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
		this.navigationEpochs.delete(targetId);
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

function normalizeState(value: unknown): boolean | "mixed" | undefined {
	if (value === true || value === "true") return true;
	if (value === false || value === "false") return false;
	if (value === "mixed") return "mixed";
	return undefined;
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


