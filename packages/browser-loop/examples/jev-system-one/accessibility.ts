import type { ObservationElement } from "./types";

const CLICKABLE_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem", "option"]);

interface ParsedLine {
	depth: number;
	role: string;
	name: string;
	ref?: string;
	states: ReadonlyMap<string, string | boolean | number>;
}

export function elementsFromAccessibilitySnapshot(snapshot: string, visibleFrameLabels: readonly string[]): ObservationElement[] {
	const lines = frameDescendants(
		snapshot.split("\n").map(parseLine).filter((line): line is ParsedLine => line !== undefined),
		new Set(visibleFrameLabels),
	);
	const consumedOptions = new Set<string>();
	const additions: ObservationElement[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (!line.ref || consumedOptions.has(line.ref)) continue;
		const states = elementState(line.states);
		const credentialSemantic = credentialSemanticOf(line.role, line.name);
		const sensitive = credentialSemantic === "password" || credentialSemantic === "otp";
		let operations: ObservationElement["operations"] = [];
		let options: ObservationElement["options"] = [];
		if (line.role === "combobox") {
			const descendants = descendantOptions(lines, index);
			if (descendants.length && states.expanded !== true) {
				operations = ["SELECT"];
				options = descendants.map((option) => ({ label: option.name, value: option.name, selected: option.states.get("selected") === true }));
				for (const option of descendants) if (option.ref) consumedOptions.add(option.ref);
			} else operations = ["CLICK"];
		} else if (["textbox", "searchbox", "spinbutton"].includes(line.role)) {
			operations = sensitive ? ["CLICK"] : ["TYPE_TEXT", "CLICK"];
		} else if (CLICKABLE_ROLES.has(line.role)) operations = ["CLICK"];
		if (!operations.length) continue;
		additions.push({
			id: `ax:${line.ref}`,
			node: -Number(line.ref.slice(1)),
			role: line.role,
			name: line.name || line.role,
			value: sensitive ? "" : states.value ?? "",
			...(sensitive ? { hasValue: Boolean(states.value), credentialSemantic, sensitive: true } : {}),
			operations,
			options,
			...(states.checked === undefined ? {} : { checked: states.checked }),
			...(states.selected === undefined ? {} : { selected: states.selected }),
			...(states.expanded === undefined ? {} : { expanded: states.expanded }),
			...(states.disabled === undefined ? {} : { disabled: states.disabled }),
			guard: "",
			ref: line.ref,
			rect: { x: 0, y: 0, width: 0, height: 0 },
		});
	}
	return additions;
}

function frameDescendants(lines: readonly ParsedLine[], visibleFrameLabels: ReadonlySet<string>): ParsedLine[] {
	const descendants: ParsedLine[] = [];
	const frames: Array<{ depth: number; included: boolean }> = [];
	for (const line of lines) {
		while (frames.length && line.depth <= frames[frames.length - 1]!.depth) frames.pop();
		if (line.role === "Iframe" || line.role === "IframePresentational") {
			const parent = frames[frames.length - 1];
			const included = parent?.included ?? visibleFrameLabels.has(line.name);
			frames.push({ depth: line.depth, included });
			continue;
		}
		if (frames.some((frame) => frame.included)) descendants.push(line);
	}
	return descendants;
}

function parseLine(source: string): ParsedLine | undefined {
	if (!source.trim() || source.startsWith("… truncated") || source === "(empty accessibility tree)") return undefined;
	const leading = source.match(/^\s*/)?.[0].length ?? 0;
	const body = source.slice(leading);
	const roleEnd = body.indexOf(" ");
	const role = roleEnd === -1 ? body : body.slice(0, roleEnd);
	let rest = roleEnd === -1 ? "" : body.slice(roleEnd + 1);
	let name = "";
	if (rest.startsWith('"')) {
		const end = quotedStringEnd(rest);
		if (end === -1) return undefined;
		name = JSON.parse(rest.slice(0, end + 1)) as string;
		rest = rest.slice(end + 1).trimStart();
	}
	const groups = [...rest.matchAll(/\[([^\]]*)\]/g)].map((match) => match[1] ?? "");
	const ref = groups.find((group) => /^e\d+$/.test(group));
	return {
		depth: Math.floor(leading / 2),
		role,
		name,
		...(ref ? { ref } : {}),
		states: parseStates(groups.find((group) => group !== ref) ?? ""),
	};
}

function descendantOptions(lines: readonly ParsedLine[], parentIndex: number): ParsedLine[] {
	const parent = lines[parentIndex]!;
	const options: ParsedLine[] = [];
	for (let index = parentIndex + 1; index < lines.length; index++) {
		const candidate = lines[index]!;
		if (candidate.depth <= parent.depth) break;
		if (candidate.role === "option" && candidate.states.get("disabled") !== true) options.push(candidate);
	}
	return options;
}

function parseStates(source: string): ReadonlyMap<string, string | boolean | number> {
	const states = new Map<string, string | boolean | number>();
	for (const token of splitStateTokens(source)) {
		const equals = token.indexOf("=");
		if (equals === -1) {
			states.set(token, true);
			continue;
		}
		const key = token.slice(0, equals);
		const raw = token.slice(equals + 1);
		try {
			const value = JSON.parse(raw) as unknown;
			states.set(key, typeof value === "string" || typeof value === "boolean" || typeof value === "number" ? value : raw);
		} catch {
			states.set(key, raw);
		}
	}
	return states;
}

function splitStateTokens(source: string): string[] {
	const tokens: string[] = [];
	let start = 0;
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < source.length; index++) {
		const character = source[index]!;
		if (escaped) escaped = false;
		else if (character === "\\") escaped = true;
		else if (character === '"') quoted = !quoted;
		else if (character === "," && !quoted) {
			tokens.push(source.slice(start, index).trim());
			start = index + 1;
		}
	}
	const final = source.slice(start).trim();
	if (final) tokens.push(final);
	return tokens.filter(Boolean);
}

function elementState(states: ReadonlyMap<string, string | boolean | number>): {
	value?: string;
	checked?: boolean | "mixed";
	selected?: boolean;
	expanded?: boolean;
	disabled?: boolean;
} {
	const checked = states.get("checked");
	return {
		...(states.has("value") ? { value: String(states.get("value")) } : {}),
		...(checked === true || checked === false || checked === "mixed" ? { checked } : {}),
		...(states.has("selected") ? { selected: states.get("selected") === true } : {}),
		...(states.has("expanded") ? { expanded: states.get("expanded") === true } : {}),
		...(states.get("disabled") === true ? { disabled: true } : {}),
	};
}

function credentialSemanticOf(role: string, name: string): "password" | "otp" | undefined {
	if (!["textbox", "searchbox", "spinbutton"].includes(role)) return undefined;
	if (/password|passphrase|passcode/i.test(name)) return "password";
	if (/\b(?:otp|one[ -]?time|verification|authenticator)\s*(?:code)?\b/i.test(name)) return "otp";
	return undefined;
}

function quotedStringEnd(value: string): number {
	let escaped = false;
	for (let index = 1; index < value.length; index++) {
		const character = value[index]!;
		if (escaped) escaped = false;
		else if (character === "\\") escaped = true;
		else if (character === '"') return index;
	}
	return -1;
}
