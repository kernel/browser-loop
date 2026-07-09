import type { ActionType } from "./prompts";

export type Status = "ok" | "not_found" | "error" | "timeout";

export interface ActionEventInfo {
	actionType: string;
	x?: number;
	y?: number;
}

export interface ActionResult {
	status: Status;
	action: string;
	coordinates?: [number, number];
	text?: string;
	url?: string;
	elapsedMs: number;
	timestamp: number;
}

/**
 * Build a structured ActionResult from the agent's final assistant text
 * and any action events captured during the run.
 */
export function parseResult(
	action: ActionType,
	textOutput: string,
	actionEvents: ActionEventInfo[],
	elapsedMs: number,
	toolError?: string,
): ActionResult {
	const trimmed = textOutput.trim();
	const result: ActionResult = {
		action,
		status: "ok",
		elapsedMs,
		timestamp: Date.now(),
	};

	if (toolError && toolError.trim().length > 0) {
		result.status = "error";
		result.text = toolError.trim();
		return result;
	}

	if (trimmed.startsWith("NOT_FOUND:")) {
		result.status = "not_found";
		result.text = trimmed.slice("NOT_FOUND:".length).trim();
		return result;
	}

	for (let i = actionEvents.length - 1; i >= 0; i--) {
		const ev = actionEvents[i]!;
		if (
			ev.x !== undefined &&
			ev.y !== undefined &&
			(ev.actionType === "click" ||
				ev.actionType === "double_click" ||
				ev.actionType === "click_mouse" ||
				ev.actionType === "left_click" ||
				ev.actionType === "right_click" ||
				ev.actionType === "middle_click" ||
				ev.actionType === "triple_click" ||
				ev.actionType === "click_at")
		) {
			result.coordinates = [ev.x, ev.y];
			break;
		}
	}

	switch (action) {
		case "observe":
			result.text = trimmed;
			break;
		case "url": {
			const url = extractFirstUrl(trimmed);
			if (url) {
				result.url = url;
			} else if (trimmed) {
				result.status = "error";
				result.text = trimmed;
			}
			break;
		}
		default:
			break;
	}

	return result;
}

function extractFirstUrl(text: string): string | undefined {
	const matches = text.match(
		/(?:https?:\/\/\S+|about:blank|file:\/\/\S+|chrome:\/\/\S+|chrome-extension:\/\/\S+|edge:\/\/\S+|brave:\/\/\S+)/gi,
	);
	if (!matches || matches.length === 0) return undefined;
	return matches[matches.length - 1]!.replace(/[)*_`,.;!?]+$/, "");
}

export function formatCompact(r: ActionResult): string {
	switch (r.status) {
		case "not_found":
			return r.text ? `not_found ${r.text}` : "not_found";
		case "error":
			return r.text ? `error ${r.text}` : "error";
		case "timeout":
			return "timeout";
	}

	switch (r.action as ActionType) {
		case "click":
			if (r.coordinates) return `ok clicked (${r.coordinates[0]}, ${r.coordinates[1]})`;
			return "ok clicked";
		case "type":
			return "ok typed";
		case "open":
			return "ok";
		case "press":
			return "ok pressed";
		case "observe":
			return r.text ?? "";
		case "url":
			return r.url ?? r.text ?? "";
		case "screenshot":
			return "ok";
		case "do":
			return r.text ?? "ok";
		default:
			return "ok";
	}
}

export function exitCodeFor(r: ActionResult): number {
	switch (r.status) {
		case "ok":
			return 0;
		case "not_found":
			return 1;
		case "error":
		case "timeout":
		default:
			return 2;
	}
}
