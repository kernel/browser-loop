import type { BrowserAction, BrowserActStep } from "../../src/core/actions/browser";

export const OPERATIONS = [
	"CLICK",
	"TYPE_TEXT",
	"SELECT",
	"SCROLL",
	"WAIT",
	"NAVIGATE",
	"BACK",
	"FORWARD",
	"RELOAD",
	"DONE",
	"BLOCKED",
] as const;

export type Operation = (typeof OPERATIONS)[number];
export type TextPurpose = "field" | "navigation";

export interface ScrollState {
	y: number;
	height: number;
	viewport: number;
	width: number;
}

export interface ObservationElement {
	ref: string;
	role: string;
	name: string;
	depth: number;
	value?: string;
	checked?: boolean | "mixed";
	selected?: boolean;
	expanded?: boolean;
	disabled?: boolean;
}

export interface Observation {
	url: string;
	title: string;
	text: string;
	snapshot: string;
	elements: ObservationElement[];
	scroll: ScrollState;
	fingerprint: string;
}

export interface ActionSpaceElement extends ObservationElement {
	operations: Operation[];
	options?: Array<{ label: string; value: string; selected: boolean }>;
}

export interface JevCandidate {
	id: string;
	kind: "browser-step" | "browser-action" | "navigate" | "history" | "terminal";
	operation: Operation;
	label: string;
	ref?: string;
	value?: string;
	step?: BrowserActStep;
	action?: BrowserAction;
	textPurpose?: TextPurpose;
}

export interface JevCandidateSpace {
	candidates: JevCandidate[];
	byId: ReadonlyMap<string, JevCandidate>;
	byOperation: ReadonlyMap<Operation, readonly JevCandidate[]>;
	elements: ActionSpaceElement[];
}

export interface HistoryEntry {
	step: number;
	operation: Operation;
	candidateId: string;
	label: string;
	value?: string;
	pageChanged: boolean;
	url: string;
}

export interface PolicyInput {
	goal: string;
	observation: Observation;
	space: JevCandidateSpace;
	history: HistoryEntry[];
}

export interface PolicyDecision {
	operation: Operation;
	candidateId: string;
	operationConfidence: number;
	targetConfidence?: number;
	latencyMs: number;
	inputTokens: number;
	outputTokens: number;
	model: string;
}

export interface JevPolicy {
	decide(input: PolicyInput): Promise<PolicyDecision>;
}

export interface TextResolutionInput {
	purpose: TextPurpose;
	goal: string;
	candidate: JevCandidate;
	observation: Observation;
	history: HistoryEntry[];
}

export interface TextResolver {
	resolve(input: TextResolutionInput): Promise<string | null>;
}

export interface BrowserRuntime {
	observe(): Promise<Observation>;
	execute(action: BrowserAction): Promise<void>;
}

export interface StepTrace {
	step: number;
	operation: Operation;
	candidateId: string;
	label: string;
	operationConfidence: number;
	targetConfidence?: number;
	latencyMs: number;
	inputTokens: number;
	outputTokens: number;
	model: string;
}

export interface AgentResult {
	status: "completed" | "blocked" | "failed";
	reason: string;
	steps: StepTrace[];
	history: HistoryEntry[];
	wallMs: number;
	finalObservation: Observation;
	usage: {
		calls: number;
		inputTokens: number;
		outputTokens: number;
		latencyMs: number;
	};
}
