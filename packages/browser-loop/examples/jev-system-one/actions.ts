import type { ActionSpaceElement, HistoryEntry, JevCandidate, JevCandidateSpace, Observation, Operation } from "./types";

const MAX_GROUNDED_CANDIDATES = 250;
const SECRET_FIELD = /\b(?:password|passphrase)\b/i;
const FILE_CONTROL = /\b(?:choose file|upload file)\b/i;
const CLICKABLE_ROLES = new Set([
	"button",
	"link",
	"checkbox",
	"radio",
	"switch",
	"tab",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"treeitem",
]);
const EDITABLE_ROLES = new Set(["textbox", "searchbox", "spinbutton"]);

export function buildCandidateSpace(observation: Observation, goal: string, history: readonly HistoryEntry[] = []): JevCandidateSpace {
	const candidates: JevCandidate[] = [];
	const navigationOnly = observation.url === "about:blank" || observation.url.startsWith("chrome://");
	const pageElements = navigationOnly ? [] : observation.elements;
	const operationsByRef = new Map<string, Set<Operation>>();
	const optionsByRef = new Map<string, ActionSpaceElement["options"]>();
	const nativeOptions = new Set<string>();
	let grounded = 0;

	const addGrounded = (candidate: JevCandidate): boolean => {
		if (grounded >= MAX_GROUNDED_CANDIDATES) return false;
		candidates.push(candidate);
		grounded += 1;
		if (candidate.ref) {
			const operations = operationsByRef.get(candidate.ref) ?? new Set<Operation>();
			operations.add(candidate.operation);
			operationsByRef.set(candidate.ref, operations);
		}
		return true;
	};

	for (let index = 0; index < pageElements.length && grounded < MAX_GROUNDED_CANDIDATES; index++) {
		const element = pageElements[index]!;
		if (element.disabled || isExcludedControl(element)) continue;

		if (element.role === "combobox") {
			const options = descendantOptions(pageElements, index);
			if (options.length > 0) {
				optionsByRef.set(element.ref, options.map((option) => ({
					label: option.name,
					value: option.name,
					selected: option.selected === true,
				})));
				if (element.expanded !== true) {
					for (const option of options) {
						nativeOptions.add(option.ref);
						if (option.selected) continue;
						if (!addGrounded({
							id: `select:${element.ref}:${option.ref}`,
							kind: "browser-step",
							operation: "SELECT",
							label: `Select ${JSON.stringify(option.name)} in ${JSON.stringify(element.name)}`,
							ref: element.ref,
							value: option.name,
							step: { type: "fill", ref: element.ref, value: option.name },
						})) break;
					}
					continue;
				}
			}
			addGrounded({
				id: `type:${element.ref}`,
				kind: "browser-step",
				operation: "TYPE_TEXT",
				label: `Enter text in ${JSON.stringify(element.name)}; current value=${JSON.stringify(element.value ?? "")}`,
				ref: element.ref,
				value: element.value ?? "",
				textPurpose: "field",
			});
			addGrounded({
				id: `click:${element.ref}`,
				kind: "browser-step",
				operation: "CLICK",
				label: `Open ${JSON.stringify(element.name)}`,
				ref: element.ref,
				step: { type: "click", ref: element.ref },
			});
			continue;
		}

		if (EDITABLE_ROLES.has(element.role)) {
			addGrounded({
				id: `type:${element.ref}`,
				kind: "browser-step",
				operation: "TYPE_TEXT",
				label: `Enter text in ${JSON.stringify(element.name)}; current value=${JSON.stringify(element.value ?? "")}`,
				ref: element.ref,
				value: element.value ?? "",
				textPurpose: "field",
			});
			addGrounded({
				id: `click:${element.ref}`,
				kind: "browser-step",
				operation: "CLICK",
				label: `Open ${JSON.stringify(element.name)}`,
				ref: element.ref,
				step: { type: "click", ref: element.ref },
			});
			continue;
		}

		if (CLICKABLE_ROLES.has(element.role) || (element.role === "option" && !nativeOptions.has(element.ref))) {
			addGrounded({
				id: `click:${element.ref}`,
				kind: "browser-step",
				operation: "CLICK",
				label: `Click ${element.role} ${JSON.stringify(element.name)}${stateDescription(element)}`,
				ref: element.ref,
				step: { type: "click", ref: element.ref },
			});
		}
	}

	const scrollPoint = {
		x: Math.max(0, Math.floor(observation.scroll.width / 2)),
		y: Math.max(0, Math.floor(observation.scroll.viewport / 2)),
	};
	const scrollAmount = Math.max(1, Math.ceil(observation.scroll.viewport / 120));
	if (!navigationOnly && observation.scroll.y + observation.scroll.viewport < observation.scroll.height - 2) {
		candidates.push({
			id: "scroll:down",
			kind: "browser-action",
			operation: "SCROLL",
			label: "Scroll down to reveal more page content",
			action: { type: "browser_scroll", ...scrollPoint, direction: "down", amount: scrollAmount },
		});
	}
	if (!navigationOnly && observation.scroll.y > 0) {
		candidates.push({
			id: "scroll:up",
			kind: "browser-action",
			operation: "SCROLL",
			label: "Scroll up to reveal earlier page content",
			action: { type: "browser_scroll", ...scrollPoint, direction: "up", amount: scrollAmount },
		});
	}
	candidates.push({ id: "wait", kind: "browser-step", operation: "WAIT", label: "Wait briefly for the page to update", step: { type: "wait", ms: 100 } });

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
		if (hasForwardHistory(history)) {
			candidates.push({ id: "history:forward", kind: "history", operation: "FORWARD", label: "Go forward one page" });
		}
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
	const elements: ActionSpaceElement[] = pageElements
		.filter((element) => !isExcludedControl(element))
		.map((element) => ({
			...element,
			operations: [...(operationsByRef.get(element.ref) ?? [])],
			...(optionsByRef.has(element.ref) ? { options: optionsByRef.get(element.ref) } : {}),
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

function isExcludedControl(element: Observation["elements"][number]): boolean {
	return FILE_CONTROL.test(element.name) || (EDITABLE_ROLES.has(element.role) && SECRET_FIELD.test(element.name));
}

function descendantOptions(elements: readonly Observation["elements"][number][], parentIndex: number): Observation["elements"] {
	const parent = elements[parentIndex]!;
	const options: Observation["elements"] = [];
	for (let index = parentIndex + 1; index < elements.length; index++) {
		const candidate = elements[index]!;
		if (candidate.depth <= parent.depth) break;
		if (candidate.role === "option" && !candidate.disabled) options.push(candidate);
	}
	return options;
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
		element.value === undefined ? undefined : `value=${JSON.stringify(element.value)}`,
		element.checked === undefined ? undefined : `checked=${element.checked}`,
		element.selected === undefined ? undefined : `selected=${element.selected}`,
		element.expanded === undefined ? undefined : `expanded=${element.expanded}`,
	].filter((state): state is string => state !== undefined);
	return states.length ? `; ${states.join(", ")}` : "";
}
