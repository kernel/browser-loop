import type { CuaBrowserExpectation } from "@onkernel/cua-ai";
import { observedNodes, staticTextRun, type AXNode, type BrowserObservation } from "./browser-observation";
import type { BrowserExpectationEvidence, BrowserWaitForResult, BrowserWaitReason } from "./types";

/** Internal expectation truth and optional lifecycle reason. */
export interface BrowserExpectationEvaluation extends BrowserExpectationEvidence {
	reason?: BrowserWaitReason;
}

type RefExpectation = Extract<CuaBrowserExpectation, { type: "ref" }>;
/** Resolve a ref expectation against one structured observation. */
export type BrowserRefResolver = (expectation: RefExpectation, observation: BrowserObservation) => BrowserExpectationEvaluation;

/** Browser capabilities required by the semantic wait engine. */
export interface BrowserWaitRuntime {
	selectTarget(tabId?: string): Promise<string>;
	observeTarget(targetId: string): Promise<BrowserObservation>;
	dialogCount(): number;
	targetExists(targetId: string): Promise<boolean>;
	/** Reserved for runtimes that expose generation checks outside observations. */
	liveGeneration?(frameId: string): number;
	resolveRef: BrowserRefResolver;
	now?(): number;
	delay?(ms: number): Promise<void>;
}

/** Timeout, polling, target, and condition options for a semantic wait. */
export interface BrowserWaitOptions {
	expect: CuaBrowserExpectation;
	timeoutMs?: number;
	pollMs?: number;
	tabId?: string;
}

function expectationNodes(observation: BrowserObservation): AXNode[] {
	const nodes = [...observedNodes(observation)].map(({ node }) => node);
	for (const tree of [observation.tree, ...observation.stitches.values()]) {
		for (const node of tree.byId.values()) {
			const children = node.childIds ?? [];
			for (let index = 0; index < children.length; index += 1) {
				const run = staticTextRun(tree.byId, children, index);
				if (run) { nodes.push(run.node); index = run.end; }
			}
		}
	}
	return nodes;
}

/** Evaluate a semantic condition without minting refs. Unknown means the observation cannot prove the claim. */
export function evaluateBrowserExpectation(
	expectation: CuaBrowserExpectation,
	observation: BrowserObservation,
	baseline: BrowserObservation,
	resolveRef: BrowserRefResolver,
): BrowserExpectationEvaluation {
	if ("all" in expectation || "any" in expectation) {
		const all = "all" in expectation;
		const children = (all ? expectation.all : expectation.any).map((child) => evaluateBrowserExpectation(child, observation, baseline, resolveRef));
		const truth = all
			? children.some((child) => child.truth === false) ? false : children.some((child) => child.truth === undefined) ? undefined : true
			: children.some((child) => child.truth === true) ? true : children.some((child) => child.truth === undefined) ? undefined : false;
		return {
			truth,
			details: children.flatMap((child) => child.details),
			...(truth === undefined ? { reason: children.find((child) => child.truth === undefined)?.reason } : {}),
		};
	}
	if (expectation.type === "text" || expectation.type === "role_name") {
		const found = expectationNodes(observation).some((node) => !node.ignored && (expectation.type === "text"
			? (node.name?.value ?? "").replace(/\s+/g, " ").toLowerCase().includes(expectation.text.replace(/\s+/g, " ").toLowerCase())
			: (expectation.role === undefined || node.role?.value === expectation.role) && (expectation.name === undefined || node.name?.value === expectation.name)));
		const expected = expectation.exists ?? true;
		const complete = observation.incompleteFrames.length === 0;
		const truth = !found && !complete ? undefined : found === expected;
		return { truth, details: [`${expectation.type} ${found ? "present" : "absent"}${complete ? "" : "; observation incomplete"}`], ...(!complete && !found ? { reason: "incomplete_observation" as const } : {}) };
	}
	if (expectation.type === "url" || expectation.type === "title") {
		const value = observation[expectation.type];
		const initial = baseline[expectation.type];
		const truth = (expectation.equals === undefined || value === expectation.equals) &&
			(expectation.contains === undefined || value.includes(expectation.contains)) &&
			(expectation.changed === undefined || (value !== initial) === expectation.changed);
		return { truth, details: [`${expectation.type}=${JSON.stringify(value)}`] };
	}
	if (expectation.type === "ref") return resolveRef(expectation, observation);
	return { truth: undefined, details: ["unsupported expectation"] };
}

/** Poll a semantic browser condition; in-flight browser reads settle before timeout is reported. */
export async function waitForBrowserExpectation(runtime: BrowserWaitRuntime, options: BrowserWaitOptions): Promise<BrowserWaitForResult> {
	const now = runtime.now ?? Date.now;
	const sleep = runtime.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const started = now();
	const timeout = options.timeoutMs ?? 2_000;
	const poll = options.pollMs ?? 50;
	const remaining = () => Math.max(0, timeout - (now() - started));
	const expired = () => now() - started >= timeout;
	let targetId: string;
	let baseline: BrowserObservation;
	try {
		targetId = await beforeDeadline(() => runtime.selectTarget(options.tabId), remaining(), now);
		if (expired()) return timedOut(started, now());
		baseline = await runtime.observeTarget(targetId);
	} catch (error) {
		if (error instanceof WaitDeadlineError) return timedOut(started, now());
		return failedObservation(started, now(), error);
	}
	const initial = evaluateBrowserExpectation(options.expect, baseline, baseline, runtime.resolveRef);
	if (initial.reason === "stale_ref" && !("any" in options.expect)) {
		return terminal("interrupted", "unverifiable", initial, initial, started, now(), initial.reason);
	}
	if (expired()) return timedOut(started, now(), initial, initial);
	if (initial.truth === true) return terminal("satisfied", "preexisting", initial, initial, started, now());
	const dialogs = runtime.dialogCount();
	let final = initial;
	while (!expired()) {
		await sleep(Math.min(poll, remaining()));
		if (expired()) break;
		let exists: boolean;
		try { exists = await beforeDeadline(() => runtime.targetExists(targetId), remaining(), now); }
		catch (error) { if (error instanceof WaitDeadlineError) break; return failedObservation(started, now(), error, initial, final); }
		if (expired()) break;
		if (!exists) return terminal("interrupted", "unverifiable", initial, final, started, now(), "target_detached");
		let observation: BrowserObservation;
		try { observation = await runtime.observeTarget(targetId); }
		catch (error) { return failedObservation(started, now(), error, initial, final); }
		final = evaluateBrowserExpectation(options.expect, observation, baseline, runtime.resolveRef);
		if (observation.targetId !== targetId) return terminal("interrupted", "unverifiable", initial, final, started, now(), "target_changed");
		if (runtime.dialogCount() > dialogs) return terminal("interrupted", "unverifiable", initial, final, started, now(), "dialog");
		const crossDocumentNavigation = observation.generations.get(targetId) !== baseline.generations.get(targetId);
		const sameDocumentNavigation = observation.navigationEpoch !== baseline.navigationEpoch;
		const locationExpectation = containsLocationExpectation(options.expect);
		if (crossDocumentNavigation && !locationExpectation) {
			return terminal("interrupted", "unverifiable", initial, final, started, now(), "navigation");
		}
		if (final.reason === "stale_ref" && !("any" in options.expect)) {
			return terminal("interrupted", "unverifiable", initial, final, started, now(), final.reason);
		}
		if ((crossDocumentNavigation || sameDocumentNavigation) && locationExpectation) {
			if (final.truth === true && !expired()) return terminal("satisfied", "newly_verified", initial, final, started, now());
			continue;
		}
		if (expired()) break;
		if (final.truth === true) return terminal("satisfied", "newly_verified", initial, final, started, now());
		if (observation.incompleteFrames.length > 0) {
			final = { ...final, truth: undefined, reason: final.reason ?? "incomplete_observation" };
			continue;
		}
	}
	if (final.truth === undefined) return terminal("unverifiable", "unverifiable", initial, final, started, now(), final.reason ?? "incomplete_observation");
	return terminal("timed_out", "failed", initial, final, started, now());
}

class WaitDeadlineError extends Error {}

async function beforeDeadline<T>(operation: () => Promise<T>, remaining: number, now: () => number): Promise<T> {
	if (remaining <= 0) throw new WaitDeadlineError();
	const started = now();
	try {
		const result = await operation();
		if (Number.isFinite(remaining) && now() - started >= remaining) throw new WaitDeadlineError();
		return result;
	} catch (error) {
		if (error instanceof WaitDeadlineError || Number.isFinite(remaining) && now() - started >= remaining) throw new WaitDeadlineError();
		throw error;
	}
}

function containsLocationExpectation(expectation: CuaBrowserExpectation): boolean {
	if ("all" in expectation) return expectation.all.some(containsLocationExpectation);
	if ("any" in expectation) return expectation.any.some(containsLocationExpectation);
	return expectation.type === "url" || expectation.type === "title";
}

function timedOut(
	started: number,
	ended: number,
	initial: BrowserExpectationEvidence = { truth: undefined, details: [] },
	final: BrowserExpectationEvidence = initial,
): BrowserWaitForResult {
	return terminal("timed_out", "failed", initial, final, started, ended);
}

function terminal(status: BrowserWaitForResult["status"], evidence: BrowserWaitForResult["evidence"], initial: BrowserExpectationEvidence, final: BrowserExpectationEvidence, started: number, ended: number, reason?: BrowserWaitReason): BrowserWaitForResult {
	return { status, evidence, initial, final, elapsed_ms: Math.max(0, ended - started), ...(reason ? { reason } : {}), details: [...initial.details.map((detail) => `initial: ${detail}`), ...final.details.map((detail) => `final: ${detail}`)] };
}

function failedObservation(started: number, ended: number, error: unknown, initial: BrowserExpectationEvidence = { truth: undefined, details: [] }, final = initial): BrowserWaitForResult {
	const message = error instanceof Error ? error.message : String(error);
	return { ...terminal("unverifiable", "unverifiable", initial, final, started, ended, "observation_failed"), details: [...initial.details, message] };
}
