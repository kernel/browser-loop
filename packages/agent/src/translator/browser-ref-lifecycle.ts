import { ObservationChangedError } from "./browser-observation";

const STALE_REF_HINT = "Call snapshot (or find) to get fresh element references.";

export interface RefEntry {
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

interface TargetGenerationState {
	readonly targetId: string;
	generation: number;
	observationRevision: number;
	/**
	 * Durable identity of the main-frame document the current generation's refs
	 * were minted against: Chrome's main-frame `loaderId`, which changes on every
	 * cross-document load and is stable across same-document (pushState) ones.
	 * Unlike {@link generation} (process-local, reset by import) this survives a
	 * process restart, so a later invocation can tell whether the document a
	 * ref describes is still the one loaded in the browser.
	 */
	document?: string;
}

interface FrameGenerationState {
	readonly targetId: string;
	readonly frameId: string;
	generation: number;
	captures: number;
	refs: number;
	/**
	 * Durable identity of the document this frame's current generation refs were
	 * minted against: the frame's own `loaderId` (an OOPIF's from its session, a
	 * same-process child's from the page frame tree). The per-frame analogue of
	 * {@link TargetGenerationState.document}; it lets a later process detect that
	 * *this* frame's document changed even when the main-frame loaderId did not.
	 */
	document?: string;
}

/** Serialized ref state format understood by {@link RefGenerationLifecycle.importState}. */
export const REF_STATE_VERSION = 1;

export interface GenerationCapture {
	readonly targetId: string;
	readonly frameKey: string;
	readonly generation: number;
	readonly targetGeneration: number;
	readonly observationRevision: number;
	readonly targetState: TargetGenerationState;
	readonly frameState?: FrameGenerationState;
}

/**
 * Serializable ref state, so refs minted in one process (e.g. a `cua
 * snapshot` invocation) can be resolved in a later one against the same
 * browser. Session ids are process-local and deliberately not exported;
 * imported refs rebind lazily. Backend node ids stay valid for the life of
 * the document, and the usual generation/self-heal machinery covers pages
 * that changed in between.
 *
 * `documents` carries the `loaderId` of every ref-owning frame (keyed exactly
 * like a ref's {@link RefEntry.frameId}: the page target id for main-frame
 * refs, the child frame id for same-process iframes and OOPIFs) at mint time,
 * so the next process can reconcile each frame against the live browser: a
 * frame whose document changed (reload/navigation — including a click-induced
 * one that raced this process's exit, or an OOPIF-only navigation that left the
 * main-frame loaderId untouched) stales only that frame's imported refs instead
 * of silently resolving them against a different document whose backend node
 * ids may have been reused.
 *
 * It is optional only for structural back-compat. A ref-owning frame with no
 * usable identity here (legacy state predating this field, or a malformed/
 * partial entry) is treated as *unverifiable* and its refs are staled on first
 * attach — never resolved by process-local generation alone, which cannot
 * detect a cross-process document change and would risk a silent mis-target.
 */
export interface BrowserRefState {
	/** Absent or {@link REF_STATE_VERSION} for the current shape; a newer value is rejected on import. */
	version?: number;
	refCounter: number;
	activeTargetId?: string;
	generations: Array<[string, number]>;
	documents?: Array<[string, string]>;
	refs: Array<[string, Omit<RefEntry, "sessionId">]>;
}

/**
 * Owns generation identity and ref retention. Target documents and child
 * frames have distinct records even though CDP represents both ids as strings.
 * Frame records live only while an observation is collecting or a ref needs
 * them, so transient and rotating frames cannot grow retained state.
 */
export class RefGenerationLifecycle {
	private readonly targets = new Map<string, TargetGenerationState>();
	private readonly frames = new Map<string, FrameGenerationState>();
	/** Imported, verifiable per-frame loaderIds awaiting reconciliation against the live browser; see {@link reconcileDocument}. */
	private readonly expectedDocuments = new Map<string, string>();
	/** Owning target of every imported ref-owning frame still awaiting reconciliation (verifiable and unverifiable alike). */
	private readonly documentOwners = new Map<string, string>();
	/** Imported ref-owning frames whose document identity is missing/malformed; staled on first attach rather than resolved. */
	private readonly unverifiedDocuments = new Set<string>();

	constructor(private readonly refs: Map<string, RefEntry>) {}

	captureTarget(targetId: string): GenerationCapture {
		const targetState = this.ensureTarget(targetId);
		return {
			targetId,
			frameKey: targetId,
			generation: targetState.generation,
			targetGeneration: targetState.generation,
			observationRevision: targetState.observationRevision,
			targetState,
		};
	}

	captureFrame(targetId: string, frameId: string): GenerationCapture {
		const targetState = this.ensureTarget(targetId);
		let frameState = this.frames.get(frameId);
		if (frameState && frameState.targetId !== targetId) {
			throw new Error(`frame ${frameId} changed owner from ${frameState.targetId} to ${targetId}`);
		}
		frameState ??= { targetId, frameId, generation: 0, captures: 0, refs: 0 };
		this.frames.set(frameId, frameState);
		frameState.captures += 1;
		return {
			targetId,
			frameKey: frameId,
			generation: frameState.generation,
			targetGeneration: targetState.generation,
			observationRevision: targetState.observationRevision,
			targetState,
			frameState,
		};
	}

	isCurrent(capture: GenerationCapture): boolean {
		if (
			this.targets.get(capture.targetId) !== capture.targetState ||
			capture.targetState.generation !== capture.targetGeneration ||
			capture.targetState.observationRevision !== capture.observationRevision
		) {
			return false;
		}
		return (
			!capture.frameState ||
			(this.frames.get(capture.frameKey) === capture.frameState && capture.frameState.generation === capture.generation)
		);
	}

	release(captures: readonly GenerationCapture[]): void {
		for (const capture of captures) {
			if (!capture.frameState) continue;
			capture.frameState.captures = Math.max(0, capture.frameState.captures - 1);
			this.deleteUnusedFrame(capture.frameState);
		}
	}

	retainRef(ref: string, entry: RefEntry): void {
		this.deleteRef(ref);
		if (entry.frameId === entry.targetId) {
			const target = this.targets.get(entry.targetId);
			if (!target || target.generation !== entry.generation) throw new ObservationChangedError();
		} else {
			const frame = this.frames.get(entry.frameId);
			if (!frame || frame.targetId !== entry.targetId || frame.generation !== entry.generation) {
				throw new ObservationChangedError();
			}
			frame.refs += 1;
		}
		this.refs.set(ref, entry);
	}

	deleteRef(ref: string): void {
		const entry = this.refs.get(ref);
		if (!entry) return;
		this.refs.delete(ref);
		if (entry.frameId === entry.targetId) return;
		const frame = this.frames.get(entry.frameId);
		if (!frame || frame.targetId !== entry.targetId) return;
		frame.refs = Math.max(0, frame.refs - 1);
		this.deleteUnusedFrame(frame);
	}

	/** Current generation for an observation frame key, defaulting to zero before registration. */
	currentGeneration(frameKey: string): number {
		return this.frames.get(frameKey)?.generation ?? this.targets.get(frameKey)?.generation ?? 0;
	}

	isRefCurrent(entry: RefEntry): boolean {
		if (entry.frameId === entry.targetId) return this.targets.get(entry.targetId)?.generation === entry.generation;
		const frame = this.frames.get(entry.frameId);
		return frame?.targetId === entry.targetId && frame.generation === entry.generation;
	}

	/**
	 * Record the document identity (loaderId) a ref-owning frame's current
	 * generation was observed at, keyed like a ref's frameId: the target for a
	 * main-frame key, else the child frame. Persisted and reconciled later.
	 */
	recordDocument(frameKey: string, ownerTargetId: string, loaderId: string): void {
		if (frameKey === ownerTargetId) {
			this.ensureTarget(frameKey).document = loaderId;
			return;
		}
		const frame = this.frames.get(frameKey);
		if (frame && frame.targetId === ownerTargetId) frame.document = loaderId;
	}

	/** The document identity recorded for a frame's current generation, if known. */
	documentOf(frameKey: string, ownerTargetId: string): string | undefined {
		return frameKey === ownerTargetId ? this.targets.get(frameKey)?.document : this.frames.get(frameKey)?.document;
	}

	/** Whether any imported ref-owning frame under this target still awaits reconciliation. */
	hasPendingDocument(targetId: string): boolean {
		for (const owner of this.documentOwners.values()) if (owner === targetId) return true;
		return false;
	}

	/**
	 * The imported ref-owning frames under this target still awaiting
	 * reconciliation, each flagged `verifiable` when a usable mint-time loaderId
	 * exists to compare against the live document. Unverifiable frames (legacy or
	 * malformed identity) carry no loaderId and must fail safe.
	 */
	pendingDocuments(targetId: string): Array<{ frameKey: string; verifiable: boolean }> {
		const pending: Array<{ frameKey: string; verifiable: boolean }> = [];
		for (const [frameKey, owner] of this.documentOwners) {
			if (owner === targetId) pending.push({ frameKey, verifiable: this.expectedDocuments.has(frameKey) });
		}
		return pending;
	}

	/**
	 * Reconcile one imported ref-owning frame against the document loaded now.
	 * A verifiable frame whose live loaderId matches its mint-time identity keeps
	 * its refs (unchanged across the process boundary); a mismatch, an unknown
	 * live document, or an unverifiable (legacy/malformed) identity invalidates
	 * *only that frame* — the target for a main-frame key, else the child frame,
	 * leaving the main frame, siblings, and unchanged frames intact. One-shot:
	 * the pending entry is consumed either way. A blank expected or live loaderId
	 * is always treated as a non-match so empty identities can never mis-verify.
	 */
	reconcileDocument(frameKey: string, ownerTargetId: string, liveLoaderId: string | undefined): void {
		if (!this.documentOwners.has(frameKey)) return;
		this.documentOwners.delete(frameKey);
		const expected = this.expectedDocuments.get(frameKey);
		this.expectedDocuments.delete(frameKey);
		const unverifiable = this.unverifiedDocuments.delete(frameKey);
		if (!unverifiable && !!expected && !!liveLoaderId && liveLoaderId === expected) {
			this.recordDocument(frameKey, ownerTargetId, liveLoaderId);
		} else if (frameKey === ownerTargetId) {
			this.invalidateTarget(frameKey);
		} else {
			this.invalidateFrame(ownerTargetId, frameKey);
		}
	}

	invalidateTarget(targetId: string): void {
		const target = this.ensureTarget(targetId);
		target.generation += 1;
		target.observationRevision += 1;
		// The old document's refs are gone; its identity no longer describes the
		// live page, so drop it until the next observation records the new one.
		target.document = undefined;
		this.deleteRefs((entry) => entry.targetId === targetId);
		for (const frame of [...this.frames.values()]) {
			if (frame.targetId !== targetId) continue;
			frame.generation += 1;
			this.deleteUnusedFrame(frame);
		}
	}

	invalidateFrame(targetId: string, frameId: string): void {
		const target = this.targets.get(targetId);
		if (target) target.observationRevision += 1;
		const frame = this.frames.get(frameId);
		if (!frame || frame.targetId !== targetId) return;
		frame.generation += 1;
		// The old document's refs are gone; its identity no longer describes the
		// live frame, so drop it until the next observation records the new one.
		frame.document = undefined;
		this.deleteRefs((entry) => entry.targetId === targetId && entry.frameId === frameId);
		this.deleteUnusedFrame(frame);
	}

	removeFrame(targetId: string, frameId: string): void {
		const target = this.targets.get(targetId);
		if (target) target.observationRevision += 1;
		const frame = this.frames.get(frameId);
		if (!frame || frame.targetId !== targetId) return;
		this.deleteRefs((entry) => entry.targetId === targetId && entry.frameId === frameId);
		this.frames.delete(frameId);
	}

	dropTarget(targetId: string): void {
		this.deleteRefs((entry) => entry.targetId === targetId);
		this.targets.delete(targetId);
		for (const [frameId, frame] of this.frames) {
			if (frame.targetId === targetId) this.frames.delete(frameId);
		}
	}

	exportGenerations(): Array<[string, number]> {
		return [
			...[...this.targets.values()].map((state): [string, number] => [state.targetId, state.generation]),
			...[...this.frames.values()].map((state): [string, number] => [state.frameId, state.generation]),
		];
	}

	/**
	 * Document identities to persist for the given ref-owning frame keys: the
	 * recorded (live-verified or mint-time) loaderId, or a still-pending imported
	 * one for a frame this process never re-attached, so the identity survives
	 * intermediate invocations that never touched the frame. An unverifiable
	 * imported frame contributes nothing — identity is never fabricated on
	 * re-export, so legacy/partial state stays honestly unverifiable downstream.
	 */
	exportDocuments(refFrames: ReadonlySet<string>): Array<[string, string]> {
		const out: Array<[string, string]> = [];
		for (const frameKey of refFrames) {
			const loaderId =
				this.frames.get(frameKey)?.document ?? this.targets.get(frameKey)?.document ?? this.expectedDocuments.get(frameKey);
			if (loaderId !== undefined) out.push([frameKey, loaderId]);
		}
		return out;
	}

	importState(
		generations: readonly (readonly [string, number])[],
		entries: readonly (readonly [string, Omit<RefEntry, "sessionId">])[],
		activeTargetId?: string,
		documents?: readonly (readonly [string, string])[],
	): void {
		const importedGenerations = new Map(generations);
		const validDocuments = validateImportedDocuments(documents);
		this.expectedDocuments.clear();
		this.documentOwners.clear();
		this.unverifiedDocuments.clear();
		const targetIds = new Set(entries.map(([, entry]) => entry.targetId));
		if (activeTargetId) targetIds.add(activeTargetId);
		for (const targetId of targetIds) {
			this.targets.set(targetId, {
				targetId,
				generation: importedGenerations.get(targetId) ?? 0,
				observationRevision: 0,
			});
		}
		for (const [ref, imported] of entries) {
			this.deleteRef(ref);
			const entry: RefEntry = { ...imported, sessionId: "" };
			// Classify each ref-owning frame's document identity once, keyed like the
			// ref itself: a usable loaderId is verifiable and reconciled against the
			// live browser; anything else fails safe (staled) rather than resolving.
			if (!this.documentOwners.has(entry.frameId)) {
				this.documentOwners.set(entry.frameId, entry.targetId);
				const loaderId = validDocuments.get(entry.frameId);
				if (loaderId !== undefined) this.expectedDocuments.set(entry.frameId, loaderId);
				else this.unverifiedDocuments.add(entry.frameId);
			}
			if (entry.frameId !== entry.targetId) {
				let frame = this.frames.get(entry.frameId);
				if (!frame) {
					frame = {
						targetId: entry.targetId,
						frameId: entry.frameId,
						generation: importedGenerations.get(entry.frameId) ?? entry.generation,
						captures: 0,
						refs: 0,
					};
					this.frames.set(entry.frameId, frame);
				}
				frame.refs += 1;
			}
			this.refs.set(ref, entry);
		}
	}

	private ensureTarget(targetId: string): TargetGenerationState {
		let target = this.targets.get(targetId);
		if (!target) {
			target = { targetId, generation: 0, observationRevision: 0 };
			this.targets.set(targetId, target);
		}
		return target;
	}

	private deleteRefs(predicate: (entry: RefEntry) => boolean): void {
		for (const [ref, entry] of this.refs) {
			if (predicate(entry)) this.deleteRef(ref);
		}
	}

	private deleteUnusedFrame(frame: FrameGenerationState): void {
		if (frame.captures === 0 && frame.refs === 0 && this.frames.get(frame.frameId) === frame) {
			this.frames.delete(frame.frameId);
		}
	}
}

export function staleRefError(ref: string, cause?: unknown): Error {
	return new Error(`ref ${ref} is stale or not on the current page. ${STALE_REF_HINT}`, cause === undefined ? undefined : { cause });
}

/**
 * Distil an untrusted, disk-sourced `documents` array into the frame keys that
 * carry a single, non-blank loaderId usable for reconciliation. Everything
 * dubious degrades to "unverifiable for that frame" (dropped here, so the frame
 * fails safe on import) rather than throwing: a non-array input, non-tuple or
 * non-string entries, a blank loaderId (which must never match a blank live
 * one), and duplicate keys with conflicting loaderIds (ambiguous identity).
 */
function validateImportedDocuments(documents: unknown): Map<string, string> {
	const valid = new Map<string, string>();
	const ambiguous = new Set<string>();
	if (!Array.isArray(documents)) return valid;
	for (const entry of documents) {
		if (!Array.isArray(entry) || entry.length < 2) continue;
		const [frameKey, loaderId] = entry as [unknown, unknown];
		if (typeof frameKey !== "string" || frameKey === "" || typeof loaderId !== "string" || loaderId === "") continue;
		if (ambiguous.has(frameKey)) continue;
		const existing = valid.get(frameKey);
		if (existing === undefined) valid.set(frameKey, loaderId);
		else if (existing !== loaderId) {
			valid.delete(frameKey);
			ambiguous.add(frameKey);
		}
	}
	return valid;
}
