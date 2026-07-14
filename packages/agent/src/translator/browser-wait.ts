import type { CuaBrowserExpectation } from "@onkernel/cua-ai";
import { staticTextRun, type AXNode, type BrowserObservation } from "./browser-observation";
import type { BrowserExpectationEvidence, BrowserWaitForResult, BrowserWaitReason } from "./types";

export interface BrowserExpectationEvaluation extends BrowserExpectationEvidence {
	reason?: BrowserWaitReason;
}

type RefExpectation = Extract<CuaBrowserExpectation, { type: "ref" }>;
export type BrowserRefResolver = (expectation: RefExpectation, observation: BrowserObservation) => BrowserExpectationEvaluation;

export interface BrowserWaitRuntime {
	selectTarget(tabId?: string): Promise<string>;
	observeTarget(targetId: string): Promise<BrowserObservation>;
	dialogCount(): number;
	targetExists(targetId: string): Promise<boolean>;
	liveGeneration(frameId: string): number;
	resolveRef: BrowserRefResolver;
	now?(): number;
	delay?(ms: number): Promise<void>;
}

export interface BrowserWaitOptions {
	expect: CuaBrowserExpectation;
	timeoutMs?: number;
	pollMs?: number;
	tabId?: string;
}

function expectationNodes(observation: BrowserObservation): AXNode[] {
	const nodes = observation.nodes.map(({ node }) => node);
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
		const truth = !found && !observation.complete ? undefined : found === expected;
		return { truth, details: [`${expectation.type} ${found ? "present" : "absent"}${observation.complete ? "" : "; observation incomplete"}`], ...(!observation.complete && !found ? { reason: "incomplete_observation" as const } : {}) };
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
		targetId = await beforeDeadline(runtime.selectTarget(options.tabId), remaining());
		if (expired()) return timedOut(started, now());
		baseline = await beforeDeadline(runtime.observeTarget(targetId), remaining());
		if (expired()) return timedOut(started, now());
	} catch (error) {
		if (error instanceof WaitDeadlineError) return timedOut(started, now());
		return failedObservation(started, now(), error);
	}
	const initial = evaluateBrowserExpectation(options.expect, baseline, baseline, runtime.resolveRef);
	if (expired()) return timedOut(started, now());
	if (initial.reason === "stale_ref") return terminal("interrupted", "unverifiable", initial, initial, started, now(), initial.reason);
	if (initial.truth === true) return terminal("satisfied", "preexisting", initial, initial, started, now());
	const dialogs = runtime.dialogCount();
	let final = initial;
	while (!expired()) {
		await sleep(Math.min(poll, remaining()));
		if (expired()) break;
		let exists: boolean;
		try { exists = await beforeDeadline(runtime.targetExists(targetId), remaining()); }
		catch (error) { if (error instanceof WaitDeadlineError) break; return failedObservation(started, now(), error, initial, final); }
		if (expired()) break;
		if (!exists) return terminal("interrupted", "unverifiable", initial, final, started, now(), "target_detached");
		let observation: BrowserObservation;
		try { observation = await beforeDeadline(runtime.observeTarget(targetId), remaining()); }
		catch (error) { if (error instanceof WaitDeadlineError) break; return failedObservation(started, now(), error, initial, final); }
		if (expired()) break;
		if (observation.targetId !== targetId) return terminal("interrupted", "unverifiable", initial, final, started, now(), "target_changed");
		if (runtime.dialogCount() > dialogs) return terminal("interrupted", "unverifiable", initial, final, started, now(), "dialog");
		const navigated = observation.navigationEpoch !== baseline.navigationEpoch ||
			[...observation.generations].some(([key, generation]) => baseline.generations.has(key) && baseline.generations.get(key) !== generation);
		if (navigated) {
			if (isLocationExpectation(options.expect)) {
				final = evaluateBrowserExpectation(options.expect, observation, baseline, runtime.resolveRef);
				if (final.truth === true) return terminal("satisfied", "newly_verified", initial, final, started, now());
			}
			return terminal("interrupted", "unverifiable", initial, final, started, now(), "navigation");
		}
		final = evaluateBrowserExpectation(options.expect, observation, baseline, runtime.resolveRef);
		if (expired()) break;
		if (final.reason === "stale_ref") return terminal("interrupted", "unverifiable", initial, final, started, now(), final.reason);
		if (final.truth === true) return terminal("satisfied", "newly_verified", initial, final, started, now());
	}
	if (final.truth === undefined) return terminal("unverifiable", "unverifiable", initial, final, started, now(), final.reason ?? "incomplete_observation");
	return terminal("timed_out", "failed", initial, final, started, now());
}

class WaitDeadlineError extends Error {}

async function beforeDeadline<T>(operation: Promise<T>, remaining: number): Promise<T> {
	if (!Number.isFinite(remaining)) return operation;
	if (remaining <= 0) { void operation.catch(() => {}); throw new WaitDeadlineError(); }
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([operation, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new WaitDeadlineError()), remaining); })]);
	} finally { if (timer) clearTimeout(timer); }
}

function isLocationExpectation(expectation: CuaBrowserExpectation): boolean {
	if ("all" in expectation) return expectation.all.every(isLocationExpectation);
	if ("any" in expectation) return expectation.any.every(isLocationExpectation);
	return expectation.type === "url" || expectation.type === "title";
}

function timedOut(started: number, ended: number): BrowserWaitForResult {
	const evidence = { truth: undefined, details: [] };
	return terminal("timed_out", "failed", evidence, evidence, started, ended);
}

function terminal(status: BrowserWaitForResult["status"], evidence: BrowserWaitForResult["evidence"], initial: BrowserExpectationEvidence, final: BrowserExpectationEvidence, started: number, ended: number, reason?: BrowserWaitReason): BrowserWaitForResult {
	return { status, evidence, initial, final, elapsed_ms: Math.max(0, ended - started), ...(reason ? { reason } : {}), details: [...initial.details.map((detail) => `initial: ${detail}`), ...final.details.map((detail) => `final: ${detail}`)] };
}

function failedObservation(started: number, ended: number, error: unknown, initial: BrowserExpectationEvidence = { truth: undefined, details: [] }, final = initial): BrowserWaitForResult {
	const message = error instanceof Error ? error.message : String(error);
	return { ...terminal("unverifiable", "unverifiable", initial, final, started, ended, "observation_failed"), details: [...initial.details, message] };
}
