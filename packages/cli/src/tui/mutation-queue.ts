/**
 * Serializes catalog mutations initiated from the TUI.
 *
 * Both mutations a selector can trigger — a `/tools` apply and a `/model`
 * switch — suspend across several `setTools()`/`setModel()` calls. Run
 * concurrently, an apply's `setTools()` can land between a switch's
 * `setModel()` and its final `setTools()` and fail to compile against the wrong
 * provider, aborting an otherwise valid switch. Funnelling both through one
 * queue removes the interleaving entirely.
 */
export interface MutationQueue {
	/**
	 * Run `fn` only after every previously queued mutation has settled. The
	 * returned promise mirrors `fn`'s outcome, so callers keep their own error
	 * handling; the queue itself never rejects, so one failure cannot wedge it.
	 */
	run<T>(fn: () => Promise<T>): Promise<T>;
	/** Resolves once the queue is idle. Test and shutdown aid. */
	drain(): Promise<void>;
}

export function createMutationQueue(): MutationQueue {
	let chain: Promise<void> = Promise.resolve();
	return {
		run<T>(fn: () => Promise<T>): Promise<T> {
			const result = chain.then(fn);
			chain = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
		drain(): Promise<void> {
			return chain;
		},
	};
}
