/** Three-valued semantic expectation result with model-facing evidence. */
export interface BrowserExpectationEvidence {
	truth?: boolean;
	details: string[];
}

/** Semantic result of one action or a complete dependent action plan. */
export type BrowserActOutcome = "worked" | "didnt" | "unknown";

/** Whether an action expectation was newly verified, preexisting, failed, or unverifiable. */
export type BrowserActExpectationStatus = "newly_verified" | "preexisting" | "failed" | "unverifiable";

/** Before/after semantic evidence for an action expectation. */
export interface BrowserActExpectationEvidence {
	status: BrowserActExpectationStatus;
	before?: boolean;
	after?: boolean;
	details: string[];
}

/** Outcome and evidence for one requested browser action-plan step. */
export interface BrowserActStepResult {
	index: number;
	type: string;
	outcome: BrowserActOutcome;
	evidence: string[];
	expectation?: BrowserActExpectationEvidence;
}

/** Complete normalized changes between baseline and successor observations. */
export interface BrowserObservationDiff {
	changed: boolean;
	added: string[];
	removed: string[];
	url?: { before: string; after: string };
	title?: { before: string; after: string };
}

/** Structured result returned by a dependent `browser_act` plan. */
export interface BrowserActResult {
	outcome: BrowserActOutcome;
	steps: BrowserActStepResult[];
	/** Zero-based index of the step where execution stopped. */
	stopped_at?: number;
	stop_reason?: "action_failed" | "expectation_failed" | "navigation" | "stale_ref" | "dialog" | "control_flow";
	final_expectation?: BrowserActExpectationEvidence;
	successor:
		| { status: "observed"; text: string; url: string; title: string; diff: BrowserObservationDiff }
		| { status: "unavailable"; error: string };
}

/** Browser lifecycle or observation reason that terminated a semantic wait. */
export type BrowserWaitReason =
	| "navigation"
	| "dialog"
	| "target_changed"
	| "target_detached"
	| "stale_ref"
	| "observation_failed"
	| "incomplete_observation";

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
}
