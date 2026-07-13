export type BrowserActOutcome = "worked" | "didnt" | "unknown";
export type BrowserExpectationStatus = "newly_verified" | "preexisting" | "failed" | "unverifiable";

export interface BrowserExpectationEvidence {
	status: BrowserExpectationStatus;
	before?: boolean;
	after?: boolean;
	details: string[];
}

export interface BrowserActStepResult {
	index: number;
	type: string;
	outcome: BrowserActOutcome;
	evidence: string[];
	expectation?: BrowserExpectationEvidence;
}

export interface BrowserObservationDiff {
	changed: boolean;
	added: string[];
	removed: string[];
	url?: { before: string; after: string };
	title?: { before: string; after: string };
}

export interface BrowserActObservedSuccessor {
	status: "observed";
	text: string;
	url: string;
	title: string;
	diff: BrowserObservationDiff;
}

export interface BrowserActUnavailableSuccessor {
	status: "unavailable";
	error: string;
}

export type BrowserActSuccessor = BrowserActObservedSuccessor | BrowserActUnavailableSuccessor;

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
