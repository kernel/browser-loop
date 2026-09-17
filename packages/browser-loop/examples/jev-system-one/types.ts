export type AgentMode = "jev-only" | "hybrid";

export interface ObservationElement {
	id: string;
	tag: string;
	role: string;
	name: string;
	type: string;
	value: string;
	options?: string[];
}

export interface Observation {
	url: string;
	title: string;
	text: string;
	elements: ObservationElement[];
}

export type BrowserAction =
	| { kind: "click"; elementId: string; description: string }
	| { kind: "fill"; elementId: string; value: string; description: string }
	| { kind: "select"; elementId: string; value: string; description: string }
	| { kind: "back"; description: string }
	| { kind: "finish"; description: string }
	| { kind: "fail"; description: string };

export interface PlannedTask {
	summary: string;
	subgoals: string[];
	values: string[];
	answerKind: "none" | "extract" | "generate";
	answerInstruction: string;
}

export interface ModelUsage {
	calls: number;
	inputTokens: number;
	outputTokens: number;
	latencyMs: number;
	costUsd: number;
}

export interface StepTrace {
	step: number;
	goal: string;
	action: string;
	confidence: number;
	doneProbability: number;
	latencyMs: number;
	inputTokens: number;
	outputTokens: number;
}

export interface AgentResult {
	mode: AgentMode;
	status: "completed" | "failed" | "unsupported";
	answer?: string;
	reason?: string;
	steps: StepTrace[];
	usage: {
		jev: ModelUsage;
		planner: ModelUsage;
	};
	wallMs: number;
	finalObservation?: Observation;
}
