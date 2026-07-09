/**
 * Constrained one-shot prompts for the agent-friendly CLI subcommands.
 */

export type ModelActionType = "click" | "type" | "observe" | "do";

export interface ActionRequest {
	action: ModelActionType;
	target?: string;
	text?: string;
	maxTurns?: number;
}

export const DEFAULT_MAX_TURNS = 3;

export function buildPrompt(req: ActionRequest): string {
	switch (req.action) {
		case "click":
			if (!req.target) throw new Error("click action requires a target description");
			return clickPrompt(req.target);
		case "type":
			if (!req.target) throw new Error("type action requires a target description");
			if (!req.text) throw new Error("type action requires text to type");
			return typePrompt(req.target, req.text);
		case "observe":
			if (req.text) return observeWithQuestionPrompt(req.text);
			return observePrompt();
		case "do": {
			const instruction = req.text || req.target;
			if (!instruction) throw new Error("do action requires an instruction");
			return instruction;
		}
	}
}

function clickPrompt(target: string): string {
	return `Look at the current screen. Locate and click the element that best matches this description: ${JSON.stringify(target)}.
Perform exactly ONE click on the best matching element, then stop.
If no matching element is visible on screen, respond with the text: NOT_FOUND: followed by a brief explanation.
Do not perform any other actions.`;
}

function typePrompt(target: string, text: string): string {
	return `Look at the current screen. Locate the input/text field that best matches this description: ${JSON.stringify(target)}.
Click on it to focus it, then type exactly this text: ${JSON.stringify(text)}
Perform only the click and type actions, then stop.
If no matching element is visible on screen, respond with the text: NOT_FOUND: followed by a brief explanation.
Do not perform any other actions.`;
}

function observePrompt(): string {
	return `Look at the current screen and describe what you see. Be concise and factual.
Do NOT perform any actions. Only observe and describe.`;
}

function observeWithQuestionPrompt(question: string): string {
	return `Look at the current screen and answer this question: ${JSON.stringify(question)}
Be concise and factual. Do NOT perform any actions. Only observe and respond.`;
}
