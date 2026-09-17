import type { BrowserAction } from "../../src/core/actions/browser";
import { buildCandidateSpace } from "./actions";
import type {
	AgentResult,
	BrowserRuntime,
	HistoryEntry,
	JevCandidate,
	JevPolicy,
	Observation,
	TextResolver,
} from "./types";

const MAX_STEPS = 60;

export async function runAgent(options: {
	goal: string;
	browser: BrowserRuntime;
	policy: JevPolicy;
	textResolver?: TextResolver;
	maxSteps?: number;
	onDecision?: (trace: AgentResult["steps"][number]) => void;
	onAction?: (trace: HistoryEntry & { latencyMs: number }) => void;
}): Promise<AgentResult> {
	const started = performance.now();
	const history: HistoryEntry[] = [];
	const steps: AgentResult["steps"] = [];
	const usage = { calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
	let observation = await options.browser.observe();
	let status: AgentResult["status"] = "blocked";
	let reason = "Step limit reached";

	for (let step = 0; step < (options.maxSteps ?? MAX_STEPS); step++) {
		const space = buildCandidateSpace(observation, options.goal, history);
		const decision = await options.policy.decide({ goal: options.goal, observation, space, history });
		usage.calls += 1;
		usage.inputTokens += decision.inputTokens;
		usage.outputTokens += decision.outputTokens;
		usage.latencyMs += decision.latencyMs;
		let candidate = space.byId.get(decision.candidateId);
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

		const fresh = await options.browser.observe();
		if (fresh.fingerprint !== observation.fingerprint) {
			const freshCandidate = buildCandidateSpace(fresh, options.goal, history).byId.get(candidate.id);
			observation = fresh;
			if (candidate.kind === "terminal" || !freshCandidate || freshCandidate.operation !== candidate.operation || freshCandidate.label !== candidate.label) {
				continue;
			}
			candidate = freshCandidate;
		}

		if (candidate.kind === "terminal") {
			status = candidate.operation === "DONE" ? "completed" : "blocked";
			reason = candidate.operation === "DONE" ? "Jev found visible completion evidence" : "Jev found no supported operation that could make progress safely";
			break;
		}

		const actionStarted = performance.now();
		let lowered: { action: BrowserAction; value?: string } | undefined;
		try {
			lowered = await lowerCandidate(candidate, options.goal, observation, history, options.textResolver);
			if (!lowered) {
				status = "blocked";
				reason = `No text value was available for ${candidate.label}`;
				break;
			}
			await options.browser.execute(lowered.action);
		} catch (error) {
			if (/stale.*ref|ref.*stale|page changed/i.test(errorMessage(error))) {
				observation = await options.browser.observe();
				continue;
			}
			status = "failed";
			reason = `Browser action failed: ${errorMessage(error)}`;
			break;
		}

		const successor = await options.browser.observe();
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
		options.onAction?.({ ...historyEntry, latencyMs: performance.now() - actionStarted });
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
): Promise<{ action: BrowserAction; value?: string } | undefined> {
	if (candidate.kind === "history") {
		return { action: { type: "browser_navigate", url: candidate.operation.toLowerCase() } };
	}
	if (candidate.kind === "navigate") {
		const resolved = candidate.value ?? await resolveText(candidate, "navigation", goal, observation, history, textResolver);
		if (!resolved) return undefined;
		const url = normalizeHttpUrl(resolved);
		if (!url) throw new Error(`Navigation resolver returned an unsupported URL: ${JSON.stringify(resolved)}`);
		return { action: { type: "browser_navigate", url }, value: url };
	}
	if (candidate.kind === "browser-action") {
		if (!candidate.action) throw new Error(`Candidate ${candidate.id} has no executable browser action`);
		return { action: candidate.action, ...(candidate.value === undefined ? {} : { value: candidate.value }) };
	}
	if (candidate.kind === "browser-step") {
		if (candidate.operation === "TYPE_TEXT") {
			const value = await resolveText(candidate, "field", goal, observation, history, textResolver);
			if (!value || !candidate.ref) return undefined;
			return {
				action: { type: "browser_act", steps: [{ type: "fill", ref: candidate.ref, value }] },
				value,
			};
		}
		if (!candidate.step) throw new Error(`Candidate ${candidate.id} has no executable browser step`);
		return { action: { type: "browser_act", steps: [candidate.step] }, ...(candidate.value === undefined ? {} : { value: candidate.value }) };
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
