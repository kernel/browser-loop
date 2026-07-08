import {
	normalizeGotoUrl,
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
import type { BatchReadResult } from "./types";

const SNAPSHOT_CHAR_LIMIT = 50_000;
const DEFAULT_SNAPSHOT_DEPTH = 15;
const FIND_MATCH_LIMIT = 20;
const REF_LIMIT_PER_TARGET = 1000;
const SCROLL_NOTCH_PX = 120;

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
	sessionId: string;
	generation: number;
	interactiveOnly: boolean;
	nthIndex: NthIndex;
	cursorIds?: ReadonlySet<number>;
}

interface RenderedLine {
	text: string;
	refNode?: AXNode;
	ctx: RenderContext;
}

interface FrameStitch {
	byId: Map<string, AXNode>;
	roots: string[];
	ctx: RenderContext;
}

export interface BrowserExecutorOptions {
	/** Mark elements whose computed cursor is "pointer" as clickable hints in snapshots. Default false. */
	cursorHints?: boolean;
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
	private readonly lastSnapshots = new Map<string, { key: string; shape: string }>();
	private readonly selfNavigations = new Set<string>();
	private readonly dialogNotes: string[] = [];
	private refCounter = 0;
	private activeTargetId?: string;
	private readonly cursorHints: boolean;

	private readonly cdp: CdpConnection;

	constructor(cdp: string | CdpConnection, options: BrowserExecutorOptions = {}) {
		this.cursorHints = options.cursorHints ?? false;
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
					// Refs from a frame target's tree (its root and any same-process
					// subframes inlined in it) are all minted against the target's key,
					// so any navigation observed in its session stales them.
					this.invalidateFrame(targetId);
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
		const targetId = await this.resolveTarget(action.tab_id);
		const pageSession = await this.attach(targetId);
		const refEntry = action.ref ? this.resolveRef(action.ref, targetId) : undefined;
		const frameKey = refEntry?.frameId ?? targetId;
		const { nodes, sessionId } = await this.frameAxTree(frameKey, targetId, pageSession);
		const byId = new Map(nodes.map((node) => [node.nodeId, node]));
		let rootIds = nodes.filter((node) => !node.parentId).map((node) => node.nodeId);
		if (action.ref && refEntry) {
			const rootNode =
				nodes.find((node) => node.backendDOMNodeId === refEntry.backendNodeId) ?? this.healEntry(action.ref, refEntry, nodes);
			rootIds = [rootNode.nodeId];
		}

		const interactiveOnly = action.filter === "interactive";
		const ctx: RenderContext = {
			targetId,
			frameKey,
			sessionId,
			generation: this.generation(frameKey),
			interactiveOnly,
			nthIndex: buildNthIndex(nodes),
			cursorIds: this.cursorHints && frameKey === targetId ? await this.cursorPointerIds(pageSession) : undefined,
		};
		const stitches = frameKey === targetId ? await this.stitchFrames(nodes, targetId, pageSession, interactiveOnly) : new Map<number, FrameStitch>();
		const lines: RenderedLine[] = [];
		const maxDepth = action.depth ?? DEFAULT_SNAPSHOT_DEPTH;
		const walk = (tree: Map<string, AXNode>, treeCtx: RenderContext, nodeId: string, depth: number, parentName: string): void => {
			const node = tree.get(nodeId);
			if (!node) return;
			let childDepth = depth;
			if (!node.ignored) {
				const rendered = this.renderNode(node, depth, parentName, treeCtx);
				if (rendered) {
					lines.push({ ...rendered, ctx: treeCtx });
					childDepth = depth + 1;
				}
			}
			if (childDepth > maxDepth) return;
			const stitch = treeCtx === ctx && node.backendDOMNodeId !== undefined ? stitches.get(node.backendDOMNodeId) : undefined;
			if (stitch) {
				for (const frameRootId of stitch.roots) walk(stitch.byId, stitch.ctx, frameRootId, childDepth, "");
				return;
			}
			const name = node.name?.value ?? "";
			const childName = name || parentName;
			const childIds = node.childIds ?? [];
			for (let i = 0; i < childIds.length; i += 1) {
				const run = staticTextRun(tree, childIds, i);
				if (run) {
					const rendered = this.renderNode(run.node, childDepth, childName, treeCtx);
					if (rendered) lines.push({ ...rendered, ctx: treeCtx });
					i = run.end;
					continue;
				}
				walk(tree, treeCtx, childIds[i]!, childDepth, childName);
			}
		};
		for (const rootId of rootIds) walk(byId, ctx, rootId, 0, "");

		const shape = lines.map((line) => line.text).join("\n");
		const frameGenerations = [...stitches.values()].map((stitch) => `${stitch.ctx.frameKey}:${stitch.ctx.generation}`);
		const key = [action.ref ?? "", action.depth ?? "", action.filter ?? "", `${frameKey}:${ctx.generation}`, ...frameGenerations].join("|");
		const cached = this.lastSnapshots.get(targetId);
		this.lastSnapshots.set(targetId, { key, shape });
		if (cached && cached.key === key && cached.shape === shape) return UNCHANGED_SNAPSHOT;

		let text = "";
		for (const line of lines) {
			if (text.length > SNAPSHOT_CHAR_LIMIT) break;
			const rendered = line.refNode ? line.text.replace(REF_PLACEHOLDER, this.mintRef(line.refNode, line.ctx)) : line.text;
			text = text ? `${text}\n${rendered}` : rendered;
		}
		if (text.length > SNAPSHOT_CHAR_LIMIT) {
			text = `${text.slice(0, SNAPSHOT_CHAR_LIMIT)}\n… truncated at ${SNAPSHOT_CHAR_LIMIT} characters. Re-request with a smaller depth, filter: "interactive", or a ref to narrow the subtree.`;
		}
		this.pruneRefs(targetId);
		return text || "(empty accessibility tree)";
	}

	private renderNode(node: AXNode, depth: number, parentName: string, ctx: RenderContext): { text: string; refNode?: AXNode } | undefined {
		const role = node.role?.value ?? "";
		const name = node.name?.value ?? "";
		const interactive = INTERACTIVE_ROLES.has(role);
		const pointer = node.backendDOMNodeId !== undefined && (ctx.cursorIds?.has(node.backendDOMNodeId) ?? false);
		if (ctx.interactiveOnly && !interactive && !pointer) return undefined;
		if (role === "StaticText" && name === parentName) return undefined;
		if (!ctx.interactiveOnly && !name && !interactive && !pointer && SKIPPED_ROLES.has(role)) return undefined;
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

	/** Resolve each iframe node's child frame and fetch its AX tree for stitching. One nesting level only. */
	private async stitchFrames(
		nodes: AXNode[],
		targetId: string,
		pageSession: string,
		interactiveOnly: boolean,
	): Promise<Map<number, FrameStitch>> {
		const stitches = new Map<number, FrameStitch>();
		for (const node of nodes) {
			if (node.ignored || !FRAME_ROLES.has(node.role?.value ?? "") || node.backendDOMNodeId === undefined) continue;
			try {
				const { node: dom } = await this.cdp.send<{ node: { frameId?: string; contentDocument?: { frameId?: string } } }>(
					"DOM.describeNode",
					{ backendNodeId: node.backendDOMNodeId, depth: 1 },
					pageSession,
				);
				const frameId = dom.contentDocument?.frameId ?? dom.frameId;
				if (!frameId || frameId === targetId) continue;
				const { nodes: frameNodes, sessionId } = await this.frameAxTree(frameId, targetId, pageSession);
				stitches.set(node.backendDOMNodeId, {
					byId: new Map(frameNodes.map((frameNode) => [frameNode.nodeId, frameNode])),
					roots: frameNodes.filter((frameNode) => !frameNode.parentId).map((frameNode) => frameNode.nodeId),
					ctx: {
						targetId,
						frameKey: frameId,
						sessionId,
						generation: this.generation(frameId),
						interactiveOnly,
						nthIndex: buildNthIndex(frameNodes),
					},
				});
			} catch {
				// Cross-origin or already-detached frames can refuse the fetch; the iframe renders without children.
			}
		}
		return stitches;
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
		const targetId = await this.resolveTarget(action.tab_id);
		const session = await this.attach(targetId);
		const { nodes } = await this.cdp.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", {}, session);
		const pools: Array<{ nodes: AXNode[]; ctx: RenderContext }> = [
			{
				nodes,
				ctx: {
					targetId,
					frameKey: targetId,
					sessionId: session,
					generation: this.generation(targetId),
					interactiveOnly: false,
					nthIndex: buildNthIndex(nodes),
				},
			},
		];
		// Search stitched frames too so find sees everything snapshot renders.
		for (const stitch of (await this.stitchFrames(nodes, targetId, session, false)).values()) {
			pools.push({ nodes: [...stitch.byId.values()], ctx: stitch.ctx });
		}
		const queryTokens = tokenize(action.query);
		const scored = pools
			.flatMap(({ nodes: poolNodes, ctx }) =>
				poolNodes
					.filter(
						(node) => !node.ignored && node.backendDOMNodeId !== undefined && (node.name?.value || INTERACTIVE_ROLES.has(node.role?.value ?? "")),
					)
					.map((node) => ({ node, ctx, score: overlapScore(queryTokens, tokenize(`${node.role?.value ?? ""} ${node.name?.value ?? ""}`)) })),
			)
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, FIND_MATCH_LIMIT);
		if (scored.length === 0) return `No elements matched ${JSON.stringify(action.query)}. Try snapshot for the full tree.`;
		const text = scored
			.map(({ node, ctx }) => {
				const role = node.role?.value ?? "node";
				const name = node.name?.value ? ` ${JSON.stringify(node.name.value)}` : "";
				return `${role}${name} [${this.mintRef(node, ctx)}]`;
			})
			.join("\n");
		this.pruneRefs(targetId);
		return text;
	}

	private async click(action: CuaActionBrowserClick): Promise<void> {
		const targetId = await this.resolveTarget(action.tab_id);
		const session = await this.attach(targetId);
		const point = await this.resolvePoint(action, targetId, session);
		const modifiers = modifierBits(action.modifiers);
		const button = action.button ?? "left";
		const clickCount = action.num_clicks ?? 1;
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, modifiers }, point.session);
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
		const session = entry.sessionId;
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
			throw new Error(`browser_fill failed: ${exceptionDetails.exception?.description ?? "element rejected the value"}`);
		}
	}

	private async scrollTo(action: CuaActionBrowserScrollTo): Promise<void> {
		const targetId = await this.resolveTarget(action.tab_id);
		const entry = this.resolveRef(action.ref, targetId);
		await this.scrollIntoView(entry, action.ref, entry.sessionId);
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
			this.selfNavigations.add(targetId);
			await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, session);
			this.invalidateRefs(targetId);
			return `Navigated ${direction}.\n${await this.tabContext(targetId)}`;
		}
		const url = normalizeGotoUrl(action.url);
		if (!url) throw new Error("invalid url");
		this.selfNavigations.add(targetId);
		const { errorText } = await this.cdp.send<{ errorText?: string }>("Page.navigate", { url }, session);
		if (errorText) {
			this.selfNavigations.delete(targetId);
			throw new Error(`navigation to ${url} failed: ${errorText}`);
		}
		this.invalidateRefs(targetId);
		return `Navigated to ${url}.\n${await this.tabContext(targetId)}`;
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
			await this.scrollIntoView(entry, action.ref, entry.sessionId);
			const { model } = await this.cdp.send<{ model: { content: number[] } }>(
				"DOM.getBoxModel",
				{ backendNodeId: entry.backendNodeId },
				entry.sessionId,
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
		const { nodes } = await this.frameAxTree(entry.frameId, entry.targetId, entry.sessionId);
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
			sessionId: ctx.sessionId,
			generation: ctx.generation,
			role,
			name,
			nth: ctx.nthIndex.index.get(node.nodeId) ?? 0,
			cohort: ctx.nthIndex.cohorts.get(cohortKey(role, name)) ?? 1,
		});
		return ref;
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

	private invalidateRefs(targetId: string): void {
		this.generations.set(targetId, this.generation(targetId) + 1);
		for (const [ref, entry] of this.refs) {
			if (entry.targetId === targetId) this.refs.delete(ref);
		}
	}

	private invalidateFrame(frameKey: string): void {
		let tracked = this.generations.has(frameKey) || this.frameSessions.has(frameKey);
		for (const [ref, entry] of this.refs) {
			if (entry.frameId === frameKey) {
				this.refs.delete(ref);
				tracked = true;
			}
		}
		// Frames we never referenced don't get a generation entry, or pages with
		// rotating ad iframes would grow the map without bound.
		if (tracked) this.generations.set(frameKey, this.generation(frameKey) + 1);
	}

	private dropTarget(targetId: string): void {
		this.generations.delete(targetId);
		this.selfNavigations.delete(targetId);
		this.lastSnapshots.delete(targetId);
		this.frameSessions.delete(targetId);
		this.frameTargets.delete(targetId);
		for (const [ref, entry] of this.refs) {
			if (entry.targetId === targetId || entry.frameId === targetId) {
				if (entry.frameId !== targetId) this.generations.delete(entry.frameId);
				this.refs.delete(ref);
			}
		}
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


