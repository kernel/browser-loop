/** Three-valued semantic expectation result with model-facing evidence. */
export interface BrowserExpectationEvidence {
	truth?: boolean;
	details: string[];
}

/** Browser lifecycle or observation reason that terminated semantic verification. */
export type BrowserWaitReason =
	| "navigation"
	| "dialog"
	| "target_changed"
	| "target_detached"
	| "stale_ref"
	| "observation_failed"
	| "incomplete_observation";

/** Whether an expectation matched at one observation point. */
export type BrowserExpectationState = "matched" | "not_matched" | "unknown";

/**
 * Causal verdict for one step or the complete plan.
 *
 * - `worked`: requested postconditions were newly verified after acknowledged input.
 * - `didnt`: a postcondition was definitively false, or the addressed ref was stale.
 * - `unknown`: delivery or observation was uncertain, evidence was preexisting, or no
 *   expectation established what the input accomplished.
 */
export type BrowserActOutcome = "worked" | "didnt" | "unknown";

type BrowserActExpectationDiagnostics = {
	/** Ordered human-readable diagnostics, potentially one per `all`/`any` leaf and observation phase. */
	diagnostics: string[];
};

/**
 * Before/after semantic evidence. Both fields are always present and refer to the
 * observation immediately before the associated action/plan and the verified state
 * afterward. The discriminated union prevents contradictory status/state combinations.
 */
export type BrowserActExpectationEvidence =
	| ({ status: "newly_verified"; before: "not_matched" | "unknown"; after: "matched" } & BrowserActExpectationDiagnostics)
	| ({ status: "preexisting"; before: "matched"; after: "matched" } & BrowserActExpectationDiagnostics)
	| ({ status: "failed"; before: BrowserExpectationState; after: "not_matched" } & BrowserActExpectationDiagnostics)
	| ({
		status: "unverifiable";
		before: BrowserExpectationState;
		after: "unknown";
		/** Structured lifecycle/observation cause when verification could not finish. */
		reason?: BrowserWaitReason;
	} & BrowserActExpectationDiagnostics);

/** Whether action-associated semantic evidence was new, preexisting, false, or unknowable. */
export type BrowserActExpectationStatus = BrowserActExpectationEvidence["status"];

/** Outcome for one requested step; `expectation` exists only when that condition was evaluated. */
export interface BrowserActStepResult {
	/** Zero-based index in the requested `steps` array. */
	index: number;
	type: string;
	/** Causal step verdict, incorporating input delivery and expectation evidence. */
	outcome: BrowserActOutcome;
	/** Human-readable execution diagnostics; use `outcome`, `expectation`, and plan stop fields for control flow. */
	diagnostics: string[];
	/** Omitted when the step had no expectation or verification produced no usable evidence. */
	expectation?: BrowserActExpectationEvidence;
}

/** One normalized rendered accessibility-tree line and its multiplicity. */
export interface BrowserObservationDiffEntry {
	/** Rendered AX line with invocation-scoped element IDs normalized to `[ref]`. */
	line: string;
	/** Number of copies added or removed. */
	count: number;
}

/**
 * Semantic line, URL, and title changes between complete baseline/successor presentations.
 * Entries are complete structured data; model-facing formatting separately caps them by
 * entry count and character count so a large page cannot flood the prompt.
 */
export interface BrowserObservationDiff {
	changed: boolean;
	/** AX lines whose multiplicity increased, in first-successor-occurrence order. */
	added: BrowserObservationDiffEntry[];
	/** AX lines whose multiplicity decreased, in first-baseline-occurrence order. */
	removed: BrowserObservationDiffEntry[];
	url?: { before: string; after: string };
	title?: { before: string; after: string };
}

/**
 * Why a dependent plan stopped before safely completing every operation.
 *
 * - `action_failed`: input delivery raised an error and may be uncertain.
 * - `expectation_failed`: a requested semantic postcondition was definitively false.
 * - `navigation`: the selected document or an observed child frame navigated.
 * - `stale_ref`: an element ref no longer identified the observed document.
 * - `dialog`: a JavaScript dialog opened and created a control-flow boundary.
 * - `control_flow`: target topology or observation completeness changed unexpectedly.
 * - `step_timeout`: the current step exhausted its own deadline.
 * - `global_timeout`: the complete plan exhausted its shared deadline.
 */
export type BrowserActStopReason =
	| "action_failed"
	| "expectation_failed"
	| "navigation"
	| "stale_ref"
	| "dialog"
	| "control_flow"
	| "step_timeout"
	| "global_timeout";

/** Stable page state collected after the plan. */
export interface BrowserActObservedSuccessor {
	status: "observed";
	/** Rendered AX snapshot, bounded by the executor's snapshot character limit. */
	text: string;
	url: string;
	title: string;
	/** Complete normalized semantic changes from the original plan baseline. */
	diff: BrowserObservationDiff;
}

/** Why no stable post-plan page state could be collected. */
export interface BrowserActUnavailableSuccessor {
	status: "unavailable";
	error: string;
}

/** Stable post-plan feedback, or an explicit explanation that it was unavailable. */
export type BrowserActSuccessor = BrowserActObservedSuccessor | BrowserActUnavailableSuccessor;

/**
 * Structured result returned by a dependent `browser_act` plan.
 *
 * `outcome` is the aggregate causal verdict. Per-step outcomes explain which input
 * established which postcondition; `final_expectation` evaluates the plan-level
 * condition against the original baseline. A stop reason means trailing dependent
 * operations were not safe to run. `successor` is feedback, not proof by itself:
 * expectation evidence determines the verdict, while the successor tells the caller
 * what stable page state was observed afterward.
 */
export interface BrowserActResult {
	outcome: BrowserActOutcome;
	steps: BrowserActStepResult[];
	/** Zero-based step where execution stopped, or the next step when it could not start. */
	stopped_at?: number;
	stop_reason?: BrowserActStopReason;
	final_expectation?: BrowserActExpectationEvidence;
	successor: BrowserActSuccessor;
}

/** Structured result returned by the standalone `browser_wait_for` action. */
export interface BrowserWaitForResult {
	status: "satisfied" | "timed_out" | "unverifiable" | "interrupted";
	evidence: "preexisting" | "newly_verified" | "failed" | "unverifiable";
	initial: BrowserExpectationEvidence;
	final: BrowserExpectationEvidence;
	elapsed_ms: number;
	reason?: BrowserWaitReason;
	details: string[];
}

export type BatchReadResult =
	| { type: "screenshot"; data: Buffer; mimeType: string }
	| { type: "url"; url: string }
	| { type: "cursor_position"; x: number; y: number }
	| { type: "browser_text"; label: string; text: string }
	| { type: "browser_wait_for"; result: BrowserWaitForResult }
	| { type: "browser_act"; result: BrowserActResult };

export interface BatchExecutionResult {
	readResults: BatchReadResult[];
	/** Remaining canonical actions skipped after an unsatisfied wait or browser-plan control-flow boundary. */
	skippedActions?: number;
}
