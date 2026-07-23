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
}

interface FrameGenerationState {
	readonly targetId: string;
	readonly frameId: string;
	generation: number;
	captures: number;
	refs: number;
}

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
 */
export interface BrowserRefState {
	refCounter: number;
	activeTargetId?: string;
	generations: Array<[string, number]>;
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

	isRefCurrent(entry: RefEntry): boolean {
		if (entry.frameId === entry.targetId) return this.targets.get(entry.targetId)?.generation === entry.generation;
		const frame = this.frames.get(entry.frameId);
		return frame?.targetId === entry.targetId && frame.generation === entry.generation;
	}

	invalidateTarget(targetId: string): void {
		const target = this.ensureTarget(targetId);
		target.generation += 1;
		target.observationRevision += 1;
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

	importState(
		generations: readonly (readonly [string, number])[],
		entries: readonly (readonly [string, Omit<RefEntry, "sessionId">])[],
		activeTargetId?: string,
	): void {
		const importedGenerations = new Map(generations);
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
