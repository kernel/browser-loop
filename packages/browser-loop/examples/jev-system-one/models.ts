import { GoogleGenAI } from "@google/genai";
import { choice, noul, TypeSafeClient, type EntryType } from "@typesafe-ai/sdk";
import type { BrowserAction, ModelUsage, Observation, PlannedTask } from "./types";
import { actionAt, actionCriteria } from "./actions";

const JEV_INPUT_USD_PER_MILLION = 0.042;
const GEMINI_INPUT_USD_PER_MILLION = 0.30;
const GEMINI_OUTPUT_USD_PER_MILLION = 2.50;
const PLANNER_MODEL = process.env.PLANNER_MODEL ?? "gemini-3.5-flash-lite";

function asEntry(value: unknown): EntryType {
	return JSON.parse(JSON.stringify(value)) as EntryType;
}

export interface JevDecision {
	action: BrowserAction;
	confidence: number;
	doneProbability: number;
	latencyMs: number;
	inputTokens: number;
	outputTokens: number;
}

export function emptyUsage(): ModelUsage {
	return { calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0 };
}

export function addUsage(target: ModelUsage, inputTokens: number, outputTokens: number, latencyMs: number, kind: "jev" | "planner"): void {
	target.calls++;
	target.inputTokens += inputTokens;
	target.outputTokens += outputTokens;
	target.latencyMs += latencyMs;
	target.costUsd += kind === "jev"
		? inputTokens / 1_000_000 * JEV_INPUT_USD_PER_MILLION
		: inputTokens / 1_000_000 * GEMINI_INPUT_USD_PER_MILLION + outputTokens / 1_000_000 * GEMINI_OUTPUT_USD_PER_MILLION;
}

export class JevPolicy {
	readonly #client: TypeSafeClient;

	constructor() {
		const apiKey = process.env.JEV_API_KEY;
		if (!apiKey) throw new Error("JEV_API_KEY is required");
		this.#client = new TypeSafeClient({ apiKey, timeout: 10_000 });
	}

	async decide(input: {
		task: string;
		goal: string;
		observation: Observation;
		actions: BrowserAction[];
		history: string[];
	}): Promise<JevDecision> {
		const started = performance.now();
		const response = await this.#client.systemOne({
			state: asEntry({
				task: input.task,
				current_goal: input.goal,
				page: input.observation,
				recent_actions: input.history.slice(-6),
			}),
			questions: {
				next_action: choice(
					{
						question: "Which single available action best advances `current_goal` safely?",
						constraints: [
							"Select only from the supplied actions.",
							"Do not finish until the page visibly proves the goal is complete.",
							"Avoid destructive or credential-related actions.",
						],
					},
					actionCriteria(input.actions),
				),
				goal_complete: noul({
					question: "Does the current page visibly prove that `current_goal` is complete?",
					true_requires: "Direct visible evidence in `page.text`, URL, or element values",
					false_when: "An action is still needed or completion is only assumed",
				}),
			},
		});
		const latencyMs = performance.now() - started;
		return {
			action: actionAt(input.actions, response.answers.next_action.choice),
			confidence: response.answers.next_action.confidence,
			doneProbability: response.answers.goal_complete.noul,
			latencyMs,
			inputTokens: response.usage.input_tokens,
			outputTokens: response.usage.output_tokens,
		};
	}

	async extractAnswer(task: string, observation: Observation, candidates: string[]): Promise<{ answer?: string; usage: { input: number; output: number; latencyMs: number } }> {
		if (candidates.length < 2) return { answer: candidates[0], usage: { input: 0, output: 0, latencyMs: 0 } };
		const criteria = Object.fromEntries(candidates.slice(0, 255).map((candidate, index) => [`v${index}`, candidate]));
		const started = performance.now();
		const response = await this.#client.systemOne({
			state: asEntry({ task, page: observation }),
			questions: { answer: choice("Which exact candidate text answers the task?", criteria) },
		});
		const index = Number.parseInt(response.answers.answer.choice.slice(1), 10);
		return {
			answer: candidates[index],
			usage: { input: response.usage.input_tokens, output: response.usage.output_tokens, latencyMs: performance.now() - started },
		};
	}
}

export class MinimalPlanner {
	readonly #client: GoogleGenAI;

	constructor() {
		const apiKey = process.env.GOOGLE_API_KEY;
		if (!apiKey) throw new Error("GOOGLE_API_KEY is required for hybrid mode");
		this.#client = new GoogleGenAI({ apiKey });
	}

	async plan(task: string, observation: Observation): Promise<{ plan: PlannedTask; usage: { input: number; output: number; latencyMs: number } }> {
		const started = performance.now();
		const response = await this.#client.models.generateContent({
			model: PLANNER_MODEL,
			contents: JSON.stringify({ task, initial_page: observation }),
			config: {
				systemInstruction: "Convert the browser task into the smallest ordered plan. Do not perform actions. Subgoals must describe desired browser end states, never observations that are already true. Do not include answering, extraction, or synthesis as a subgoal. Copy every literal value that may need to be typed. Mark free-form synthesis as generate and exact page lookup as extract.",
				temperature: 0,
				responseMimeType: "application/json",
				responseJsonSchema: {
					type: "object",
					properties: {
						summary: { type: "string" },
						subgoals: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
						values: { type: "array", items: { type: "string" }, maxItems: 20 },
						answerKind: { type: "string", enum: ["none", "extract", "generate"] },
						answerInstruction: { type: "string" },
					},
					required: ["summary", "subgoals", "values", "answerKind", "answerInstruction"],
					additionalProperties: false,
				},
			},
		});
		const usage = response.usageMetadata;
		return {
			plan: JSON.parse(response.text ?? "{}") as PlannedTask,
			usage: {
				input: usage?.promptTokenCount ?? 0,
				output: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
				latencyMs: performance.now() - started,
			},
		};
	}

	async finalize(task: string, observation: Observation, instruction: string): Promise<{ answer: string; usage: { input: number; output: number; latencyMs: number } }> {
		const started = performance.now();
		const response = await this.#client.models.generateContent({
			model: PLANNER_MODEL,
			contents: JSON.stringify({ task, final_page: observation, answer_instruction: instruction }),
			config: {
				systemInstruction: "Answer only from the supplied final page. Be concise. Do not claim browser actions not present in the state.",
				temperature: 0,
			},
		});
		const usage = response.usageMetadata;
		return {
			answer: response.text?.trim() ?? "",
			usage: {
				input: usage?.promptTokenCount ?? 0,
				output: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
				latencyMs: performance.now() - started,
			},
		};
	}
}
