import type { BrowserAction } from "../../src/core/actions/browser";

export const OPERATIONS = [
	"CLICK",
	"TYPE_TEXT",
	"SELECT",
	"USE_CREDENTIALS",
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
export type ElementOperation = Extract<Operation, "CLICK" | "TYPE_TEXT" | "SELECT">;
export type CredentialSemantic = "identifier" | "password" | "otp" | "text";
export type TextPurpose = "field" | "navigation";

export interface ScrollState {
	y: number;
	height: number;
	viewport: number;
	width: number;
	x: number;
	pointY: number;
}

export interface ElementTarget {
	documentId: string;
	node: number;
	guard: string;
	ref?: string;
}

export interface CredentialField {
	id: string;
	name: string;
	semantic: CredentialSemantic;
	type: string;
	autocomplete: string;
	sensitive: boolean;
	hasValue: boolean;
	target: ElementTarget;
}

export interface CredentialForm {
	id: string;
	name: string;
	fields: CredentialField[];
}

export interface ObservationElement {
	id: string;
	node: number;
	role: string;
	name: string;
	value: string;
	hasValue?: boolean;
	credentialSemantic?: CredentialSemantic;
	sensitive?: boolean;
	operations: ElementOperation[];
	options: Array<{ label: string; value: string; selected: boolean }>;
	checked?: boolean | "mixed";
	selected?: boolean;
	expanded?: boolean;
	disabled?: boolean;
	guard: string;
	ref?: string;
	rect: { x: number; y: number; width: number; height: number };
}

export interface Observation {
	url: string;
	title: string;
	documentId: string;
	text: string;
	snapshot: string;
	elements: ObservationElement[];
	credentialForms: CredentialForm[];
	scroll: ScrollState;
	fingerprint: string;
	interactionFingerprint: string;
	marker: string;
	omittedElements: number;
}

export type ActionSpaceElement = ObservationElement;

export interface JevCandidate {
	id: string;
	kind: "target" | "credential" | "browser-action" | "navigate" | "history" | "terminal";
	operation: Operation;
	label: string;
	target?: ElementTarget;
	credentialForm?: CredentialForm;
	value?: string;
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

export interface PreparedCredentialField {
	field: CredentialField;
	selector: string;
}

export interface PreparedCredentialForm {
	pageUrl: string;
	fields: PreparedCredentialField[];
	cleanup(): Promise<void>;
}

export interface BrowserRuntime {
	observe(): Promise<Observation>;
	isFresh(observation: Observation, candidate: JevCandidate): Promise<boolean>;
	execute(action: BrowserAction): Promise<void>;
	executeTarget(candidate: JevCandidate, value?: string): Promise<void>;
	prepareCredentialForm?(observation: Observation, form: CredentialForm): Promise<PreparedCredentialForm>;
}

export interface CredentialUseInput {
	goal: string;
	candidate: JevCandidate;
	observation: Observation;
	history: HistoryEntry[];
	browser: BrowserRuntime;
}

export interface CredentialBroker {
	use(input: CredentialUseInput): Promise<void>;
}

export class CredentialBlockedError extends Error {}

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
