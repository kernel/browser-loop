import type { CdpConnection } from "./cdp";
import type { RefGenerationLifecycle } from "./browser-ref-lifecycle";

/** How long to wait for a pending OOPIF session before treating the frame as gone. */
const FRAME_ATTACH_WAIT_MS = 500;
/** Backoff while an attached OOPIF's Page domain becomes ready. */
const FRAME_TREE_RETRY_MS = 20;

/** Minimal shape returned by CDP's `Page.getFrameTree`. */
export interface FrameTreeNode {
	frame?: { id?: string; loaderId?: string };
	childFrames?: FrameTreeNode[];
}

/**
 * Captures and reconciles durable loader identities for ref-owning documents.
 * Main and same-process frames are read from the page frame tree; OOPIFs are
 * read through their own auto-attached sessions.
 */
export class BrowserDocumentReconciler {
	private readonly frameSessionWaiters = new Map<string, Array<() => void>>();

	constructor(
		private readonly cdp: CdpConnection,
		private readonly lifecycle: RefGenerationLifecycle,
		private readonly frameSessions: ReadonlyMap<string, string>,
	) {}

	/** Wake document reconciliation when an OOPIF session auto-attaches. */
	frameSessionAttached(frameKey: string): void {
		const waiters = this.frameSessionWaiters.get(frameKey);
		if (waiters) for (const wake of [...waiters]) wake();
	}

	/** Read the page frame tree and record its main-frame document identity. */
	async capturePage(targetId: string, pageSession: string): Promise<FrameTreeNode | undefined> {
		const pageTree = await this.pageFrameTree(pageSession);
		const loaderId = pageTree?.frame?.loaderId;
		if (loaderId !== undefined) this.lifecycle.recordDocument(targetId, targetId, loaderId);
		return pageTree;
	}

	/** Record a child frame's identity at ref-mint time. */
	async captureFrame(
		frameId: string,
		targetId: string,
		pageSession: string,
		pageTree: FrameTreeNode | undefined,
	): Promise<void> {
		const frameSession = this.frameSessions.get(frameId);
		const loaderId = frameSession
			? (await this.pageFrameTree(frameSession))?.frame?.loaderId
			: frameLoaderIn(pageTree, frameId);
		if (loaderId !== undefined) this.lifecycle.recordDocument(frameId, targetId, loaderId);
	}

	/**
	 * Reconcile every imported ref-owning frame before any of its refs resolve.
	 * Changed or unverifiable children stale selectively; a changed main frame
	 * invalidates the target. Each pending expectation is consumed once.
	 */
	async reconcile(targetId: string, pageSession: string): Promise<void> {
		if (!this.lifecycle.hasPendingDocument(targetId)) return;
		const verifiable: string[] = [];
		for (const { frameKey, verifiable: ok } of this.lifecycle.pendingDocuments(targetId)) {
			if (ok) verifiable.push(frameKey);
			else this.lifecycle.reconcileDocument(frameKey, targetId, undefined);
		}
		if (verifiable.length === 0) return;

		const pageTree = await this.pageFrameTree(pageSession);
		const oopifCandidates: string[] = [];
		for (const frameKey of verifiable) {
			if (frameKey === targetId) {
				this.lifecycle.reconcileDocument(frameKey, targetId, pageTree?.frame?.loaderId);
				continue;
			}
			const attached = this.frameSessions.get(frameKey);
			if (attached) {
				this.lifecycle.reconcileDocument(frameKey, targetId, await this.frameSessionLoaderId(attached));
				continue;
			}
			const sameProcess = frameLoaderIn(pageTree, frameKey);
			if (sameProcess !== undefined) this.lifecycle.reconcileDocument(frameKey, targetId, sameProcess);
			else oopifCandidates.push(frameKey);
		}

		for (const frameKey of oopifCandidates) {
			const frameSession = await this.waitForFrameSession(frameKey);
			const loaderId = frameSession ? await this.frameSessionLoaderId(frameSession) : undefined;
			this.lifecycle.reconcileDocument(frameKey, targetId, loaderId);
		}
	}

	private async frameSessionLoaderId(session: string): Promise<string | undefined> {
		for (let attempt = 0; ; attempt += 1) {
			const loaderId = (await this.pageFrameTree(session))?.frame?.loaderId;
			if (loaderId !== undefined || attempt === 2) return loaderId;
			await delay(FRAME_TREE_RETRY_MS);
		}
	}

	private async pageFrameTree(session: string): Promise<FrameTreeNode | undefined> {
		try {
			const { frameTree } = await this.cdp.send<{ frameTree?: FrameTreeNode }>("Page.getFrameTree", {}, session);
			return frameTree;
		} catch {
			return undefined;
		}
	}

	private async waitForFrameSession(frameKey: string): Promise<string | undefined> {
		const existing = this.frameSessions.get(frameKey);
		if (existing) return existing;
		return new Promise<string | undefined>((resolve) => {
			const wake = (): void => {
				clearTimeout(timer);
				const waiters = this.frameSessionWaiters.get(frameKey);
				if (waiters) {
					const index = waiters.indexOf(wake);
					if (index >= 0) waiters.splice(index, 1);
					if (waiters.length === 0) this.frameSessionWaiters.delete(frameKey);
				}
				resolve(this.frameSessions.get(frameKey));
			};
			const timer = setTimeout(wake, FRAME_ATTACH_WAIT_MS);
			const waiters = this.frameSessionWaiters.get(frameKey) ?? [];
			waiters.push(wake);
			this.frameSessionWaiters.set(frameKey, waiters);
		});
	}
}

/** Translate an OOPIF-local point into the page viewport coordinate space. */
export async function oopifFrameOffset(
	cdp: CdpConnection,
	frameId: string,
	pageSession: string,
): Promise<{ x: number; y: number }> {
	const { backendNodeId } = await cdp.send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId }, pageSession);
	const { model } = await cdp.send<{ model: { content: number[] } }>(
		"DOM.getBoxModel",
		{ backendNodeId },
		pageSession,
	);
	return { x: model.content[0]!, y: model.content[1]! };
}

/** Find a same-process frame's loader identity in a page frame tree. */
function frameLoaderIn(tree: FrameTreeNode | undefined, frameId: string): string | undefined {
	if (!tree) return undefined;
	if (tree.frame?.id === frameId) return tree.frame.loaderId;
	for (const child of tree.childFrames ?? []) {
		const found = frameLoaderIn(child, frameId);
		if (found !== undefined) return found;
	}
	return undefined;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
