/**
 * Constrained one-shot prompts for the agent-friendly CLI subcommands.
 */

export type ActionType =
	| "click"
	| "type"
	| "open"
	| "press"
	| "screenshot"
	| "url"
	| "observe"
	| "do";

export interface ActionRequest {
	action: ActionType;
	target?: string;
	text?: string;
	keys?: string[];
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
		case "open": {
			const url = req.text || req.target;
			if (!url) throw new Error("open action requires a URL");
			return openPrompt(url);
		}
		case "press":
			if (!req.keys || req.keys.length === 0) throw new Error("press action requires at least one key");
			return pressPrompt(req.keys);
		case "observe":
			if (req.text) return observeWithQuestionPrompt(req.text);
			return observePrompt();
		case "url":
			return urlPrompt();
		case "do": {
			const instruction = req.text || req.target;
			if (!instruction) throw new Error("do action requires an instruction");
			return instruction;
		}
		case "screenshot":
			throw new Error("screenshot action does not use a prompt");
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

function openPrompt(url: string): string {
	return `Navigate the browser to this URL: ${url}
Use the goto action. Perform only this navigation, then stop.`;
}

function pressPrompt(keys: string[]): string {
	return `Press the following key(s): ${keys.join("+")}
Perform exactly this key press, then stop. Do not perform any other actions.`;
}

function observePrompt(): string {
	return `Look at the current screen and describe what you see. Be concise and factual.
Do NOT perform any actions. Only observe and describe.`;
}

function observeWithQuestionPrompt(question: string): string {
	return `Look at the current screen and answer this question: ${JSON.stringify(question)}
Be concise and factual. Do NOT perform any actions. Only observe and respond.`;
}

function urlPrompt(): string {
	return `Report the current page URL. Use the url action to read it. Do not perform any other actions. Respond with only the bare URL, no markdown or other formatting.`;
}
