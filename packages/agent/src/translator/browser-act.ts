import type { CuaActionBrowserAct, CuaActionBrowserSnapshot, CuaBrowserActStep, CuaBrowserExpectation } from "@onkernel/cua-ai";
import { diffObservations, type BrowserObservation, type BrowserPresentation } from "./browser-observation";
import type { BrowserExpectationEvaluation } from "./browser-wait";
import type { BrowserActExpectationEvidence, BrowserActResult, BrowserActStepResult, BrowserWaitForResult } from "./types";

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

export async function runBrowserAct(action: CuaActionBrowserAct, runtime: BrowserActRuntime): Promise<BrowserActResult> {
	const deadline = new ActionDeadline(action.timeout_ms ?? 2_000);
	let baseline: BrowserObservation;
	let current: BrowserObservation;
	let targets: string[];
	try {
		baseline = current = await deadline.run(() => runtime.observe(action.tab_id));
		if (!baseline.complete) throw new Error("baseline observation incomplete");
		targets = await deadline.run(() => runtime.targetIds());
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
		let before: BrowserObservation;
		let nextTargets: string[];
		try {
			before = await deadline.run(() => runtime.observe(action.tab_id));
			nextTargets = await deadline.run(() => runtime.targetIds());
		} catch (error) {
			steps.push(stepResult(index, step, "unknown", [`pre-action observation failed: ${message(error)}`]));
			stoppedAt = index; stopReason = "control_flow"; break;
		}
		const preBoundary = boundary(current, before, targets, nextTargets, dialogs, runtime);
		current = before; targets = nextTargets; dialogs = runtime.dialogCount();
		if (!before.complete || preBoundary) {
			const reason = before.complete ? `${preBoundary} detected before action` : "pre-action observation incomplete";
			steps.push(stepResult(index, step, "unknown", [reason]));
			stoppedAt = index; stopReason = preBoundary ?? "control_flow"; break;
		}

		const evidence: string[] = [];
		let actionError: unknown;
		try {
			await deadline.run(() => runtime.executeStep(step, action.tab_id), step.type !== "wait");
			evidence.push("action dispatched");
		} catch (error) {
			actionError = error;
			evidence.push(message(error));
		}

		let expectation: BrowserActExpectationEvidence | undefined;
		let waitResult: BrowserWaitForResult | undefined;
		let after: BrowserObservation | undefined;
		let afterTargets: string[] | undefined;
		try {
			if (step.expect) {
				waitResult = await deadline.run(() => runtime.wait(step.expect!, before, before.targetId, action.tab_id, deadline.remaining(), action.poll_ms));
				expectation = expectationEvidence(waitResult);
			}
			after = await deadline.run(() => runtime.observe(action.tab_id));
			afterTargets = await deadline.run(() => runtime.targetIds());
		} catch (error) {
			if (error instanceof ActionDeadlineError) timedOut = true;
			evidence.push(`post-action observation failed: ${message(error)}`);
		}

		const deadlineExceeded = actionError instanceof ActionDeadlineError;
		timedOut ||= deadlineExceeded || waitResult?.status === "timed_out";
		const stale = isStale(actionError) || waitResult?.reason === "stale_ref" || expectation?.status === "unverifiable" && expectation.details.some((line) => /stale_ref| is stale/i.test(line));
		const outcome = expectation?.status === "newly_verified" && !actionError ? "worked" : expectation?.status === "failed" || stale ? "didnt" : "unknown";
		if (expectation) evidence.push(`expectation ${expectation.status}`);
		steps.push(stepResult(index, step, outcome, evidence, expectation));

		const postBoundary = after && afterTargets ? boundary(before, after, targets, afterTargets, dialogs, runtime) : undefined;
		if (after && afterTargets) { current = after; targets = afterTargets; dialogs = runtime.dialogCount(); }
		stopReason = (!after?.complete ? "control_flow" : undefined)
			?? postBoundary
			?? waitStopReason(waitResult)
			?? (deadlineExceeded ? "control_flow"
				: stale ? "stale_ref"
				: actionError ? "action_failed"
					: expectation?.status === "failed" ? "expectation_failed"
						: expectation?.status === "preexisting" || expectation?.status === "unverifiable" || !after ? "control_flow" : undefined);
		if (stopReason) { stoppedAt = index; break; }
	}

	let finalExpectation: BrowserActExpectationEvidence | undefined;
	const terminalNavigation = stopReason === "navigation" && stoppedAt === action.steps.length - 1 && steps.at(-1)?.outcome === "worked";
	if (action.expect && (!stopReason || terminalNavigation)) {
		try {
			const result = await deadline.run(() => runtime.wait(action.expect!, baseline, baseline.targetId, action.tab_id, deadline.remaining(), action.poll_ms));
			finalExpectation = expectationEvidence(result);
			timedOut ||= result.status === "timed_out";
			if (finalExpectation.status === "failed") { stopReason = "expectation_failed"; stoppedAt = action.steps.length; }
			else if (finalExpectation.status === "unverifiable") { stopReason = waitStopReason(result) ?? "control_flow"; stoppedAt = action.steps.length; }
		} catch (error) {
			timedOut ||= error instanceof ActionDeadlineError;
			finalExpectation = { status: "unverifiable", details: [message(error)] };
			stopReason = "control_flow"; stoppedAt = action.steps.length;
		}
	}

	let successor: BrowserActResult["successor"] | undefined;
	let successorError: unknown;
	for (let attempt = 0; attempt < 3 && !successor; attempt += 1) {
		try {
			const observed = await deadline.run(() => runtime.observe(action.tab_id));
			const successorTargets = await deadline.run(() => runtime.targetIds());
			const lateBoundary = boundary(current, observed, targets, successorTargets, dialogs, runtime);
			current = observed; targets = successorTargets; dialogs = runtime.dialogCount();
			if (lateBoundary) {
				stopReason ??= lateBoundary;
				stoppedAt ??= action.steps.length;
				successorError = new Error(`${lateBoundary} changed successor observation`);
				continue;
			}
			if (!observed.complete) throw new Error("successor observation incomplete");
			if (action.expect && finalExpectation && finalExpectation.status !== "failed") {
				const evaluation = runtime.evaluate(action.expect, observed, baseline);
				finalExpectation = {
					status: evaluation.truth === true ? finalExpectation.before === true ? "preexisting" : "newly_verified" : evaluation.truth === false ? "failed" : "unverifiable",
					before: finalExpectation.before, after: evaluation.truth,
					details: [...finalExpectation.details, ...evaluation.details.map((detail) => `successor: ${detail}`)],
				};
				if (evaluation.truth !== true) {
					stopReason = evaluation.truth === false ? "expectation_failed" : "control_flow";
					stoppedAt = action.steps.length;
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
		}
	}
	if (!successor) successor = { status: "unavailable", error: message(successorError ?? new Error("successor observation unavailable")) };

	const failed = steps.some((step) => step.outcome === "didnt") || finalExpectation?.status === "failed";
	const verified = action.expect
		? finalExpectation?.status === "newly_verified"
		: steps.length === action.steps.length && steps.every((step) => step.outcome === "worked");
	const verifiedNavigation = stopReason === "navigation" && steps.length === action.steps.length && steps.at(-1)?.outcome === "worked";
	return {
		outcome: failed ? "didnt" : !timedOut && verified && (!stopReason || verifiedNavigation) ? "worked" : "unknown",
		steps,
		...(stoppedAt === undefined ? {} : { stopped_at: stoppedAt }),
		...(stopReason ? { stop_reason: stopReason } : {}),
		...(finalExpectation ? { final_expectation: finalExpectation } : {}),
		successor,
	};
}

class ActionDeadline {
	private readonly expiresAt: number;

	constructor(timeoutMs: number) { this.expiresAt = Date.now() + timeoutMs; }

	remaining(): number { return Math.max(0, this.expiresAt - Date.now()); }

	async run<T>(start: () => Promise<T>, settle = false): Promise<T> {
		const remaining = this.remaining();
		if (remaining <= 0) throw new ActionDeadlineError();
		if (settle) {
			let result: T;
			try { result = await start(); }
			catch (error) { if (this.remaining() <= 0) throw new ActionDeadlineError(); throw error; }
			if (this.remaining() <= 0) throw new ActionDeadlineError();
			return result;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				start(),
				new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ActionDeadlineError()), remaining); }),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}

class ActionDeadlineError extends Error {
	constructor() { super("browser_act deadline exceeded"); }
}

function expectationEvidence(result: BrowserWaitForResult): BrowserActExpectationEvidence {
	return { status: result.evidence, before: result.initial.truth, after: result.final.truth, details: result.details };
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

function stepResult(index: number, step: CuaBrowserActStep, outcome: BrowserActStepResult["outcome"], evidence: string[], expectation?: BrowserActExpectationEvidence): BrowserActStepResult {
	return { index, type: step.type, outcome, evidence, ...(expectation ? { expectation } : {}) };
}

function unavailable(error: unknown, stoppedAt: number): BrowserActResult {
	return { outcome: "unknown", steps: [], stopped_at: stoppedAt, stop_reason: "control_flow", successor: { status: "unavailable", error: message(error) } };
}

function isStale(error: unknown): boolean {
	return !!error && /(?:stale.*ref|ref.*stale)/i.test(message(error));
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
