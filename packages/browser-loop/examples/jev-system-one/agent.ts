import type { BrowserAction } from "../../src/core/actions/browser";
import { buildCandidateSpace } from "./actions";
import type {
	AgentResult,
	BrowserRuntime,
	HistoryEntry,
	JevCandidate,
	JevCandidateSpace,
	JevPolicy,
	Observation,
	TextResolver,
} from "./types";

const MAX_STEPS = 60;

type LoweredAction =
	| { kind: "browser"; action: BrowserAction; value?: string }
	| { kind: "target"; candidate: JevCandidate; value?: string };

export async function runAgent(options: {
	goal: string;
	browser: BrowserRuntime;
	policy: JevPolicy;
	textResolver?: TextResolver;
	maxSteps?: number;
	onDecision?: (trace: AgentResult["steps"][number]) => void;
	onFreshness?: (trace: { step: number; latencyMs: number; changed: boolean }) => void;
	onAction?: (trace: HistoryEntry & { latencyMs: number; resolveMs: number; executeMs: number; observeMs: number }) => void;
}): Promise<AgentResult> {
	const started = performance.now();
	const history: HistoryEntry[] = [];
	const steps: AgentResult["steps"] = [];
	const usage = { calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
	const attemptedTransitions = new Set<string>();
	const rejectedByState = new Map<string, Set<string>>();
	let observation = await options.browser.observe();
	let status: AgentResult["status"] = "blocked";
	let reason = "Step limit reached";

	for (let step = 0; step < (options.maxSteps ?? MAX_STEPS); step++) {
		const rejected = rejectedByState.get(observation.interactionFingerprint);
		const space = rejectCandidates(buildCandidateSpace(observation, options.goal, history), rejected);
		const decision = await options.policy.decide({ goal: options.goal, observation, space, history });
		usage.calls += 1;
		usage.inputTokens += decision.inputTokens;
		usage.outputTokens += decision.outputTokens;
		usage.latencyMs += decision.latencyMs;
		const candidate = space.byId.get(decision.candidateId);
		if (!candidate || candidate.operation !== decision.operation) {
			status = "failed";
			reason = `Policy selected unavailable candidate ${decision.candidateId}`;
			break;
		}
		const trace = {
			step,
			operation: decision.operation,
			candidateId: candidate.id,
			label: candidate.label,
			operationConfidence: decision.operationConfidence,
			...(decision.targetConfidence === undefined ? {} : { targetConfidence: decision.targetConfidence }),
			latencyMs: decision.latencyMs,
			inputTokens: decision.inputTokens,
			outputTokens: decision.outputTokens,
			model: decision.model,
		};
		steps.push(trace);
		options.onDecision?.(trace);

		const freshnessStarted = performance.now();
		const fresh = await options.browser.isFresh(observation, candidate);
		options.onFreshness?.({ step: step + 1, latencyMs: performance.now() - freshnessStarted, changed: !fresh });
		if (!fresh) {
			observation = await options.browser.observe();
			continue;
		}

		if (candidate.kind === "terminal") {
			status = candidate.operation === "DONE" ? "completed" : "blocked";
			reason = candidate.operation === "DONE" ? "Jev found visible completion evidence" : "Jev found no supported operation that could make progress safely";
			break;
		}

		const candidateKey = semanticCandidateKey(candidate);
		const transitionKey = `${observation.interactionFingerprint}\u0000${candidateKey}`;
		if (attemptedTransitions.has(transitionKey)) {
			const stateRejected = rejectedByState.get(observation.interactionFingerprint) ?? new Set<string>();
			stateRejected.add(candidateKey);
			rejectedByState.set(observation.interactionFingerprint, stateRejected);
			continue;
		}

		const actionStarted = performance.now();
		let lowered: LoweredAction | undefined;
		let resolveMs = 0;
		let executeMs = 0;
		try {
			const resolveStarted = performance.now();
			lowered = await lowerCandidate(candidate, options.goal, observation, history, options.textResolver);
			resolveMs = performance.now() - resolveStarted;
			if (!lowered) {
				status = "blocked";
				reason = `No text value was available for ${candidate.label}`;
				break;
			}
			const executeStarted = performance.now();
			if (lowered.kind === "target") await options.browser.executeTarget(lowered.candidate, lowered.value);
			else await options.browser.execute(lowered.action);
			executeMs = performance.now() - executeStarted;
		} catch (error) {
			if (/stale.*ref|ref.*stale|page changed|target changed/i.test(errorMessage(error))) {
				observation = await options.browser.observe();
				continue;
			}
			status = "failed";
			reason = `Browser action failed: ${errorMessage(error)}`;
			break;
		}

		attemptedTransitions.add(transitionKey);
		const observeStarted = performance.now();
		const successor = await options.browser.observe();
		const observeMs = performance.now() - observeStarted;
		const historyEntry: HistoryEntry = {
			step: history.length + 1,
			operation: candidate.operation,
			candidateId: candidate.id,
			label: candidate.label,
			...(lowered.value === undefined ? {} : { value: lowered.value }),
			pageChanged: successor.fingerprint !== observation.fingerprint,
			url: successor.url,
		};
		history.push(historyEntry);
		options.onAction?.({
			...historyEntry,
			latencyMs: performance.now() - actionStarted,
			resolveMs,
			executeMs,
			observeMs,
		});
		observation = successor;

		const repeated = history.slice(-3);
		if (repeated.length === 3 && repeated.every((entry) => !entry.pageChanged && entry.operation !== "WAIT")) {
			status = "blocked";
			reason = "Three consecutive actions produced no observable page change";
			break;
		}
	}

	return {
		status,
		reason,
		steps,
		history,
		usage,
		wallMs: performance.now() - started,
		finalObservation: observation,
	};
}

async function lowerCandidate(
	candidate: JevCandidate,
	goal: string,
	observation: Observation,
	history: HistoryEntry[],
	textResolver: TextResolver | undefined,
): Promise<LoweredAction | undefined> {
	if (candidate.kind === "target") {
		if (candidate.operation !== "TYPE_TEXT") return { kind: "target", candidate, ...(candidate.value === undefined ? {} : { value: candidate.value }) };
		const value = await resolveText(candidate, "field", goal, observation, history, textResolver);
		return value ? { kind: "target", candidate, value } : undefined;
	}
	if (candidate.kind === "history") {
		return { kind: "browser", action: { type: "browser_navigate", url: candidate.operation.toLowerCase() } };
	}
	if (candidate.kind === "navigate") {
		const resolved = candidate.value ?? await resolveText(candidate, "navigation", goal, observation, history, textResolver);
		if (!resolved) return undefined;
		const url = normalizeHttpUrl(resolved);
		if (!url) throw new Error(`Navigation resolver returned an unsupported URL: ${JSON.stringify(resolved)}`);
		return { kind: "browser", action: { type: "browser_navigate", url }, value: url };
	}
	if (candidate.kind === "browser-action") {
		if (!candidate.action) throw new Error(`Candidate ${candidate.id} has no executable browser action`);
		return { kind: "browser", action: candidate.action, ...(candidate.value === undefined ? {} : { value: candidate.value }) };
	}
	return undefined;
}

async function resolveText(
	candidate: JevCandidate,
	purpose: "field" | "navigation",
	goal: string,
	observation: Observation,
	history: HistoryEntry[],
	resolver: TextResolver | undefined,
): Promise<string | null> {
	if (!resolver) throw new Error(`A text resolver is required for ${candidate.label}`);
	return resolver.resolve({ purpose, goal, candidate, observation, history });
}

function normalizeHttpUrl(value: string): string | undefined {
	const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
	try {
		const url = new URL(candidate);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

function rejectCandidates(space: JevCandidateSpace, rejected: ReadonlySet<string> | undefined): JevCandidateSpace {
	if (!rejected?.size) return space;
	const candidates = space.candidates.filter((candidate) => !rejected.has(semanticCandidateKey(candidate)));
	const byOperation = new Map<JevCandidate["operation"], JevCandidate[]>();
	const operationsByNode = new Map<number, Set<JevCandidate["operation"]>>();
	for (const candidate of candidates) {
		const operationCandidates = byOperation.get(candidate.operation) ?? [];
		operationCandidates.push(candidate);
		byOperation.set(candidate.operation, operationCandidates);
		if (candidate.target) {
			const operations = operationsByNode.get(candidate.target.node) ?? new Set<JevCandidate["operation"]>();
			operations.add(candidate.operation);
			operationsByNode.set(candidate.target.node, operations);
		}
	}
	const elements = space.elements.flatMap((element) => {
		const operations = element.operations.filter((operation) => operationsByNode.get(element.node)?.has(operation));
		return operations.length ? [{ ...element, operations }] : [];
	});
	return { candidates, byId: new Map(candidates.map((candidate) => [candidate.id, candidate])), byOperation, elements };
}

function semanticCandidateKey(candidate: JevCandidate): string {
	return `${candidate.operation}\u0000${candidate.label}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
