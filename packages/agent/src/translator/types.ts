/** Semantic result of an action or dependent action list; input delivery alone remains `unknown`. */
export type BrowserActOutcome = "worked" | "didnt" | "unknown";

/** Whether an expectation changed to true, was already true, stayed false, or could not be evaluated. */
export type BrowserExpectationStatus = "newly_verified" | "preexisting" | "failed" | "unverifiable";

/** Before/after evidence collected while evaluating a semantic expectation. */
export interface BrowserExpectationEvidence {
	status: BrowserExpectationStatus;
	before?: boolean;
	after?: boolean;
	details: string[];
}

/** Outcome and evidence for one requested `browser_act` step. */
export interface BrowserActStepResult {
	index: number;
	type: string;
	outcome: BrowserActOutcome;
	evidence: string[];
	expectation?: BrowserExpectationEvidence;
}

/** Complete normalized accessibility-tree and page-metadata changes between two observations. */
export interface BrowserObservationDiff {
	changed: boolean;
	added: string[];
	removed: string[];
	url?: { before: string; after: string };
	title?: { before: string; after: string };
}

/** Stable successor observation collected after action execution stops. */
export interface BrowserActObservedSuccessor {
	status: "observed";
	text: string;
	url: string;
	title: string;
	diff: BrowserObservationDiff;
}

/** Indicates that no stable successor observation could be collected. */
export interface BrowserActUnavailableSuccessor {
	status: "unavailable";
	error: string;
}

/** Stable observed successor or an explicit observation failure. */
export type BrowserActSuccessor = BrowserActObservedSuccessor | BrowserActUnavailableSuccessor;

/** Structured result for a dependent browser action list and its optional semantic expectations. */
export interface BrowserActResult {
	outcome: BrowserActOutcome;
	steps: BrowserActStepResult[];
	stopped_at?: number;
	stop_reason?: "action_failed" | "expectation_failed" | "navigation" | "stale_ref" | "dialog" | "control_flow";
	final_expectation?: BrowserExpectationEvidence;
	successor: BrowserActSuccessor;
}

export type BatchReadResult =
	| { type: "screenshot"; data: Buffer; mimeType: string }
	| { type: "url"; url: string }
	| { type: "cursor_position"; x: number; y: number }
	| { type: "browser_text"; label: string; text: string }
	| { type: "browser_act"; result: BrowserActResult };

export interface BatchExecutionResult {
	readResults: BatchReadResult[];
}
