import type { ActionSpaceElement, ElementOperation, ElementTarget, HistoryEntry, JevCandidate, JevCandidateSpace, Observation, Operation } from "./types";

const MAX_GROUNDED_CANDIDATES = 250;
const SECRET_FIELD = /\b(?:password|passphrase)\b/i;
const FILE_CONTROL = /\b(?:choose file|upload file)\b/i;

export function buildCandidateSpace(observation: Observation, goal: string, history: readonly HistoryEntry[] = []): JevCandidateSpace {
	const candidates: JevCandidate[] = [];
	const navigationOnly = observation.url === "about:blank" || observation.url.startsWith("chrome://");
	const pageElements = navigationOnly ? [] : observation.elements.filter((element) => !isExcludedControl(element));
	const operationsByNode = new Map<number, Set<ElementOperation>>();
	let grounded = 0;

	const addGrounded = (candidate: JevCandidate): boolean => {
		if (grounded >= MAX_GROUNDED_CANDIDATES) return false;
		candidates.push(candidate);
		grounded += 1;
		if (candidate.target && isElementOperation(candidate.operation)) {
			const operations = operationsByNode.get(candidate.target.node) ?? new Set<ElementOperation>();
			operations.add(candidate.operation);
			operationsByNode.set(candidate.target.node, operations);
		}
		return true;
	};

	for (const element of pageElements) {
		if (element.disabled) continue;
		const target: ElementTarget = {
			documentId: observation.documentId,
			node: element.node,
			guard: element.guard,
			...(element.ref ? { ref: element.ref } : {}),
		};
		for (const operation of element.operations) {
			if (operation === "SELECT") {
				for (const [optionIndex, option] of element.options.entries()) {
					if (option.selected) continue;
					if (!addGrounded({
						id: `select:${element.id}:${optionIndex + 1}`,
						kind: "target",
						operation,
						label: `Select ${JSON.stringify(option.label)} in ${JSON.stringify(element.name)}; current value=${JSON.stringify(element.value)}`,
						target,
						value: option.value,
					})) break;
				}
				continue;
			}
			if (operation === "TYPE_TEXT") {
				addGrounded({
					id: `type:${element.id}`,
					kind: "target",
					operation,
					label: `Enter text in ${JSON.stringify(element.name)}; current value=${JSON.stringify(element.value)}`,
					target,
					value: element.value,
					textPurpose: "field",
				});
				continue;
			}
			addGrounded({
				id: `click:${element.id}`,
				kind: "target",
				operation,
				label: element.operations.includes("TYPE_TEXT")
					? `Open ${JSON.stringify(element.name)}${stateDescription(element)}`
					: `Click ${element.role} ${JSON.stringify(element.name)}${stateDescription(element)}`,
				target,
			});
		}
	}

	const scrollAmount = Math.max(1, Math.ceil(observation.scroll.viewport / 120));
	if (!navigationOnly && observation.scroll.y + observation.scroll.viewport < observation.scroll.height - 2) {
		candidates.push({
			id: "scroll:down",
			kind: "browser-action",
			operation: "SCROLL",
			label: "Scroll down to reveal more page content",
			action: { type: "browser_scroll", x: observation.scroll.x, y: observation.scroll.pointY, direction: "down", amount: scrollAmount },
		});
	}
	if (!navigationOnly && observation.scroll.y > 0) {
		candidates.push({
			id: "scroll:up",
			kind: "browser-action",
			operation: "SCROLL",
			label: "Scroll up to reveal earlier page content",
			action: { type: "browser_scroll", x: observation.scroll.x, y: observation.scroll.pointY, direction: "up", amount: scrollAmount },
		});
	}
	candidates.push({
		id: "wait",
		kind: "browser-action",
		operation: "WAIT",
		label: "Wait briefly for the page to update",
		action: { type: "browser_act", steps: [{ type: "wait", ms: 100 }] },
	});

	const literalUrls = extractLiteralUrls(goal);
	if (literalUrls.length > 0) {
		for (const [index, url] of literalUrls.entries()) {
			candidates.push({ id: `navigate:${index}`, kind: "navigate", operation: "NAVIGATE", label: `Navigate to ${url}`, value: url });
		}
	} else {
		candidates.push({
			id: "navigate:resolve",
			kind: "navigate",
			operation: "NAVIGATE",
			label: "Navigate to the website needed to advance the goal",
			textPurpose: "navigation",
		});
	}
	if (!navigationOnly) {
		candidates.push({ id: "history:back", kind: "history", operation: "BACK", label: "Go back one page" });
		if (hasForwardHistory(history)) candidates.push({ id: "history:forward", kind: "history", operation: "FORWARD", label: "Go forward one page" });
		candidates.push({ id: "history:reload", kind: "history", operation: "RELOAD", label: "Reload the current page" });
	}
	candidates.push({ id: "done", kind: "terminal", operation: "DONE", label: "Every requirement is visibly satisfied" });
	candidates.push({ id: "blocked", kind: "terminal", operation: "BLOCKED", label: "No supported operation can make progress safely" });

	const byOperation = new Map<Operation, JevCandidate[]>();
	for (const candidate of candidates) {
		const group = byOperation.get(candidate.operation) ?? [];
		group.push(candidate);
		byOperation.set(candidate.operation, group);
	}
	const elements: ActionSpaceElement[] = pageElements.map((element) => ({
		...element,
		operations: [...(operationsByNode.get(element.node) ?? [])],
		options: [...element.options],
	}));
	return { candidates, byId: new Map(candidates.map((candidate) => [candidate.id, candidate])), byOperation, elements };
}

export function extractLiteralUrls(goal: string): string[] {
	const urls = new Set<string>();
	for (const match of goal.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
		const value = match[0].replace(/[),.;!?]+$/, "");
		try {
			const url = new URL(value);
			if (url.protocol === "http:" || url.protocol === "https:") urls.add(url.href);
		} catch {
			// Ignore malformed literals and let the text resolver handle navigation.
		}
	}
	return [...urls].slice(0, MAX_GROUNDED_CANDIDATES);
}

function isElementOperation(operation: Operation): operation is ElementOperation {
	return operation === "CLICK" || operation === "TYPE_TEXT" || operation === "SELECT";
}

function isExcludedControl(element: Observation["elements"][number]): boolean {
	return FILE_CONTROL.test(element.name) || (element.operations.includes("TYPE_TEXT") && SECRET_FIELD.test(element.name));
}

function hasForwardHistory(history: readonly HistoryEntry[]): boolean {
	let depth = 0;
	let previousUrl: string | undefined;
	for (const entry of history) {
		if (entry.operation === "BACK") depth += 1;
		else if (entry.operation === "FORWARD") depth = Math.max(0, depth - 1);
		else if (
			entry.operation === "NAVIGATE"
			|| (entry.operation !== "RELOAD" && previousUrl !== undefined && entry.url !== previousUrl)
		) depth = 0;
		previousUrl = entry.url;
	}
	return depth > 0;
}

function stateDescription(element: Observation["elements"][number]): string {
	const states = [
		element.value ? `value=${JSON.stringify(element.value)}` : undefined,
		element.checked === undefined ? undefined : `checked=${element.checked}`,
		element.selected === undefined ? undefined : `selected=${element.selected}`,
		element.expanded === undefined ? undefined : `expanded=${element.expanded}`,
	].filter((state): state is string => state !== undefined);
	return states.length ? `; ${states.join(", ")}` : "";
}
