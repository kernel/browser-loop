import type { CuaActionBrowserAct, CuaActionBrowserSnapshot, CuaBrowserActStep, CuaBrowserExpectation } from "@onkernel/cua-ai";
import { diffObservations, type BrowserObservation, type BrowserPresentation } from "./browser-observation";
import type { BrowserExpectationEvaluation } from "./browser-wait";
import type { BrowserActExpectationEvidence, BrowserActResult, BrowserActStepResult, BrowserWaitForResult } from "./types";

const DEFAULT_ACT_TIMEOUT_MS = 30_000;
type ActTimeoutReason = "global_timeout" | "step_timeout";
type ActDeadline = { at: number; reason: ActTimeoutReason };

class BrowserActDeadlineError extends Error {
	constructor(readonly reason: ActTimeoutReason) {
		super(reason === "global_timeout" ? "browser action plan timed out" : "browser action step timed out");
	}
}

/**
 * Narrow adapter between plan policy and browser mechanics. Implementations own live
 * target/ref/CDP state; the orchestrator owns sequencing, deadlines, attribution, and
 * stop decisions. `observe` is intentionally a full fenced AX observation: one baseline
 * plus pre/post observations around steps make causal claims safer, but are not cheap.
 */
export interface BrowserActRuntime {
	observe(tabId?: string): Promise<BrowserObservation>;
	targetIds(): Promise<string[]>;
	dialogCount(): number;
	liveGeneration(frameId: string): number;
	liveNavigationEpoch(targetId: string): number;
	executeStep(step: CuaBrowserActStep, tabId?: string): Promise<void>;
	wait(expect: CuaBrowserExpectation, baseline: BrowserObservation, targetId: string, tabId?: string, timeoutMs?: number, pollMs?: number): Promise<BrowserWaitForResult>;
	evaluate(expect: CuaBrowserExpectation, observation: BrowserObservation, baseline: BrowserObservation): BrowserExpectationEvaluation;
	present(observation: BrowserObservation, action: CuaActionBrowserSnapshot): BrowserPresentation;
	render(presentation: BrowserPresentation): string;
}

/**
 * Execute a dependent action plan and derive causal outcomes, stop reasons, and a stable
 * successor. Expectations are evaluated against observations captured before input; a
 * condition already matched before input is `preexisting`, never proof that input worked.
 */
export async function runBrowserAct(action: CuaActionBrowserAct, runtime: BrowserActRuntime): Promise<BrowserActResult> {
	const finalStepIndex = action.steps.length - 1;
	const globalDeadline: ActDeadline = { at: Date.now() + (action.timeout_ms ?? DEFAULT_ACT_TIMEOUT_MS), reason: "global_timeout" };
	let baseline: BrowserObservation;
	let current: BrowserObservation;
	let targets: string[];
	try {
		baseline = current = await beforeDeadline(() => runtime.observe(action.tab_id), globalDeadline);
		if (!isComplete(baseline)) throw new Error("baseline observation incomplete");
		targets = await beforeDeadline(() => runtime.targetIds(), globalDeadline);
	} catch (error) {
		return unavailable(error, 0);
	}
	let dialogs = runtime.dialogCount();
	const steps: BrowserActStepResult[] = [];
	let stoppedAt: number | undefined;
	let stopReason: BrowserActResult["stop_reason"];
	let timedOut = false;

	for (let index = 0; index < action.steps.length; index += 1) {
		const step = action.steps[index]!;
		const deadline = stepDeadline(step, globalDeadline);
		let before: BrowserObservation;
		let nextTargets: string[];
		try {
			before = await beforeDeadline(() => runtime.observe(action.tab_id), deadline);
			nextTargets = await beforeDeadline(() => runtime.targetIds(), deadline);
		} catch (error) {
			const timeout = timeoutReason(error);
			steps.push(stepResult(index, step, "unknown", [timeout ? message(error) : `pre-action observation failed: ${message(error)}`]));
			timedOut ||= timeout !== undefined;
			stoppedAt = index; stopReason = timeout ?? "control_flow"; break;
		}
		const preBoundary = boundary(current, before, targets, nextTargets, dialogs, runtime);
		current = before; targets = nextTargets; dialogs = runtime.dialogCount();
		if (!isComplete(before) || preBoundary) {
			const reason = isComplete(before) ? `${preBoundary} detected before action` : "pre-action observation incomplete";
			steps.push(stepResult(index, step, "unknown", [reason]));
			stoppedAt = index; stopReason = preBoundary ?? "control_flow"; break;
		}

		const diagnostics: string[] = [];
		let actionError: unknown;
		let timeout: ActTimeoutReason | undefined;
		try {
			await beforeDeadline(() => runtime.executeStep(step, action.tab_id), deadline);
			diagnostics.push("action dispatched");
		} catch (error) {
			actionError = error;
			timeout = timeoutReason(error);
			diagnostics.push(message(error));
		}

		let expectation: BrowserActExpectationEvidence | undefined;
		let waitResult: BrowserWaitForResult | undefined;
		let after: BrowserObservation | undefined;
		let afterTargets: string[] | undefined;
		if (!timeout) {
			try {
				if (step.expect) {
					waitResult = await beforeDeadline(
						() => runtime.wait(step.expect!, before, before.targetId, action.tab_id, remaining(deadline), action.poll_ms),
						deadline,
					);
					expectation = expectationEvidence(waitResult);
					if (waitResult.status === "timed_out" && expectation.status !== "failed") timeout = deadline.reason;
				}
				if (!timeout) {
					after = await beforeDeadline(() => runtime.observe(action.tab_id), deadline);
					afterTargets = await beforeDeadline(() => runtime.targetIds(), deadline);
				}
			} catch (error) {
				timeout = timeoutReason(error);
				diagnostics.push(timeout ? message(error) : `post-action observation failed: ${message(error)}`);
			}
		}

		timedOut ||= timeout !== undefined;
		const stale = isStale(actionError) || waitResult?.reason === "stale_ref" || expectation?.status === "unverifiable" && expectation.reason === "stale_ref";
		const outcome = stepOutcome(expectation, actionError, stale);
		if (expectation) diagnostics.push(`expectation ${expectation.status}`);
		steps.push(stepResult(index, step, outcome, diagnostics, expectation));

		const postBoundary = after && afterTargets ? boundary(before, after, targets, afterTargets, dialogs, runtime) : undefined;
		if (after && afterTargets) { current = after; targets = afterTargets; dialogs = runtime.dialogCount(); }
		stopReason = timeout
			?? (stale
				? "stale_ref"
				: expectation?.status === "failed"
					? "expectation_failed"
					: actionError
						? "action_failed"
						: waitStopReason(waitResult)
							?? postBoundary
							?? (!after || !isComplete(after) || expectation?.status === "preexisting" || expectation?.status === "unverifiable" ? "control_flow" : undefined));
		if (stopReason) { stoppedAt = index; break; }
	}

	let finalExpectation: BrowserActExpectationEvidence | undefined;
	const terminalNavigation = stopReason === "navigation" && stoppedAt === finalStepIndex;
	if (action.expect && (!stopReason || terminalNavigation)) {
		try {
			const result = await beforeDeadline(
				() => runtime.wait(action.expect!, baseline, baseline.targetId, action.tab_id, remaining(globalDeadline), action.poll_ms),
				globalDeadline,
			);
			finalExpectation = expectationEvidence(result);
			timedOut ||= result.status === "timed_out";
			if (result.status === "timed_out") { stopReason = "global_timeout"; stoppedAt = finalStepIndex; }
			else if (finalExpectation.status === "failed") { stopReason = "expectation_failed"; stoppedAt = finalStepIndex; }
			else if (finalExpectation.status === "unverifiable") { stopReason = waitStopReason(result) ?? "control_flow"; stoppedAt = finalStepIndex; }
		} catch (error) {
			const timeout = timeoutReason(error);
			finalExpectation = unverifiableEvidence(runtime.evaluate(action.expect, baseline, baseline), message(error));
			timedOut ||= timeout !== undefined;
			stopReason = timeout ?? "control_flow"; stoppedAt = finalStepIndex;
		}
	}

	let successor: BrowserActResult["successor"] | undefined;
	let successorError: unknown;
	if (stopReason === "global_timeout") {
		successor = { status: "unavailable", error: "browser action plan timed out" };
	}
	for (let attempt = 0; attempt < 3 && !successor; attempt += 1) {
		try {
			const observed = await beforeDeadline(() => runtime.observe(action.tab_id), globalDeadline);
			const successorTargets = await beforeDeadline(() => runtime.targetIds(), globalDeadline);
			const lateBoundary = boundary(current, observed, targets, successorTargets, dialogs, runtime);
			current = observed; targets = successorTargets; dialogs = runtime.dialogCount();
			if (lateBoundary) {
				stopReason ??= lateBoundary;
				successorError = new Error(`${lateBoundary} changed successor observation`);
				continue;
			}
			if (!isComplete(observed)) throw new Error("successor observation incomplete");
			if (action.expect && finalExpectation && finalExpectation.status !== "failed") {
				const evaluation = runtime.evaluate(action.expect, observed, baseline);
				finalExpectation = evidenceFromEvaluation(
					finalExpectation.before,
					evaluation,
					[...finalExpectation.diagnostics, ...evaluation.details.map((detail) => `successor: ${detail}`)],
				);
				if (evaluation.truth !== true) {
					stopReason = evaluation.truth === false ? "expectation_failed" : "control_flow";
					stoppedAt = finalStepIndex;
				} else if (stopReason === "control_flow" && stoppedAt === finalStepIndex) {
					stopReason = undefined;
					stoppedAt = undefined;
				}
			}
			const complete: CuaActionBrowserSnapshot = { type: "browser_snapshot", tab_id: action.tab_id, depth: Number.MAX_SAFE_INTEGER };
			const presentation = runtime.present(observed, { type: "browser_snapshot", tab_id: action.tab_id, ...action.successor });
			successor = {
				status: "observed",
				text: runtime.render(presentation),
				url: observed.url,
				title: observed.title,
				diff: diffObservations(runtime.present(baseline, complete), runtime.present(observed, complete)),
			};
		} catch (error) {
			successorError = error;
			if (timeoutReason(error)) break;
		}
	}
	if (!successor) successor = { status: "unavailable", error: message(successorError ?? new Error("successor observation unavailable")) };

	return {
		outcome: planOutcome(action, steps, finalExpectation, timedOut, stopReason),
		steps,
		...(stoppedAt === undefined ? {} : { stopped_at: stoppedAt }),
		...(stopReason ? { stop_reason: stopReason } : {}),
		...(finalExpectation ? { final_expectation: finalExpectation } : {}),
		successor,
	};
}

/** A step works only when acknowledged input has newly established its postcondition. */
function stepOutcome(expectation: BrowserActExpectationEvidence | undefined, actionError: unknown, stale: boolean): BrowserActStepResult["outcome"] {
	if (expectation?.status === "failed" || stale) return "didnt";
	if (expectation?.status === "newly_verified" && !actionError) return "worked";
	return "unknown";
}

/**
 * A plan works when its final condition was newly established, or—without a final
 * condition—every step independently worked. Definitive failure wins; all uncertainty,
 * preexisting evidence, missing expectations, timeouts, and unsafe stops remain unknown.
 */
function planOutcome(
	action: CuaActionBrowserAct,
	steps: readonly BrowserActStepResult[],
	finalExpectation: BrowserActExpectationEvidence | undefined,
	timedOut: boolean,
	stopReason: BrowserActResult["stop_reason"],
): BrowserActResult["outcome"] {
	if (steps.some((step) => step.outcome === "didnt") || finalExpectation?.status === "failed") return "didnt";
	if (timedOut) return "unknown";
	const verified = action.expect
		? finalExpectation?.status === "newly_verified"
		: steps.length === action.steps.length && steps.every((step) => step.outcome === "worked");
	const verifiedNavigation = stopReason === "navigation" && steps.length === action.steps.length
		&& (steps.at(-1)?.outcome === "worked" || finalExpectation?.status === "newly_verified");
	return verified && (!stopReason || verifiedNavigation) ? "worked" : "unknown";
}

function stepDeadline(step: CuaBrowserActStep, globalDeadline: ActDeadline): ActDeadline {
	if (step.timeout_ms === undefined) return globalDeadline;
	const at = Date.now() + step.timeout_ms;
	return at < globalDeadline.at ? { at, reason: "step_timeout" } : globalDeadline;
}

function remaining(deadline: ActDeadline): number {
	return Math.max(0, deadline.at - Date.now());
}

function beforeDeadline<T>(operation: () => Promise<T>, deadline: ActDeadline): Promise<T> {
	const timeoutMs = remaining(deadline);
	if (timeoutMs <= 0) return Promise.reject(new BrowserActDeadlineError(deadline.reason));
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new BrowserActDeadlineError(deadline.reason)), timeoutMs);
		void Promise.resolve()
			.then(operation)
			.then(
				(value) => { clearTimeout(timer); resolve(value); },
				(error: unknown) => { clearTimeout(timer); reject(error); },
			);
	});
}

function timeoutReason(error: unknown): ActTimeoutReason | undefined {
	return error instanceof BrowserActDeadlineError ? error.reason : undefined;
}

function isComplete(observation: BrowserObservation): boolean {
	return observation.incompleteFrames.length === 0;
}

function expectationEvidence(result: BrowserWaitForResult): BrowserActExpectationEvidence {
	const before = expectationState(result.initial.truth);
	const diagnostics = result.details;
	if (result.evidence === "newly_verified" && before !== "matched" && result.final.truth === true) {
		return { status: "newly_verified", before, after: "matched", diagnostics };
	}
	if (result.evidence === "preexisting" && before === "matched" && result.final.truth === true) {
		return { status: "preexisting", before, after: "matched", diagnostics };
	}
	if (result.evidence === "failed" && result.final.truth === false) {
		return { status: "failed", before, after: "not_matched", diagnostics };
	}
	return {
		status: "unverifiable",
		before,
		after: "unknown",
		diagnostics,
		...(result.reason ? { reason: result.reason } : {}),
	};
}

function evidenceFromEvaluation(
	before: BrowserActExpectationEvidence["before"],
	evaluation: BrowserExpectationEvaluation,
	diagnostics: string[],
): BrowserActExpectationEvidence {
	if (evaluation.truth === true) {
		return before === "matched"
			? { status: "preexisting", before, after: "matched", diagnostics }
			: { status: "newly_verified", before, after: "matched", diagnostics };
	}
	if (evaluation.truth === false) return { status: "failed", before, after: "not_matched", diagnostics };
	return { status: "unverifiable", before, after: "unknown", diagnostics, ...(evaluation.reason ? { reason: evaluation.reason } : {}) };
}

function unverifiableEvidence(before: BrowserExpectationEvaluation, diagnostic: string): BrowserActExpectationEvidence {
	return {
		status: "unverifiable",
		before: expectationState(before.truth),
		after: "unknown",
		diagnostics: [...before.details, diagnostic],
		...(before.reason ? { reason: before.reason } : {}),
	};
}

function expectationState(truth: boolean | undefined): BrowserActExpectationEvidence["before"] {
	return truth === true ? "matched" : truth === false ? "not_matched" : "unknown";
}

function boundary(before: BrowserObservation, after: BrowserObservation, oldTargets: readonly string[], newTargets: readonly string[], dialogs: number, runtime: BrowserActRuntime): BrowserActResult["stop_reason"] {
	if (runtime.dialogCount() > dialogs) return "dialog";
	if (oldTargets.length !== newTargets.length || oldTargets.some((id, index) => id !== newTargets[index])) return "control_flow";
	if (before.targetId !== after.targetId || before.navigationEpoch !== after.navigationEpoch || runtime.liveNavigationEpoch(after.targetId) !== after.navigationEpoch) return "navigation";
	if (before.generations.size !== after.generations.size) return "navigation";
	for (const [frame, generation] of after.generations) {
		if (runtime.liveGeneration(frame) !== generation || before.generations.get(frame) !== generation) return "navigation";
	}
	return undefined;
}

function waitStopReason(result?: BrowserWaitForResult): BrowserActResult["stop_reason"] {
	if (!result?.reason) return undefined;
	if (result.reason === "navigation" || result.reason === "dialog" || result.reason === "stale_ref") return result.reason;
	return "control_flow";
}

function stepResult(index: number, step: CuaBrowserActStep, outcome: BrowserActStepResult["outcome"], diagnostics: string[], expectation?: BrowserActExpectationEvidence): BrowserActStepResult {
	return { index, type: step.type, outcome, diagnostics, ...(expectation ? { expectation } : {}) };
}

function unavailable(error: unknown, stoppedAt: number): BrowserActResult {
	return { outcome: "unknown", steps: [], stopped_at: stoppedAt, stop_reason: timeoutReason(error) ?? "control_flow", successor: { status: "unavailable", error: message(error) } };
}

function isStale(error: unknown): boolean {
	return !!error && /(?:stale.*ref|ref.*stale)/i.test(message(error));
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
