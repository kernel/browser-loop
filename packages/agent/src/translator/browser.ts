import {
	normalizeGotoUrl,
	type CuaActionBrowserAct,
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
	type CuaActionBrowserWaitFor,
	type CuaBrowserAction,
	type CuaBrowserActStep,
	type CuaBrowserExpectation,
} from "@onkernel/cua-ai";
import { CdpConnection, type CdpEventMessage } from "./cdp";
import {
	BrowserDocumentReconciler,
	oopifFrameOffset,
	type FrameTreeNode,
} from "./browser-document-reconciliation";
import { FrameCollectionError, frameCollectionError, isExpectedFrameCollectionError } from "./browser-frame-collection";
import {
	FRAME_ROLES,
	INTERACTIVE_ROLES,
	REF_PLACEHOLDER,
	IncompleteObservationError,
	ObservationChangedError,
	buildNthIndex,
	cohortKey,
	observedNodes,
	renderObservationNode,
	staticTextRun,
	type AXNode,
	type BrowserObservation,
	type BrowserPresentation,
	type FrameStitch,
	type IncompleteFrame,
	type ObservationLine,
	type RenderContext,
} from "./browser-observation";
import { runBrowserAct } from "./browser-act";
import {
	REF_STATE_VERSION,
	RefGenerationLifecycle,
	staleRefError,
	type BrowserRefState,
	type GenerationCapture,
	type RefEntry,
} from "./browser-ref-lifecycle";
import { evaluateBrowserExpectation, waitForBrowserExpectation, type BrowserExpectationEvaluation } from "./browser-wait";
import type { BatchReadResult, BrowserActResult, BrowserWaitForResult } from "./types";

const SNAPSHOT_CHAR_LIMIT = 50_000;
const DEFAULT_SNAPSHOT_DEPTH = 15;
const FIND_MATCH_LIMIT = 20;
const REF_LIMIT_PER_TARGET = 1000;
const SCROLL_NOTCH_PX = 120;
const NAVIGATION_STABILIZATION_TIMEOUT_MS = 10_000;

const UNCHANGED_SNAPSHOT = "Page unchanged since the last snapshot; previous element refs are still valid.";

interface NavigationEvidence {
	readonly type: "frameNavigated" | "sameDocument" | "lifecycle" | "stopped" | "detached";
	readonly frameId?: string;
	readonly loaderId?: string;
	readonly navigationType?: string;
	readonly name?: string;
	readonly errorText?: string;
}

interface PendingNavigation {
	readonly targetId: string;
	readonly sessionId: string;
	readonly evidence: NavigationEvidence[];
	onEvidence?: () => void;
}

interface CollectedObservation {
	readonly observation: BrowserObservation;
	readonly captures: readonly GenerationCapture[];
}

export interface BrowserFindCandidate {
	ref: string;
	role: string;
	name: string;
	score: number;
}

/**
 * Executes browser-plane canonical actions over CDP.
 *
 * Ownership boundary: this class owns connection-coupled mutable state and primitive
 * browser mechanics—CDP sessions/targets, ref resolution, document generations,
 * observation collection/rendering, and individual input operations. Multi-operation
 * policy belongs outside this class behind narrow runtime interfaces: semantic polling
 * lives in `browser-wait.ts`, and dependent plan control flow lives in `browser-act.ts`.
 * A future feature should be added here only when it must directly coordinate the live
 * CDP/ref state; orchestration expressible as observe/evaluate/execute primitives should
 * be a separate module adapted by this executor.
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
 * instead of the full tree. Clicking/hovering an out-of-process iframe ref
 * dispatches on the page session (where the Input domain lives) but shifts
 * the frame-local box-model quads by the iframe owner's offset first, so the
 * event lands on the intended element rather than the frame's origin.
 *
 * Refs persisted across invocations (see {@link exportRefState}) carry the
 * `loaderId` of every ref-owning frame — the page target for main-frame refs,
 * the child frame for same-process iframes and OOPIFs. On the next process the
 * imported set is reconciled per frame against the live browser before any ref
 * resolves: an unchanged frame keeps its refs, while a reload/navigation
 * between invocations stales only the frames whose document changed — including
 * an OOPIF-only navigation that left the main-frame loaderId untouched — since
 * generation alone is process-local and cannot detect a change that committed
 * after export. A ref-owning frame whose imported identity is missing or
 * unusable (legacy or partial state) is staled rather than trusted, so it can
 * never silently resolve against a different document with reused node ids.
 *
 * Native JavaScript dialogs are auto-handled so they never wedge the CDP
 * session: alert and beforeunload dialogs are accepted (so navigation can
 * proceed), confirm and prompt dialogs are dismissed. The dialog message
 * is surfaced as an extra read result on the next executed action.
 */
export class BrowserExecutor {
	private readonly refs = new Map<string, RefEntry>();
	private readonly lifecycle = new RefGenerationLifecycle(this.refs);
	private readonly targetsBySession = new Map<string, string>();
	private readonly frameSessions = new Map<string, string>();
	private readonly frameOwners = new Map<string, string>();
	private readonly frameTargets = new Set<string>();
	private readonly documents: BrowserDocumentReconciler;
	private readonly lastSnapshots = new Map<string, { key: string; shape: string }>();
	private readonly mainFramesByTarget = new Map<string, string>();
	private readonly navigationEpochs = new Map<string, number>();
	private readonly selfNavigations = new Set<string>();
	private readonly pendingNavigations = new Map<string, PendingNavigation>();
	private readonly dialogNotes: string[] = [];
	private refCounter = 0;
	private activeTargetId?: string;
	private readonly cdp: CdpConnection;

	constructor(cdp: string | CdpConnection) {
		this.cdp = typeof cdp === "string" ? new CdpConnection(cdp) : cdp;
		this.documents = new BrowserDocumentReconciler(this.cdp, this.lifecycle, this.frameSessions);
		this.cdp.onEvent((event) => this.handleCdpEvent(event));
	}

	private handleCdpEvent(event: CdpEventMessage): void {
		this.recordNavigationEvidence(event);
		switch (event.method) {
			case "Page.frameNavigated": {
				const frame = event.params.frame as { id?: string; parentId?: string; loaderId?: string } | undefined;
				if (!event.sessionId || !frame) return;
				const sessionTargetId = this.targetsBySession.get(event.sessionId);
				if (!sessionTargetId) return;
				if (this.frameTargets.has(sessionTargetId)) {
					// The OOPIF tree and any same-process descendants fetched through
					// its session share the OOPIF generation key.
					const owner = this.ownerForFrameTarget(sessionTargetId);
					if (owner) {
						this.lifecycle.invalidateFrame(owner, sessionTargetId);
						if (frame.loaderId) this.lifecycle.recordDocument(sessionTargetId, owner, frame.loaderId);
					}
					return;
				}
				if (frame.parentId) {
					if (frame.id) {
						this.lifecycle.invalidateFrame(sessionTargetId, frame.id);
						if (frame.loaderId) this.lifecycle.recordDocument(frame.id, sessionTargetId, frame.loaderId);
					}
					return;
				}
				if (frame.id) this.mainFramesByTarget.set(sessionTargetId, frame.id);
				if (!this.selfNavigations.delete(sessionTargetId)) this.lifecycle.invalidateTarget(sessionTargetId);
				// Record the committed document so it reflects the current generation,
				// whether the navigation was ours or page-initiated.
				if (frame.loaderId) this.lifecycle.recordDocument(sessionTargetId, sessionTargetId, frame.loaderId);
				return;
			}
			case "Page.frameDetached": {
				if (!event.sessionId) return;
				const { frameId } = event.params as { frameId?: string; reason?: "remove" | "swap" };
				const sessionTargetId = this.targetsBySession.get(event.sessionId);
				if (!frameId || !sessionTargetId) return;
				if (this.frameTargets.has(sessionTargetId)) {
					const owner = this.ownerForFrameTarget(sessionTargetId);
					if (owner) this.lifecycle.invalidateFrame(owner, sessionTargetId);
				} else {
					this.lifecycle.removeFrame(sessionTargetId, frameId);
				}
				return;
			}
			case "Page.navigatedWithinDocument": {
				// A navigate() that turns out same-document never fires frameNavigated;
				// consume the pending flag here so it can't swallow the next real navigation.
				if (!event.sessionId) return;
				const targetId = this.targetsBySession.get(event.sessionId);
				const { frameId } = event.params as { frameId?: string };
				const mainFrameId = targetId ? this.mainFramesByTarget.get(targetId) : undefined;
				if (targetId && frameId && frameId === (mainFrameId ?? targetId)) {
					this.selfNavigations.delete(targetId);
					this.navigationEpochs.set(targetId, (this.navigationEpochs.get(targetId) ?? 0) + 1);
				}
				return;
			}
			case "Target.attachedToTarget": {
				const { sessionId, targetInfo } = event.params as { sessionId?: string; targetInfo?: { targetId?: string; type?: string } };
				if (!sessionId || !targetInfo?.targetId || targetInfo.type !== "iframe") return;
				const parentTarget = event.sessionId ? this.targetsBySession.get(event.sessionId) : undefined;
				const owner = parentTarget ? (this.frameOwners.get(parentTarget) ?? parentTarget) : undefined;
				this.frameSessions.set(targetInfo.targetId, sessionId);
				if (owner) this.frameOwners.set(targetInfo.targetId, owner);
				this.frameTargets.add(targetInfo.targetId);
				this.targetsBySession.set(sessionId, targetInfo.targetId);
				this.documents.frameSessionAttached(targetInfo.targetId);
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
				if (!targetId) return;
				if (this.frameTargets.has(targetId)) {
					const owner = this.ownerForFrameTarget(targetId);
					if (owner) this.lifecycle.removeFrame(owner, targetId);
					this.frameSessions.delete(targetId);
					this.frameOwners.delete(targetId);
					this.frameTargets.delete(targetId);
				} else {
					this.dropTarget(targetId);
				}
				return;
			}
		}
	}

	private recordNavigationEvidence(event: CdpEventMessage): void {
		const detachedSession = event.method === "Target.detachedFromTarget" ? event.params.sessionId : undefined;
		const sessionId = typeof detachedSession === "string" ? detachedSession : event.sessionId;
		if (!sessionId) return;
		const pending = [...this.pendingNavigations.values()].find((navigation) => navigation.sessionId === sessionId);
		if (!pending) return;
		let evidence: NavigationEvidence | undefined;
		if (event.method === "Page.frameNavigated") {
			const { frame, type: navigationType } = event.params as {
				frame?: { id?: string; parentId?: string; loaderId?: string; unreachableUrl?: string };
				type?: string;
			};
			if (frame && !frame.parentId) {
				evidence = { type: "frameNavigated", frameId: frame.id, loaderId: frame.loaderId, navigationType, errorText: frame.unreachableUrl };
			}
		} else if (event.method === "Page.navigatedWithinDocument") {
			const { frameId } = event.params as { frameId?: string };
			evidence = { type: "sameDocument", frameId };
		} else if (event.method === "Page.lifecycleEvent") {
			const { frameId, loaderId, name } = event.params as { frameId?: string; loaderId?: string; name?: string };
			if (name === "load") evidence = { type: "lifecycle", frameId, loaderId, name };
		} else if (event.method === "Page.frameStoppedLoading") {
			const { frameId } = event.params as { frameId?: string };
			evidence = { type: "stopped", frameId };
		} else if (event.method === "Target.detachedFromTarget") {
			evidence = { type: "detached" };
		}
		if (!evidence) return;
		pending.evidence.push(evidence);
		if (pending.evidence.length > 32) pending.evidence.shift();
		pending.onEvidence?.();
	}

	private beginNavigation(targetId: string, sessionId: string): PendingNavigation {
		if (this.pendingNavigations.has(targetId)) throw new Error(`navigation already in progress for target ${targetId}`);
		const pending: PendingNavigation = { targetId, sessionId, evidence: [] };
		this.pendingNavigations.set(targetId, pending);
		return pending;
	}

	private cancelNavigation(pending: PendingNavigation): void {
		if (this.pendingNavigations.get(pending.targetId) === pending) this.pendingNavigations.delete(pending.targetId);
		pending.onEvidence = undefined;
	}

	private waitForNavigation(
		pending: PendingNavigation,
		expected: { frameId: string; loaderId?: string },
		signal?: AbortSignal,
	): Promise<void> {
		throwIfAborted(signal);
		return new Promise<void>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let settled = false;
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.cancelNavigation(pending);
			};
			const settle = (error?: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) reject(error);
				else resolve();
			};
			const check = () => {
				const outcome = navigationOutcome(pending.evidence, expected);
				if (outcome === "complete") settle();
				else if (outcome instanceof Error) settle(outcome);
			};
			const onAbort = () => settle(signal?.reason instanceof Error ? signal.reason : new Error("browser navigation aborted"));
			pending.onEvidence = check;
			timer = setTimeout(() => settle(new Error(
				`browser navigation timed out after ${NAVIGATION_STABILIZATION_TIMEOUT_MS}ms waiting for main-frame load on target ${pending.targetId}`,
			)), NAVIGATION_STABILIZATION_TIMEOUT_MS);
			signal?.addEventListener("abort", onAbort, { once: true });
			check();
		});
	}

	/** Close the CDP connection. Safe to call when never connected. */
	close(): void {
		this.cdp.close();
	}

	/** Snapshot the ref table for persistence across invocations; see {@link BrowserRefState}. */
	exportRefState(): BrowserRefState {
		const refFrames = new Set([...this.refs.values()].map((entry) => entry.frameId));
		const documents = this.lifecycle.exportDocuments(refFrames);
		return {
			refCounter: this.refCounter,
			...(this.activeTargetId ? { activeTargetId: this.activeTargetId } : {}),
			generations: this.lifecycle.exportGenerations(),
			...(documents.length ? { documents } : {}),
			refs: [...this.refs].map(([ref, { sessionId: _sessionId, ...entry }]) => [ref, entry]),
		};
	}

	/** Restore a ref table exported by a previous invocation against the same browser. */
	importRefState(state: BrowserRefState): void {
		if (state.version !== undefined && state.version > REF_STATE_VERSION) {
			// A newer identity scheme we can't verify against; reject loudly rather
			// than silently mis-parse it into trusted-looking refs.
			throw new Error(`unsupported browser ref state version ${state.version}; this build understands up to ${REF_STATE_VERSION}`);
		}
		this.refCounter = Math.max(this.refCounter, state.refCounter);
		this.activeTargetId = state.activeTargetId ?? this.activeTargetId;
		this.lifecycle.importState(state.generations, state.refs, state.activeTargetId, state.documents);
	}

	async execute(action: CuaBrowserAction, signal?: AbortSignal): Promise<BatchReadResult[]> {
		throwIfAborted(signal);
		const results = await this.dispatch(action, signal);
		const dialogs = this.drainDialogNotes();
		if (dialogs) results.push({ type: "browser_text", label: "dialog", text: dialogs });
		return results;
	}

	private async dispatch(action: CuaBrowserAction, signal?: AbortSignal): Promise<BatchReadResult[]> {
		switch (action.type) {
			case "browser_snapshot":
				return [{ type: "browser_text", label: "snapshot", text: await this.snapshot(action) }];
			case "browser_act":
				return [{ type: "browser_act", result: await this.act(action) }];
			case "browser_wait_for":
				return [{ type: "browser_wait_for", result: await this.waitFor(action) }];
			case "browser_text":
				return [{ type: "browser_text", label: "text", text: await this.pageText(tabOf(action)) }];
			case "browser_find":
				return [{ type: "browser_text", label: "find", text: await this.find(action) }];
			case "browser_click":
				await this.click(action, signal);
				return [];
			case "browser_hover":
				await this.hover(action, signal);
				return [];
			case "browser_drag":
				await this.drag(action);
				return [];
			case "browser_fill":
				await this.fill(action, signal);
				return [];
			case "browser_scroll_to":
				await this.scrollTo(action, signal);
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
				await this.key(action, signal);
				return [];
			case "browser_navigate":
				return [{ type: "browser_text", label: "navigate", text: await this.navigate(action, signal) }];
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
		return this.withObservation(action.tab_id, true, (observation) =>
			this.renderObservation(this.presentObservation(observation, action)),
		);
	}

	private observe(tabId?: string, includeCursor = false): Promise<BrowserObservation> {
		return this.withObservation(tabId, includeCursor, (observation) => observation);
	}

	private waitFor(action: CuaActionBrowserWaitFor): Promise<BrowserWaitForResult> {
		return this.waitForExpectation(action.expect, { timeoutMs: action.timeout_ms, pollMs: action.poll_ms, tabId: action.tab_id });
	}

	private waitForExpectation(expect: CuaBrowserExpectation, options: { timeoutMs?: number; pollMs?: number; tabId?: string; baseline?: BrowserObservation; targetId?: string }): Promise<BrowserWaitForResult> {
		return waitForBrowserExpectation({
			selectTarget: (tabId) => this.resolveTarget(tabId),
			observeTarget: (targetId) => this.observe(targetId, false),
			dialogCount: () => this.dialogNotes.length,
			targetExists: async (targetId) => (await this.cdp.pageTargets()).some((target) => target.targetId === targetId),
			resolveRef: (expectation, observation) => this.evaluateRefExpectation(expectation, observation),
		}, { expect, ...options });
	}

	private act(action: CuaActionBrowserAct): Promise<BrowserActResult> {
		return runBrowserAct(action, {
			observe: (tabId) => this.observe(tabId, false),
			targetIds: async () => (await this.cdp.pageTargets()).map((target) => target.targetId).sort(),
			dialogCount: () => this.dialogNotes.length,
			liveGeneration: (frameId) => this.lifecycle.currentGeneration(frameId),
			liveNavigationEpoch: (targetId) => this.navigationEpochs.get(targetId) ?? 0,
			executeStep: (step, tabId, signal) => this.executeActStep(step, tabId, signal),
			wait: (condition, baseline, targetId, tabId, timeoutMs, pollMs) => this.waitForExpectation(condition, { baseline, targetId, tabId, timeoutMs, pollMs }),
			evaluate: (condition, observation, baseline) => evaluateBrowserExpectation(condition, observation, baseline, (ref, state) => this.evaluateRefExpectation(ref, state)),
			present: (observation, snapshot) => this.presentObservation(observation, snapshot),
			render: (presentation) => this.renderObservation(presentation, false),
		});
	}

	private async executeActStep(step: CuaBrowserActStep, tabId: string | undefined, signal: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		switch (step.type) {
			case "click": return this.click({ type: "browser_click", ref: step.ref, button: step.button, num_clicks: step.num_clicks, modifiers: step.modifiers, tab_id: tabId }, signal);
			case "hover": return this.hover({ type: "browser_hover", ref: step.ref, tab_id: tabId }, signal);
			case "fill": return this.fill({ type: "browser_fill", ref: step.ref, value: step.value, tab_id: tabId }, signal);
			case "scroll_to": return this.scrollTo({ type: "browser_scroll_to", ref: step.ref, tab_id: tabId }, signal);
			case "key": return this.key({ type: "browser_key", text: step.text, repeat: step.repeat, tab_id: tabId }, signal);
			case "type": {
				const session = await this.session(tabId);
				throwIfAborted(signal);
				await this.cdp.send("Input.insertText", { text: step.text }, session);
				return;
			}
			case "wait": return abortableDelay(step.ms ?? 0, signal);
		}
	}

	private evaluateRefExpectation(
		expectation: Extract<CuaBrowserExpectation, { type: "ref" }>,
		observation: BrowserObservation,
	): BrowserExpectationEvaluation {
		const entry = this.refs.get(expectation.ref);
		if (!entry || entry.targetId !== observation.targetId || !this.lifecycle.isRefCurrent(entry)) {
			return { truth: undefined, details: [`ref ${expectation.ref} is stale`], reason: "stale_ref" };
		}
		const nodes = [...observedNodes(observation)]
			.filter(({ ctx }) => ctx.frameKey === entry.frameId)
			.map(({ node }) => node);
		let node = nodes.find((candidate) => candidate.backendDOMNodeId === entry.backendNodeId);
		if (!node) {
			try {
				node = this.healEntry(expectation.ref, entry, nodes);
			} catch {
				const incomplete = observation.incompleteFrames.length > 0;
				return {
					truth: undefined,
					details: [`ref ${expectation.ref} is not observable`],
					reason: incomplete ? "incomplete_observation" : "stale_ref",
				};
			}
		}
		const checks: boolean[] = [];
		let missing = false;
		if (expectation.value !== undefined) {
			if (node.value?.value === undefined) missing = true;
			else checks.push(String(node.value.value) === expectation.value);
		}
		for (const state of ["checked", "selected", "expanded"] as const) {
			if (expectation[state] === undefined) continue;
			const property = node.properties?.find((candidate) => candidate.name === state)?.value?.value;
			if (property === undefined) missing = true;
			else checks.push(normalizeState(property) === expectation[state]);
		}
		if (missing) {
			return {
				truth: undefined,
				details: [`ref ${expectation.ref} lacks requested value/state metadata`],
				reason: "incomplete_observation",
			};
		}
		const truth = checks.every(Boolean);
		return { truth, details: [`ref ${expectation.ref} value/state ${truth ? "matched" : "did not match"}`] };
	}

	private async withObservation<T>(
		tabId: string | undefined,
		includeCursor: boolean,
		consume: (observation: BrowserObservation) => T,
	): Promise<T> {
		for (let attempt = 0; ; attempt += 1) {
			let collected: CollectedObservation | undefined;
			try {
				collected = await this.collectObservation(tabId, includeCursor);
				return consume(collected.observation);
			} catch (error) {
				const retryable = error instanceof ObservationChangedError || error instanceof IncompleteObservationError;
				if (!retryable || attempt === 2) throw error;
			} finally {
				if (collected) this.lifecycle.release(collected.captures);
			}
		}
	}

	private async collectObservation(tabId: string | undefined, includeCursor: boolean): Promise<CollectedObservation> {
		const targetId = await this.resolveTarget(tabId);
		const pageSession = await this.attach(targetId);
		const pageTree = await this.documents.capturePage(targetId, pageSession);
		if (pageTree?.frame?.id) this.mainFramesByTarget.set(targetId, pageTree.frame.id);
		const before = (await this.cdp.pageTargets()).find((target) => target.targetId === targetId);
		if (!before) throw new ObservationChangedError("Browser target disappeared during observation");

		const captures: GenerationCapture[] = [this.lifecycle.captureTarget(targetId)];
		try {
			const rootCapture = captures[0]!;
			const { nodes, sessionId } = await this.frameAxTree(targetId, targetId, pageSession);
			const rootCtx: RenderContext = {
				targetId,
				frameKey: targetId,
				sessionId,
				generation: rootCapture.generation,
				nthIndex: buildNthIndex(nodes),
				...(includeCursor ? { cursorIds: await this.cursorPointerIds(pageSession) } : {}),
			};
			const tree = this.frameStitch(nodes, rootCtx);
			const { stitches, incompleteFrames } = await this.stitchFrames(nodes, targetId, pageSession, captures, pageTree);
			const after = (await this.cdp.pageTargets()).find((target) => target.targetId === targetId);
			if (!after || before.url !== after.url || before.title !== after.title) {
				throw new ObservationChangedError("Browser target metadata changed during observation");
			}
			if (captures.some((capture) => !this.lifecycle.isCurrent(capture))) throw new ObservationChangedError();
			return {
				observation: {
					targetId,
					navigationEpoch: this.navigationEpochs.get(targetId) ?? 0,
					url: before.url,
					title: before.title,
					tree,
					stitches,
					incompleteFrames,
					revision: rootCapture.observationRevision,
					generations: new Map(captures.map((capture) => [capture.frameKey, capture.generation])),
				},
				captures,
			};
		} catch (error) {
			this.lifecycle.release(captures);
			throw error;
		}
	}

	private presentObservation(observation: BrowserObservation, action: CuaActionBrowserSnapshot): BrowserPresentation {
		const refEntry = action.ref ? this.resolveRef(action.ref, observation.targetId) : undefined;
		let tree = observation.tree;
		let rootIds = tree.roots;
		if (action.ref && refEntry) {
			if (refEntry.frameId === observation.targetId) {
				tree = observation.tree;
			} else {
				const frameTree = [...observation.stitches.values()].find((stitch) => stitch.ctx.frameKey === refEntry.frameId);
				if (!frameTree) {
					const details = observation.incompleteFrames
						.map((frame) => `${frame.frameId ?? `backend node ${frame.backendNodeId}`} (${frame.reason})`)
						.join(", ");
					throw new IncompleteObservationError(
						`Could not verify ref ${action.ref}: owning frame ${refEntry.frameId} was not collected${details ? `; incomplete frames: ${details}` : ""}`,
					);
				}
				tree = frameTree;
			}
			const treeNodes = [...tree.byId.values()];
			const rootNode =
				treeNodes.find((node) => node.backendDOMNodeId === refEntry.backendNodeId) ?? this.healEntry(action.ref, refEntry, treeNodes);
			rootIds = [rootNode.nodeId];
		}
		const interactiveOnly = action.filter === "interactive";
		const lines: ObservationLine[] = [];
		const maxDepth = action.depth ?? DEFAULT_SNAPSHOT_DEPTH;
		const walk = (current: FrameStitch, nodeId: string, depth: number, parentName: string): void => {
			const node = current.byId.get(nodeId);
			if (!node) return;
			const ctx = current.ctx;
			let childDepth = depth;
			if (!node.ignored) {
				const rendered = renderObservationNode(node, depth, parentName, ctx, interactiveOnly);
				if (rendered) {
					lines.push({ ...rendered, ctx });
					childDepth = depth + 1;
				}
			}
			if (childDepth > maxDepth) return;
			const stitch = current === observation.tree && node.backendDOMNodeId !== undefined ? observation.stitches.get(node.backendDOMNodeId) : undefined;
			if (stitch) {
				for (const frameRootId of stitch.roots) walk(stitch, frameRootId, childDepth, "");
				return;
			}
			const childName = node.name?.value || parentName;
			const childIds = node.childIds ?? [];
			for (let i = 0; i < childIds.length; i += 1) {
				const run = staticTextRun(current.byId, childIds, i);
				if (run) {
					const rendered = renderObservationNode(run.node, childDepth, childName, ctx, interactiveOnly);
					if (rendered) lines.push({ ...rendered, ctx });
					i = run.end;
				} else walk(current, childIds[i]!, childDepth, childName);
			}
		};
		for (const rootId of rootIds) walk(tree, rootId, 0, "");
		const shape = lines.map((line) => line.text).join("\n");
		const generationKey = [...observation.generations].map(([frameKey, generation]) => `${frameKey}:${generation}`).join("|");
		return {
			observation,
			cacheKey: [action.ref ?? "", action.depth ?? "", action.filter ?? "", `revision:${observation.revision}`, generationKey].join("|"),
			lines,
			shape,
		};
	}

	private renderObservation(presentation: BrowserPresentation, comparePrevious = true): string {
		const { observation, cacheKey, lines, shape } = presentation;
		const cached = this.lastSnapshots.get(observation.targetId);
		this.lastSnapshots.set(observation.targetId, { key: cacheKey, shape });
		if (comparePrevious && cached?.key === cacheKey && cached.shape === shape) return UNCHANGED_SNAPSHOT;
		let text = "";
		for (const line of lines) {
			if (text.length > SNAPSHOT_CHAR_LIMIT) break;
			const rendered = line.refNode ? line.text.replace(REF_PLACEHOLDER, this.mintRef(line.refNode, line.ctx)) : line.text;
			text = text ? `${text}\n${rendered}` : rendered;
		}
		if (text.length > SNAPSHOT_CHAR_LIMIT) {
			text = `${text.slice(0, SNAPSHOT_CHAR_LIMIT)}\n… truncated at ${SNAPSHOT_CHAR_LIMIT} characters. Re-request with a smaller depth, filter: "interactive", or a ref to narrow the subtree.`;
		}
		this.pruneRefs(observation.targetId);
		return text || "(empty accessibility tree)";
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

	private frameStitch(nodes: AXNode[], ctx: RenderContext): FrameStitch {
		return {
			byId: new Map(nodes.map((node) => [node.nodeId, node])),
			roots: nodes.filter((node) => !node.parentId).map((node) => node.nodeId),
			ctx,
		};
	}

	/** Resolve each iframe node's child frame and fetch its AX tree for stitching. One nesting level only. */
	private async stitchFrames(
		nodes: readonly AXNode[],
		targetId: string,
		pageSession: string,
		captures: GenerationCapture[],
		pageTree: FrameTreeNode | undefined,
	): Promise<{ stitches: ReadonlyMap<number, FrameStitch>; incompleteFrames: readonly IncompleteFrame[] }> {
		const stitches = new Map<number, FrameStitch>();
		const incompleteFrames: IncompleteFrame[] = [];
		for (const node of nodes) {
			if (node.ignored || !FRAME_ROLES.has(node.role?.value ?? "") || node.backendDOMNodeId === undefined) continue;
			const backendNodeId = node.backendDOMNodeId;
			let dom: { frameId?: string; contentDocument?: { frameId?: string } };
			try {
				const described = await this.cdp.send<{ node?: typeof dom }>(
					"DOM.describeNode",
					{ backendNodeId, depth: 1 },
					pageSession,
				);
				if (!described.node) throw new Error("response did not include a node");
				dom = described.node;
			} catch (error) {
				if (!isExpectedFrameCollectionError(error, "DOM.describeNode")) {
					throw frameCollectionError(backendNodeId, undefined, "DOM.describeNode", error);
				}
				incompleteFrames.push({ backendNodeId, stage: "describe", reason: error.message });
				continue;
			}
			const frameId = dom.contentDocument?.frameId ?? dom.frameId;
			if (!frameId || frameId === targetId) {
				incompleteFrames.push({ backendNodeId, stage: "resolve", reason: "iframe did not expose a child frame id" });
				continue;
			}

			if (this.frameSessions.has(frameId)) this.frameOwners.set(frameId, targetId);
			let capture: GenerationCapture;
			try {
				capture = this.lifecycle.captureFrame(targetId, frameId);
			} catch (error) {
				throw frameCollectionError(backendNodeId, frameId, "capturing the frame generation", error);
			}
			let retained = false;
			try {
				const { nodes: frameNodes, sessionId } = await this.frameAxTree(frameId, targetId, pageSession);
				let stitch: FrameStitch;
				try {
					stitch = this.frameStitch(frameNodes, {
						targetId,
						frameKey: frameId,
						sessionId,
						generation: capture.generation,
						nthIndex: buildNthIndex(frameNodes),
					});
				} catch (error) {
					throw frameCollectionError(backendNodeId, frameId, "building the accessibility index", error);
				}
				stitches.set(backendNodeId, stitch);
				await this.documents.captureFrame(frameId, targetId, pageSession, pageTree);
				captures.push(capture);
				retained = true;
			} catch (error) {
				if (error instanceof FrameCollectionError) throw error;
				if (!isExpectedFrameCollectionError(error, "Accessibility.getFullAXTree")) {
					throw frameCollectionError(backendNodeId, frameId, "Accessibility.getFullAXTree", error);
				}
				incompleteFrames.push({ backendNodeId, frameId, stage: "accessibility", reason: error.message });
			} finally {
				if (!retained) this.lifecycle.release([capture]);
			}
		}
		return { stitches, incompleteFrames };
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
		return this.withObservation(tabId, false, (observation) => {
			const queryTokens = tokenize(query);
			const scored = [...observedNodes(observation)]
				.filter(
					({ node }) =>
						!node.ignored &&
						node.backendDOMNodeId !== undefined &&
						(node.name?.value || INTERACTIVE_ROLES.has(node.role?.value ?? "")),
				)
				.map(({ node, ctx }) => ({
					node,
					ctx,
					score: overlapScore(queryTokens, tokenize(`${node.role?.value ?? ""} ${node.name?.value ?? ""}`)),
				}))
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
		});
	}

	private async click(action: CuaActionBrowserClick, signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		const targetId = await this.resolveTarget(action.tab_id);
		throwIfAborted(signal);
		const session = await this.attach(targetId);
		throwIfAborted(signal);
		const point = await this.resolvePoint(action, targetId, session);
		throwIfAborted(signal);
		const modifiers = modifierBits(action.modifiers);
		const button = action.button ?? "left";
		const clicks = action.num_clicks ?? 1;
		if (!Number.isInteger(clicks) || clicks < 1 || clicks > 3) throw new Error("num_clicks must be an integer between 1 and 3");
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, modifiers }, point.session);
		// Native multi-clicks are separate press/release cycles with an
		// incrementing clickCount; a single pair with the final count is not how
		// real input arrives and can register as one click.
		for (let clickCount = 1; clickCount <= clicks; clickCount++) {
			throwIfAborted(signal);
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

	private async hover(action: CuaActionBrowserHover, signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		const targetId = await this.resolveTarget(action.tab_id);
		throwIfAborted(signal);
		const session = await this.attach(targetId);
		throwIfAborted(signal);
		const point = await this.resolvePoint(action, targetId, session);
		throwIfAborted(signal);
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, point.session);
	}

	private async drag(action: CuaActionBrowserDrag): Promise<void> {
		const session = await this.session(tabOf(action));
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: action.from.x, y: action.from.y, button: "left", clickCount: 1 }, session);
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: action.to.x, y: action.to.y, button: "left" }, session);
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: action.to.x, y: action.to.y, button: "left", clickCount: 1 }, session);
	}

	private async fill(action: CuaActionBrowserFill, signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		const targetId = await this.resolveTarget(action.tab_id);
		// Attach before resolving the ref (like click/hover) so any imported document
		// identity is reconciled first; otherwise a document that changed across the
		// process boundary would resolve against a reused backend node id.
		await this.attach(targetId);
		throwIfAborted(signal);
		const entry = this.resolveRef(action.ref, targetId);
		const session = await this.refSession(entry);
		throwIfAborted(signal);
		const objectId = await this.resolveObject(entry, action.ref, session);
		throwIfAborted(signal);
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

	private async scrollTo(action: CuaActionBrowserScrollTo, signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		const targetId = await this.resolveTarget(action.tab_id);
		// Reconcile the imported document before resolving the ref; see fill().
		await this.attach(targetId);
		throwIfAborted(signal);
		const entry = this.resolveRef(action.ref, targetId);
		const session = await this.refSession(entry);
		throwIfAborted(signal);
		await this.scrollIntoView(entry, action.ref, session);
	}

	private async scroll(action: CuaActionBrowserScroll): Promise<void> {
		const session = await this.session(tabOf(action));
		const notches = action.amount ?? 3;
		const delta = Math.trunc(notches) * SCROLL_NOTCH_PX;
		const deltaX = action.direction === "left" ? -delta : action.direction === "right" ? delta : 0;
		const deltaY = action.direction === "up" ? -delta : action.direction === "down" ? delta : 0;
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: action.x, y: action.y, deltaX, deltaY }, session);
	}

	private async key(action: CuaActionBrowserKey, signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		const session = await this.session(tabOf(action));
		const repeat = Math.min(Math.max(1, Math.trunc(action.repeat ?? 1)), 100);
		const chords = action.text.trim().split(/\s+/).filter(Boolean);
		for (let iteration = 0; iteration < repeat; iteration += 1) {
			for (const chord of chords) {
				throwIfAborted(signal);
				// Once keyDown starts, always pair it with keyUp before honoring cancellation.
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

	private async navigate(action: CuaActionBrowserNavigate, signal?: AbortSignal): Promise<string> {
		throwIfAborted(signal);
		const targetId = await this.resolveTarget(action.tab_id);
		const session = await this.attach(targetId);
		throwIfAborted(signal);
		const direction = action.url.trim().toLowerCase();
		if (direction === "back" || direction === "forward") {
			const history = await this.cdp.send<{ currentIndex: number; entries: Array<{ id: number; url: string }> }>(
				"Page.getNavigationHistory",
				{},
				session,
			);
			const entry = history.entries[history.currentIndex + (direction === "back" ? -1 : 1)];
			if (!entry) throw new Error(`cannot go ${direction}: no history entry`);
			const frameId = await this.mainFrameId(targetId, session);
			throwIfAborted(signal);
			const pending = this.beginNavigation(targetId, session);
			try {
				await this.selfNavigate(targetId, () => this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, session));
			} catch (error) {
				this.cancelNavigation(pending);
				throw error;
			}
			this.lifecycle.invalidateTarget(targetId);
			try {
				await this.waitForNavigation(pending, { frameId }, signal);
			} finally {
				this.selfNavigations.delete(targetId);
			}
			return `Navigated ${direction}.\n${await this.tabContext(targetId)}`;
		}
		const url = normalizeGotoUrl(action.url);
		if (!url) throw new Error("invalid url");
		const pending = this.beginNavigation(targetId, session);
		let response: { frameId?: string; loaderId?: string; errorText?: string; isDownload?: boolean };
		try {
			response = await this.selfNavigate(targetId, () =>
				this.cdp.send<typeof response>("Page.navigate", { url }, session),
			);
		} catch (error) {
			this.cancelNavigation(pending);
			throw error;
		}
		if (response.errorText) {
			this.cancelNavigation(pending);
			this.selfNavigations.delete(targetId);
			throw new Error(`navigation to ${url} failed: ${response.errorText}`);
		}
		this.lifecycle.invalidateTarget(targetId);
		if (response.isDownload) {
			this.cancelNavigation(pending);
			this.selfNavigations.delete(targetId);
		} else {
			const frameId = response.frameId ?? await this.mainFrameId(targetId, session);
			try {
				await this.waitForNavigation(pending, { frameId, loaderId: response.loaderId }, signal);
			} finally {
				this.selfNavigations.delete(targetId);
			}
		}
		return `Navigated to ${url}.\n${await this.tabContext(targetId)}`;
	}

	private async mainFrameId(targetId: string, session: string): Promise<string> {
		const known = this.mainFramesByTarget.get(targetId);
		if (known) return known;
		const { frameTree } = await this.cdp.send<{ frameTree?: { frame?: { id?: string } } }>("Page.getFrameTree", {}, session);
		const frameId = frameTree?.frame?.id;
		if (!frameId) throw new Error(`could not resolve the main frame for target ${targetId}`);
		this.mainFramesByTarget.set(targetId, frameId);
		return frameId;
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
			let x = (quad[0]! + quad[4]!) / 2;
			let y = (quad[1]! + quad[5]!) / 2;
			// Input.dispatchMouseEvent lives on the tab target and hit-tests in
			// top-level viewport coordinates, so it always dispatches on the page
			// session. A cross-process OOPIF lays out in its own renderer, so its
			// box-model quads are frame-local; shift them by the iframe owner's
			// content-box origin before dispatching. Same-process and main-frame
			// refs read through the page session and are already top-level.
			if (refSession !== session) {
				const offset = await oopifFrameOffset(this.cdp, entry.frameId, session);
				x += offset.x;
				y += offset.y;
			}
			return { x, y, session };
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
		this.lifecycle.retainRef(ref, {
			backendNodeId: node.backendDOMNodeId!,
			targetId: ctx.targetId,
			frameId: ctx.frameKey,
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
			entry.sessionId = this.frameSessions.get(entry.frameId) ?? (await this.attach(entry.targetId));
		}
		return entry.sessionId;
	}

	private resolveRef(ref: string, targetId: string): RefEntry {
		const entry = this.refs.get(ref);
		// Entries are deleted eagerly on invalidation; the generation check only
		// guards refs resolved while a navigation event is still in flight.
		if (!entry || entry.targetId !== targetId || !this.lifecycle.isRefCurrent(entry)) throw staleRefError(ref);
		return entry;
	}

	private ownerForFrameTarget(frameTargetId: string): string | undefined {
		const mapped = this.frameOwners.get(frameTargetId);
		if (mapped) return mapped;
		for (const entry of this.refs.values()) {
			if (entry.frameId !== frameTargetId) continue;
			this.frameOwners.set(frameTargetId, entry.targetId);
			return entry.targetId;
		}
		return undefined;
	}

	private dropTarget(targetId: string): void {
		const navigation = this.pendingNavigations.get(targetId);
		if (navigation) this.cancelNavigation(navigation);
		this.lifecycle.dropTarget(targetId);
		this.mainFramesByTarget.delete(targetId);
		this.navigationEpochs.delete(targetId);
		this.selfNavigations.delete(targetId);
		this.lastSnapshots.delete(targetId);
		for (const [frameId, owner] of this.frameOwners) {
			if (owner !== targetId) continue;
			const sessionId = this.frameSessions.get(frameId);
			if (sessionId) this.targetsBySession.delete(sessionId);
			this.frameSessions.delete(frameId);
			this.frameOwners.delete(frameId);
			this.frameTargets.delete(frameId);
		}
	}

	/** SPAs can mint refs indefinitely without ever navigating; bound per-target growth by evicting the oldest. */
	private pruneRefs(targetId: string): void {
		const owned: string[] = [];
		for (const [ref, entry] of this.refs) {
			if (entry.targetId === targetId) owned.push(ref);
		}
		for (const ref of owned.slice(0, Math.max(0, owned.length - REF_LIMIT_PER_TARGET))) this.lifecycle.deleteRef(ref);
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
			await this.cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }, session);
			// setAutoAttach must run before reconcile so an imported OOPIF's session
			// surfaces (via attachedToTarget) in time to read its own document.
			await this.cdp.send("Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: false }, session);
		}
		await this.documents.reconcile(targetId, session);
		return session;
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

function navigationOutcome(
	evidence: readonly NavigationEvidence[],
	expected: { frameId: string; loaderId?: string },
): "pending" | "complete" | Error {
	let committed = false;
	let activeLoaderId = expected.loaderId;
	for (const event of evidence) {
		if (event.type === "detached") return new Error("browser target detached during navigation");
		if (event.frameId !== expected.frameId) continue;
		if (event.type === "sameDocument") return "complete";
		if (event.type === "frameNavigated") {
			if (event.errorText) return new Error(`browser navigation failed after commit: ${event.errorText}`);
			if (event.navigationType === "BackForwardCacheRestore") return "complete";
			committed = true;
			if (event.loaderId) activeLoaderId = event.loaderId;
			continue;
		}
		if (event.type === "lifecycle") {
			if (activeLoaderId ? event.loaderId === activeLoaderId : committed) return "complete";
			continue;
		}
		if (event.type === "stopped" && committed) return "complete";
	}
	return "pending";
}

function tabOf(action: { tab_id?: string }): string | undefined {
	return action.tab_id;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error("browser action aborted");
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason instanceof Error ? signal.reason : new Error("browser action aborted"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function normalizeState(value: unknown): boolean | "mixed" {
	if (value === "mixed") return "mixed";
	return value === true || value === "true";
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


