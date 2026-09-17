import type { BrowserAction, Observation } from "./types";

const STOP = new Set([
	"a", "an", "and", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it", "of", "on", "or", "the", "then", "to", "with",
	"click", "choose", "enter", "fill", "open", "select", "submit", "type", "use",
]);

export function taskValueCandidates(task: string): string[] {
	const values = new Set<string>();
	for (const match of task.matchAll(/["“']([^"”']{1,100})["”']/g)) values.add(match[1]!.trim());
	for (const match of task.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) values.add(match[0]);
	for (const match of task.matchAll(/\b\d{4}-\d{2}-\d{2}\b|\b\d+(?:\.\d+)?\b/g)) values.add(match[0]);

	const words = task.match(/[\p{L}\p{N}@._%+\-/]+/gu) ?? [];
	for (let size = 1; size <= 4; size++) {
		for (let index = 0; index + size <= words.length; index++) {
			const slice = words.slice(index, index + size);
			if (slice.every((word) => STOP.has(word.toLowerCase()))) continue;
			const value = slice.join(" ");
			if (value.length >= 2 && value.length <= 80) values.add(value);
		}
	}
	return [...values].slice(0, 60);
}

export function buildActions(observation: Observation, values: string[]): BrowserAction[] {
	const actions: BrowserAction[] = [];
	for (const element of observation.elements) {
		const label = `${element.tag} "${element.name}"`;
		if (element.tag === "select") {
			for (const option of element.options ?? []) {
				const value = option.split(" (")[0]!;
				actions.push({ kind: "select", elementId: element.id, value, description: `Select ${option} in ${label}` });
				if (actions.length >= 245) break;
			}
			if (actions.length >= 245) break;
			continue;
		}
		if (["checkbox", "radio"].includes(element.type) && element.value === "true") continue;
		if (["checkbox", "radio", "button", "submit", "reset"].includes(element.type) || element.tag === "button" || element.tag === "a" || element.role === "button") {
			actions.push({ kind: "click", elementId: element.id, description: `Click ${label}; current value=${element.value || "empty"}` });
			continue;
		}
		if (["input", "textarea"].includes(element.tag) && !["hidden", "file", "password"].includes(element.type)) {
			for (const value of values) {
				actions.push({ kind: "fill", elementId: element.id, value, description: `Fill ${label} with exact text ${JSON.stringify(value)}` });
				if (actions.length >= 245) break;
			}
		}
		if (actions.length >= 245) break;
	}
	if (observation.url !== "about:blank") actions.push({ kind: "back", description: "Go back one page in browser history" });
	actions.push({ kind: "finish", description: "Finish because the requested browser task is visibly complete" });
	actions.push({ kind: "fail", description: "Stop because no available action can complete the task safely" });
	return actions.slice(0, 255);
}

export function actionCriteria(actions: BrowserAction[]): Record<string, string> {
	return Object.fromEntries(actions.map((action, index) => [`a${index}`, action.description]));
}

export function actionAt(actions: BrowserAction[], key: string): BrowserAction {
	const index = Number.parseInt(key.slice(1), 10);
	return actions[index] ?? { kind: "fail", description: `Invalid action ${key}` };
}
