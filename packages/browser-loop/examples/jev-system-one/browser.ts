import { createHash } from "node:crypto";
import type { BrowserAction } from "../../src/core/actions/browser";
import type { BrowserExecutor } from "../../src/core/translator/browser";
import { IncompleteObservationError, ObservationChangedError } from "../../src/core/translator/browser-observation";
import type { BatchReadResult } from "../../src/core/translator/types";
import type { BrowserRuntime, Observation, ObservationElement, ScrollState } from "./types";

const UNCHANGED_SNAPSHOT = "Page unchanged since the last snapshot; previous element refs are still valid.";
const OBSERVATION_RETRY_DELAYS_MS = [100, 200, 400, 800, 1_600];
const TEXT_LIMIT = 6_000;
const INTERACTIVE_ROLES = new Set([
	"button",
	"link",
	"textbox",
	"searchbox",
	"checkbox",
	"radio",
	"combobox",
	"listbox",
	"option",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"slider",
	"spinbutton",
	"switch",
	"tab",
	"treeitem",
]);

interface ParsedLine {
	depth: number;
	role: string;
	name: string;
	ref?: string;
	states: ReadonlyMap<string, string | boolean | number>;
}

export class ExecutorBrowserRuntime implements BrowserRuntime {
	readonly #executor: BrowserExecutor;
	#lastSnapshot?: string;

	constructor(executor: BrowserExecutor) {
		this.#executor = executor;
	}

	async observe(): Promise<Observation> {
		for (let attempt = 0; ; attempt += 1) {
			try {
				const reads = await this.#executor.execute({
					type: "browser_snapshot",
					depth: Number.MAX_SAFE_INTEGER,
				});
				const rendered = readText(reads, "snapshot");
				let snapshot = rendered;
				if (rendered === UNCHANGED_SNAPSHOT) {
					if (!this.#lastSnapshot) throw new Error("Browser reported an unchanged snapshot before returning an initial snapshot");
					snapshot = this.#lastSnapshot;
				}
				this.#lastSnapshot = snapshot;

				const url = await this.#executor.currentUrl();
				const scroll = await readScrollState(this.#executor);
				return observationFromSnapshot({ url, snapshot, scroll });
			} catch (error) {
				const delayMs = OBSERVATION_RETRY_DELAYS_MS[attempt];
				if (!(error instanceof ObservationChangedError || error instanceof IncompleteObservationError) || delayMs === undefined) throw error;
				await delay(delayMs);
			}
		}
	}

	async execute(action: BrowserAction): Promise<void> {
		const reads = await this.#executor.execute(action);
		if (action.type === "browser_navigate") this.#lastSnapshot = undefined;
		const act = reads.find((read): read is Extract<BatchReadResult, { type: "browser_act" }> => read.type === "browser_act");
		if (act?.result.successor.status === "observed") this.#lastSnapshot = act.result.successor.text;
		if (act?.result.stop_reason && ["action_failed", "stale_ref", "step_timeout", "global_timeout"].includes(act.result.stop_reason)) {
			throw new Error(`browser_act stopped: ${act.result.stop_reason}`);
		}
	}
}

export function observationFromSnapshot(input: { url: string; snapshot: string; scroll?: ScrollState }): Observation {
	const lines = input.snapshot.split("\n").map(parseSnapshotLine).filter((line): line is ParsedLine => line !== undefined);
	const title = lines.find((line) => line.role === "RootWebArea")?.name ?? "";
	const elements: ObservationElement[] = lines.flatMap((line) => {
		if (!line.ref || !INTERACTIVE_ROLES.has(line.role)) return [];
		return [{
			ref: line.ref,
			role: line.role,
			name: line.name || line.role,
			depth: line.depth,
			...stateFields(line.states),
		}];
	});
	const text = lines
		.filter((line) => line.name && !INTERACTIVE_ROLES.has(line.role))
		.map((line) => line.name)
		.join("\n")
		.slice(0, TEXT_LIMIT);
	const scroll = input.scroll ?? { y: 0, height: 0, viewport: 0, width: 0 };
	const fingerprint = createHash("sha256")
		.update(JSON.stringify({ url: input.url, snapshot: normalizeRefs(input.snapshot), scroll }))
		.digest("hex");
	return { url: input.url, title, text, snapshot: input.snapshot, elements, scroll, fingerprint };
}

function parseSnapshotLine(source: string): ParsedLine | undefined {
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
		try {
			name = JSON.parse(rest.slice(0, end + 1)) as string;
		} catch {
			return undefined;
		}
		rest = rest.slice(end + 1).trimStart();
	}
	const groups = [...rest.matchAll(/\[([^\]]*)\]/g)].map((match) => match[1] ?? "");
	const ref = groups.find((group) => /^e\d+$/.test(group));
	const stateGroup = groups.find((group) => group !== ref);
	return {
		depth: Math.floor(leading / 2),
		role,
		name,
		...(ref ? { ref } : {}),
		states: parseStates(stateGroup ?? ""),
	};
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
		let value: string | boolean | number = raw;
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (typeof parsed === "string" || typeof parsed === "boolean" || typeof parsed === "number") value = parsed;
		} catch {
			// Accessibility states such as mixed are intentionally plain strings.
		}
		states.set(key, value);
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

function stateFields(states: ReadonlyMap<string, string | boolean | number>): Omit<ObservationElement, "ref" | "role" | "name" | "depth"> {
	const checked = states.get("checked");
	return {
		...(states.has("value") ? { value: String(states.get("value")) } : {}),
		...(checked === true || checked === false || checked === "mixed" ? { checked } : {}),
		...(states.get("selected") === true ? { selected: true } : {}),
		...(states.has("expanded") ? { expanded: states.get("expanded") === true } : {}),
		...(states.get("disabled") === true ? { disabled: true } : {}),
	};
}

function normalizeRefs(snapshot: string): string {
	return snapshot.replace(/\[e\d+\]/g, "[ref]");
}

function readText(reads: readonly BatchReadResult[], label: string): string {
	const result = reads.find((read): read is Extract<BatchReadResult, { type: "browser_text" }> => read.type === "browser_text" && read.label === label);
	if (!result) throw new Error(`Browser action did not return ${label} text`);
	return result.text;
}

async function readScrollState(executor: BrowserExecutor): Promise<ScrollState> {
	const reads = await executor.execute({
		type: "browser_evaluate",
		code: "(() => ({ y: scrollY, height: document.documentElement?.scrollHeight ?? 0, viewport: innerHeight, width: innerWidth }))()",
	});
	const value = JSON.parse(readText(reads, "evaluate")) as Partial<ScrollState>;
	return {
		y: finite(value.y),
		height: finite(value.height),
		viewport: finite(value.viewport),
		width: finite(value.width),
	};
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
