import type {
	CuaActionBrowserAct,
	CuaActionBrowserSnapshot,
	CuaBrowserActStep,
	CuaBrowserExpectation,
} from "@onkernel/cua-ai";
import {
	diffObservations,
	ObservationChangedError,
	staticTextRun,
	type AXNode,
	type BrowserObservation,
	type BrowserPresentation,
} from "./browser-observation";
import type {
	BrowserActResult,
	BrowserActStepResult,
	BrowserExpectationEvidence,
} from "./types";

const EXPECTATION_TIMEOUT_MS = 2_000;
const EXPECTATION_POLL_MS = 50;

/** Internal three-valued result produced while checking a browser expectation. */
export interface ExpectationEvaluation {
	truth?: boolean;
	details: string[];
}

type RefExpectation = Extract<CuaBrowserExpectation, { type: "ref" }>;

/** Browser capabilities required by the dependent action state machine. */
export interface BrowserActRuntime {
	observe(tabId?: string): Promise<BrowserObservation>;
	targetIds(): Promise<string[]>;
	dialogCount(): number;
	generations(): ReadonlyMap<string, number>;
	navigationEpoch(targetId: string): number;
	executeStep(step: CuaBrowserActStep, tabId?: string): Promise<void>;
	evaluateRefExpectation(expectation: RefExpectation, observation: BrowserObservation): ExpectationEvaluation;
	presentObservation(observation: BrowserObservation, action: CuaActionBrowserSnapshot): BrowserPresentation;
	renderObservation(presentation: BrowserPresentation): string;
	rememberPresentation(presentation: BrowserPresentation): void;
}

/** Execute a dependent browser action list against an injected browser runtime. */
export async function runBrowserAct(action: CuaActionBrowserAct, runtime: BrowserActRuntime): Promise<BrowserActResult> {
	const observationAction: CuaActionBrowserSnapshot = { type: "browser_snapshot", tab_id: action.tab_id, ...action.successor };
	const completeObservationAction: CuaActionBrowserSnapshot = {
		type: "browser_snapshot",
		tab_id: action.tab_id,
		depth: Number.MAX_SAFE_INTEGER,
	};
	let baseline: BrowserObservation;
	let currentTargets: string[];
	try {
		baseline = await runtime.observe(action.tab_id);
		currentTargets = await runtime.targetIds();
	} catch (err) {
		return {
			outcome: "unknown",
			steps: [],
			stopped_at: 0,
			stop_reason: "control_flow",
			successor: { status: "unavailable", error: errorMessage(err) },
		};
	}
	let current = baseline;
	let currentDialogCount = runtime.dialogCount();
	const steps: BrowserActStepResult[] = [];
	let stoppedAt: number | undefined;
	let stopReason: BrowserActResult["stop_reason"];

	for (let index = 0; index < action.steps.length; index += 1) {
		const step = action.steps[index]!;
		const evidence: string[] = [];
		let beforeObservation: BrowserObservation;
		let beforeTargets: string[];
		try {
			beforeObservation = await runtime.observe(action.tab_id);
			beforeTargets = await runtime.targetIds();
		} catch (err) {
			evidence.push(`pre-action observation failed: ${errorMessage(err)}`);
			steps.push({ index, type: step.type, outcome: "unknown", evidence });
			stoppedAt = index;
			stopReason = "control_flow";
			break;
		}

		const boundary = browserControlChange(
			current,
			beforeObservation,
			runtime.generations(),
			runtime.navigationEpoch(beforeObservation.targetId),
			currentTargets,
			beforeTargets,
			currentDialogCount,
			runtime.dialogCount(),
		);
		current = beforeObservation;
		currentTargets = beforeTargets;
		currentDialogCount = runtime.dialogCount();
		if (boundary) {
			evidence.push(`${boundary} detected before input delivery`);
			steps.push({ index, type: step.type, outcome: "unknown", evidence });
			stoppedAt = index;
			stopReason = boundary;
			break;
		}

		const before = step.expect ? evaluateExpectation(step.expect, beforeObservation, baseline, runtime) : undefined;
		const dialogCount = currentDialogCount;
		let actionError: unknown;
		try {
			await runtime.executeStep(step, action.tab_id);
			evidence.push("input delivered");
		} catch (err) {
			actionError = err;
			evidence.push(errorMessage(err));
		}

		let expectation: BrowserExpectationEvidence | undefined;
		let observationError: unknown;
		let boundaryAfter: BrowserActResult["stop_reason"];
		const deadline = Date.now() + EXPECTATION_TIMEOUT_MS;
		while (true) {
			try {
				await delay(0);
				const afterObservation = await runtime.observe(action.tab_id);
				await delay(0);
				const afterTargets = await runtime.targetIds();
				boundaryAfter = browserControlChange(
					beforeObservation,
					afterObservation,
					runtime.generations(),
					runtime.navigationEpoch(afterObservation.targetId),
					beforeTargets,
					afterTargets,
					dialogCount,
					runtime.dialogCount(),
				);
				current = afterObservation;
				currentTargets = afterTargets;
				currentDialogCount = runtime.dialogCount();
				if (step.expect) expectation = expectationEvidence(before!, evaluateExpectation(step.expect, current, baseline, runtime));
				if (boundaryAfter && expectation?.status === "failed") {
					expectation = {
						...expectation,
						status: "unverifiable",
						details: [...expectation.details, `${boundaryAfter} interrupted verification`],
					};
				}
				if (boundaryAfter || !step.expect || expectation?.status !== "failed" || Date.now() >= deadline) break;
				await delay(EXPECTATION_POLL_MS);
			} catch (err) {
				observationError = err;
				if (step.expect) {
					expectation = {
						status: "unverifiable",
						before: before?.truth,
						details: [...(before?.details ?? []), errorMessage(err)],
					};
				}
				break;
			}
		}

		let outcome: BrowserActStepResult["outcome"] = "unknown";
		const staleRef = actionError !== undefined && /ref .* stale/.test(errorMessage(actionError));
		if (expectation?.status === "newly_verified" && actionError === undefined) outcome = "worked";
		else if (expectation?.status === "failed" || staleRef) outcome = "didnt";
		if (expectation) evidence.push(`expectation ${expectation.status}`);
		if (observationError) evidence.push(`post-action observation failed: ${errorMessage(observationError)}`);
		steps.push({ index, type: step.type, outcome, evidence, ...(expectation ? { expectation } : {}) });

		if (boundaryAfter) {
			stopReason = boundaryAfter;
		} else if (staleRef) {
			stopReason = "stale_ref";
		} else if (observationError || expectation?.status === "unverifiable") {
			stopReason = "control_flow";
		} else if (actionError) {
			stopReason = "action_failed";
		} else if (expectation?.status === "failed") {
			stopReason = "expectation_failed";
		}
		if (stopReason) {
			stoppedAt = index;
			break;
		}
	}

	let finalExpectation: BrowserExpectationEvidence | undefined;
	const terminalNavigation =
		stopReason === "navigation" &&
		stoppedAt === action.steps.length - 1 &&
		steps.length === action.steps.length &&
		steps.at(-1)?.evidence.includes("input delivered") === true;
	if (action.expect && (!stopReason || terminalNavigation)) {
		const before = evaluateExpectation(action.expect, baseline, baseline, runtime);
		const deadline = Date.now() + EXPECTATION_TIMEOUT_MS;
		while (true) {
			try {
				const afterObservation = await runtime.observe(action.tab_id);
				await delay(0);
				const afterTargets = await runtime.targetIds();
				const boundary = browserControlChange(
					current,
					afterObservation,
					runtime.generations(),
					runtime.navigationEpoch(afterObservation.targetId),
					currentTargets,
					afterTargets,
					currentDialogCount,
					runtime.dialogCount(),
				);
				current = afterObservation;
				currentTargets = afterTargets;
				currentDialogCount = runtime.dialogCount();
				if (boundary) {
					finalExpectation = {
						status: "unverifiable",
						before: before.truth,
						details: [...(finalExpectation?.details ?? before.details), `${boundary} interrupted verification`],
					};
					stopReason = boundary;
					break;
				}
				finalExpectation = expectationEvidence(before, evaluateExpectation(action.expect, current, baseline, runtime));
				if (finalExpectation.status !== "failed" || Date.now() >= deadline) break;
				await delay(EXPECTATION_POLL_MS);
			} catch (err) {
				finalExpectation = { status: "unverifiable", before: before.truth, details: [...before.details, errorMessage(err)] };
				stopReason = "control_flow";
				break;
			}
		}
		if (finalExpectation?.status === "failed") {
			stopReason = "expectation_failed";
			stoppedAt = action.steps.length;
		} else if (finalExpectation?.status === "unverifiable") {
			stopReason ??= "control_flow";
			stoppedAt = action.steps.length;
		}
	}

	const completed = steps.length === action.steps.length && (!stopReason || terminalNavigation);
	let successor: BrowserActResult["successor"] | undefined;
	let successorError: unknown;
	for (let attempt = 0; attempt < 3 && !successor; attempt += 1) {
		try {
			const successorObservation = await runtime.observe(action.tab_id);
			await delay(0);
			const successorTargets = await runtime.targetIds();
			const lateBoundary = browserControlChange(
				current,
				successorObservation,
				runtime.generations(),
				runtime.navigationEpoch(successorObservation.targetId),
				currentTargets,
				successorTargets,
				currentDialogCount,
				runtime.dialogCount(),
			);
			current = successorObservation;
			currentTargets = successorTargets;
			currentDialogCount = runtime.dialogCount();
			if (lateBoundary) {
				if (!stopReason || stopReason === "control_flow") stopReason = lateBoundary;
				stoppedAt ??= action.steps.length;
				successorError = new ObservationChangedError();
				continue;
			}
			const baselineComplete = runtime.presentObservation(baseline, completeObservationAction);
			const currentComplete = runtime.presentObservation(current, completeObservationAction);
			const currentPresentation = runtime.presentObservation(current, observationAction);
			successor = {
				status: "observed",
				text: runtime.renderObservation(currentPresentation),
				url: current.url,
				title: current.title,
				diff: diffObservations(baselineComplete, currentComplete),
			};
			runtime.rememberPresentation(currentPresentation);
		} catch (err) {
			successorError = err;
		}
	}
	if (!successor) {
		successor = { status: "unavailable", error: errorMessage(successorError ?? new ObservationChangedError()) };
		stopReason ??= "control_flow";
		stoppedAt ??= action.steps.length;
	}

	const definitiveFailure = steps.some((step) => step.outcome === "didnt") || finalExpectation?.status === "failed";
	const semanticallyVerified = action.expect
		? finalExpectation?.status === "newly_verified"
		: steps.length > 0 && steps.every((step) => step.outcome === "worked");
	const outcome = definitiveFailure ? "didnt" : completed && semanticallyVerified ? "worked" : "unknown";
	return {
		outcome,
		steps,
		...(stoppedAt !== undefined ? { stopped_at: stoppedAt } : {}),
		...(stopReason ? { stop_reason: stopReason } : {}),
		...(finalExpectation ? { final_expectation: finalExpectation } : {}),
		successor,
	};
}

function expectationNodes(observation: BrowserObservation): AXNode[] {
	const nodes = observation.nodes.map(({ node }) => node);
	for (const tree of [observation.tree, ...observation.stitches.values()]) {
		for (const node of tree.byId.values()) {
			const childIds = node.childIds ?? [];
			for (let index = 0; index < childIds.length; index += 1) {
				const run = staticTextRun(tree.byId, childIds, index);
				if (run) {
					nodes.push(run.node);
					index = run.end;
				}
			}
		}
	}
	return nodes;
}

function evaluateExpectation(
	expectation: CuaBrowserExpectation,
	observation: BrowserObservation,
	baseline: BrowserObservation,
	runtime: BrowserActRuntime,
): ExpectationEvaluation {
	if ("all" in expectation) {
		const children = expectation.all.map((child) => evaluateExpectation(child, observation, baseline, runtime));
		const truth = children.some((child) => child.truth === false)
			? false
			: children.some((child) => child.truth === undefined)
				? undefined
				: true;
		return { truth, details: children.flatMap((child) => child.details) };
	}
	if ("any" in expectation) {
		const children = expectation.any.map((child) => evaluateExpectation(child, observation, baseline, runtime));
		const truth = children.some((child) => child.truth === true)
			? true
			: children.some((child) => child.truth === undefined)
				? undefined
				: false;
		return { truth, details: children.flatMap((child) => child.details) };
	}
	if (expectation.type === "text") {
		const found = expectationNodes(observation).some(
			(node) => !node.ignored && (node.name?.value ?? "").toLowerCase().includes(expectation.text.toLowerCase()),
		);
		const truth = !found && !observation.complete ? undefined : found === (expectation.exists ?? true);
		const completeness = observation.complete ? "" : "; observation incomplete";
		return { truth, details: [`text ${JSON.stringify(expectation.text)} ${found ? "present" : "absent"}${completeness}`] };
	}
	if (expectation.type === "role_name") {
		const found = expectationNodes(observation).some(
			(node) =>
				!node.ignored &&
				(expectation.role === undefined || (node.role?.value ?? "") === expectation.role) &&
				(expectation.name === undefined || (node.name?.value ?? "") === expectation.name),
		);
		const truth = !found && !observation.complete ? undefined : found === (expectation.exists ?? true);
		const completeness = observation.complete ? "" : "; observation incomplete";
		return { truth, details: [`role/name ${found ? "present" : "absent"}${completeness}`] };
	}
	if (expectation.type === "url" || expectation.type === "title") {
		const value = observation[expectation.type];
		const initial = baseline[expectation.type];
		const checks = [
			expectation.equals === undefined || value === expectation.equals,
			expectation.contains === undefined || value.includes(expectation.contains),
			expectation.changed === undefined || (value !== initial) === expectation.changed,
		];
		return { truth: checks.every(Boolean), details: [`${expectation.type}=${JSON.stringify(value)}`] };
	}
	if (expectation.type !== "ref") return { truth: undefined, details: ["unsupported expectation"] };
	return runtime.evaluateRefExpectation(expectation, observation);
}

function expectationEvidence(before: ExpectationEvaluation, after: ExpectationEvaluation): BrowserExpectationEvidence {
	const details = [...before.details.map((detail) => `before: ${detail}`), ...after.details.map((detail) => `after: ${detail}`)];
	if (before.truth === undefined || after.truth === undefined) {
		return { status: "unverifiable", before: before.truth, after: after.truth, details };
	}
	if (before.truth && after.truth) return { status: "preexisting", before: true, after: true, details };
	if (!before.truth && after.truth) return { status: "newly_verified", before: false, after: true, details };
	return { status: "failed", before: before.truth, after: after.truth, details };
}

function observationGenerationsChanged(
	before: BrowserObservation,
	after: BrowserObservation,
	live: ReadonlyMap<string, number>,
	liveNavigationEpoch: number,
): boolean {
	if (before.navigationEpoch !== after.navigationEpoch || after.navigationEpoch !== liveNavigationEpoch) return true;
	for (const [key, generation] of after.generations) {
		if (generation !== (live.get(key) ?? 0)) return true;
		const previous = before.generations.get(key);
		if (previous !== undefined && previous !== generation) return true;
	}
	return false;
}

function browserControlChange(
	before: BrowserObservation,
	after: BrowserObservation,
	liveGenerations: ReadonlyMap<string, number>,
	liveNavigationEpoch: number,
	beforeTargets: readonly string[],
	afterTargets: readonly string[],
	beforeDialogCount: number,
	afterDialogCount: number,
): BrowserActResult["stop_reason"] {
	if (afterDialogCount > beforeDialogCount) return "dialog";
	if (observationGenerationsChanged(before, after, liveGenerations, liveNavigationEpoch)) return "navigation";
	if (targetsChanged(beforeTargets, afterTargets)) return "control_flow";
	return undefined;
}

function targetsChanged(before: readonly string[], after: readonly string[]): boolean {
	return before.length !== after.length || before.some((targetId, index) => targetId !== after[index]);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
