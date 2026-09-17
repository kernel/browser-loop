import type { Page } from "playwright-core";
import { buildActions, taskValueCandidates } from "./actions";
import { execute, observe } from "./browser";
import { JevPolicy, MinimalPlanner, addUsage, emptyUsage } from "./models";
import type { AgentMode, AgentResult, Observation, PlannedTask } from "./types";

const MAX_STEPS = 12;
const COMPLETE_THRESHOLD = 0.82;

function needsGeneration(task: string): boolean {
	return /^(?:please\s+)?(?:summarize|write|draft|compose|explain|paraphrase|invent|create)\b/i.test(task.trim());
}

function likelyNeedsAnswer(task: string): boolean {
	return /^(what|which|who|when|where|how|tell me|report|return|extract|summarize|explain)\b/i.test(task.trim());
}

function answerCandidates(observation: Observation): string[] {
	const candidates = new Set<string>();
	for (const match of observation.text.matchAll(/\b[A-Z]{2,}[A-Z0-9-]*\d[A-Z0-9-]*\b/g)) candidates.add(match[0]);
	for (const match of observation.text.matchAll(/\$\d+(?:\.\d{2})?|\b\d+(?:\.\d+)?%\b/g)) candidates.add(match[0]);
	for (const sentence of observation.text.split(/(?<=[.!?])\s+|\s*[|•]\s*/)) {
		const value = sentence.trim();
		if (value.length >= 2 && value.length <= 240) candidates.add(value);
	}
	return [...candidates].slice(0, 255);
}

function defaultPlan(task: string): PlannedTask {
	return {
		summary: task,
		subgoals: [task],
		values: taskValueCandidates(task),
		answerKind: likelyNeedsAnswer(task) ? "extract" : "none",
		answerInstruction: task,
	};
}

export async function runAgent(page: Page, task: string, mode: AgentMode): Promise<AgentResult> {
	const started = performance.now();
	const usage = { jev: emptyUsage(), planner: emptyUsage() };
	const steps: AgentResult["steps"] = [];
	const history: string[] = [];
	const jev = new JevPolicy();
	const initialObservation = await observe(page);

	if (mode === "jev-only" && needsGeneration(task)) {
		return {
			mode,
			status: "unsupported",
			reason: "Jev returns closed-set decisions, not generated prose; this task requires free-form generation.",
			steps,
			usage,
			wallMs: performance.now() - started,
			finalObservation: initialObservation,
		};
	}

	let plan = defaultPlan(task);
	let planner: MinimalPlanner | undefined;
	if (mode === "hybrid") {
		planner = new MinimalPlanner();
		const planned = await planner.plan(task, initialObservation);
		plan = planned.plan;
		addUsage(usage.planner, planned.usage.input, planned.usage.output, planned.usage.latencyMs, "planner");
	}

	const values = [...new Set([...plan.values, ...taskValueCandidates(task)])].slice(0, mode === "hybrid" ? 30 : 60);
	const browserSubgoals = plan.answerKind === "generate"
		? plan.subgoals.filter((subgoal) => !/\b(generate|summarize|synthesize|write|draft|answer)\b/i.test(subgoal))
		: plan.subgoals;
	const goal = mode === "hybrid" && plan.answerKind === "generate"
		? `Complete these browser-state goals: ${browserSubgoals.join(" -> ") || "Read the relevant source content on the current page"}`
		: mode === "hybrid"
			? `${task}\nBrowser plan: ${plan.subgoals.join(" -> ")}`
			: task;
	let status: AgentResult["status"] = "failed";
	let reason = "step limit reached";

	for (let step = 0; step < MAX_STEPS; step++) {
		const observation = step === 0 ? initialObservation : await observe(page);
		if (step > 0 && /stop on (?:its|the) destination page/i.test(task) && observation.url !== initialObservation.url) {
			status = "completed";
			reason = "Deterministic URL transition satisfied the destination stop condition";
			break;
		}
		const actions = buildActions(observation, values);
		const decision = await jev.decide({ task, goal, observation, actions, history });
		addUsage(usage.jev, decision.inputTokens, decision.outputTokens, decision.latencyMs, "jev");
		steps.push({
			step,
			goal,
			action: decision.action.description,
			confidence: decision.confidence,
			doneProbability: decision.doneProbability,
			latencyMs: decision.latencyMs,
			inputTokens: decision.inputTokens,
			outputTokens: decision.outputTokens,
		});

		if (decision.doneProbability >= COMPLETE_THRESHOLD || (plan.answerKind === "generate" && decision.doneProbability >= 0.7)) {
			status = "completed";
			reason = "Jev found visible completion evidence";
			break;
		}
		if (decision.action.kind === "finish") {
			if (decision.doneProbability >= 0.35 && decision.confidence >= 0.45) {
				status = "completed";
				reason = "Jev selected finish with corroborating completion probability";
			} else {
				reason = `Jev selected finish without enough completion evidence (${decision.doneProbability.toFixed(2)})`;
			}
			break;
		}
		if (decision.action.kind === "fail") {
			reason = "Jev found no safe available action";
			break;
		}
		if (decision.confidence < 0.04) {
			reason = `Action confidence below safety gate (${decision.confidence.toFixed(2)})`;
			break;
		}
		try {
			await execute(page, decision.action);
			history.push(decision.action.description);
		} catch (error) {
			reason = `Browser action failed: ${error instanceof Error ? error.message : String(error)}`;
			break;
		}
	}

	const finalObservation = await observe(page);
	let answer: string | undefined;
	if (status === "completed" && plan.answerKind === "extract") {
		const extracted = await jev.extractAnswer(task, finalObservation, answerCandidates(finalObservation));
		answer = extracted.answer;
		addUsage(usage.jev, extracted.usage.input, extracted.usage.output, extracted.usage.latencyMs, "jev");
	}
	if (status === "completed" && plan.answerKind === "generate" && planner) {
		const finalized = await planner.finalize(task, finalObservation, plan.answerInstruction);
		answer = finalized.answer;
		addUsage(usage.planner, finalized.usage.input, finalized.usage.output, finalized.usage.latencyMs, "planner");
	}

	return {
		mode,
		status,
		answer,
		reason,
		steps,
		usage,
		wallMs: performance.now() - started,
		finalObservation,
	};
}
