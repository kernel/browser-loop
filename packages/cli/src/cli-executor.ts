import { InternalComputerTranslator, type BatchReadResult, type BrowserFindCandidate, type BrowserRefState } from "@onkernel/cua-agent";
import { writeFile } from "node:fs/promises";
import { stderr, stdout } from "node:process";
import { emitCompact, type RunActionResult } from "./action/harness-runner";
import { exitCodeFor, type ActionResult, type DeterministicActionType } from "./action/result";
import { parseMode, parseNativeTool, provisionForFlags, requireKernelApiKey, type HarnessCliFlags } from "./cli-harness";
import { readNamedSessionRefs, writeNamedSessionRefs } from "./harness-named-sessions";
import { captureScreenshot, type CuaBrowserHandle } from "./harness-browser";

/**
 * Model-free subcommand plane. These commands validate argv, attach to (or
 * provision) a Kernel browser, and call the executor directly over CDP or
 * the computer batch API — no LLM harness, no model API key.
 */

export type DeterministicRequest =
	| { action: "open"; url: string }
	| { action: "url" }
	| { action: "snapshot"; filter?: "interactive" }
	| { action: "text" }
	| { action: "find"; query: string }
	| { action: "fill"; query: string; value: string }
	| { action: "fill"; ref: string; value: string }
	| { action: "press"; keys: string[] }
	| { action: "click"; x: number; y: number }
	| { action: "click"; ref: string }
	| { action: "tabs" }
	| { action: "screenshot"; out: string };

export const DETERMINISTIC_SUBCOMMANDS: ReadonlySet<string> = new Set<DeterministicActionType>([
	"open",
	"url",
	"snapshot",
	"text",
	"find",
	"fill",
	"press",
	"tabs",
	"screenshot",
]);

/** `cua click <x> <y>` is deterministic; any other click argv is a model-mediated description. */
export function isCoordinatePair(rest: string[]): boolean {
	return rest.length === 2 && rest.every((token) => /^\d+$/.test(token));
}

/** An element ref minted by `cua snapshot` / `cua find`, e.g. `e12`. */
export function isElementRef(token: string | undefined): token is string {
	return token !== undefined && /^e\d+$/.test(token);
}

/** Roles `cua fill` will target. Everything else is left to `click`/`type`. */
const FILLABLE_ROLES: ReadonlySet<string> = new Set([
	"textbox",
	"searchbox",
	"combobox",
	"checkbox",
	"radio",
	"listbox",
	"spinbutton",
]);

/** Roles whose fill value is a checked state, not text. */
const TOGGLE_ROLES: ReadonlySet<string> = new Set(["checkbox", "radio"]);

function parseToggleValue(raw: string): boolean {
	const value = raw.trim().toLowerCase();
	if (["true", "1", "checked", "on"].includes(value)) return true;
	if (["false", "0", "unchecked", "off"].includes(value)) return false;
	throw new Error(`checkbox/radio value must be true|false|1|0|checked|unchecked|on|off, got ${JSON.stringify(raw)}`);
}

/**
 * Value for a ref-addressed fill, where the element's role is unknown until
 * the browser resolves it. Toggle words become booleans — lossless for text
 * controls (the page-side fill stringifies) and correct for checkboxes.
 * "1"/"0" stay strings so select options and numeric inputs keep their value.
 */
function refFillValue(raw: string): string | boolean {
	const value = raw.trim().toLowerCase();
	if (["true", "checked", "on"].includes(value)) return true;
	if (["false", "unchecked", "off"].includes(value)) return false;
	return raw;
}

/** Resolve argv to a deterministic subcommand, or undefined when the model plane should handle it. */
export function deterministicActionFor(first: string | undefined, rest: string[]): DeterministicActionType | undefined {
	if (!first) return undefined;
	if (DETERMINISTIC_SUBCOMMANDS.has(first)) return first as DeterministicActionType;
	if (first === "click" && (isCoordinatePair(rest) || (rest.length === 1 && isElementRef(rest[0])))) return "click";
	return undefined;
}

/** Parse and validate a deterministic subcommand's argv. Throws before any Kernel API call. */
export function parseDeterministicArgs(
	action: DeterministicActionType,
	rest: string[],
	flags: HarnessCliFlags,
): DeterministicRequest {
	if (flags.filter !== undefined && action !== "snapshot") {
		throw new Error("--filter only applies to cua snapshot");
	}
	switch (action) {
		case "open": {
			const url = (rest[0] ?? "").trim();
			if (!url || rest.length > 1) throw new Error("usage: cua open <url|back|forward>");
			return { action, url };
		}
		case "url":
			if (rest.length > 0) throw new Error("usage: cua url");
			return { action };
		case "snapshot": {
			if (rest.length > 0) throw new Error("usage: cua snapshot [--filter interactive]");
			const filter = flags.filter?.trim().toLowerCase();
			if (filter !== undefined && filter !== "interactive") {
				throw new Error(`invalid --filter value "${flags.filter}"; expected: interactive`);
			}
			return { action, ...(filter === "interactive" ? { filter } : {}) };
		}
		case "text":
			if (rest.length > 0) throw new Error("usage: cua text");
			return { action };
		case "find": {
			const query = rest.join(" ").trim();
			if (!query) throw new Error('usage: cua find "<query>"');
			return { action, query };
		}
		case "fill": {
			const target = (rest[0] ?? "").trim();
			const value = rest[1];
			if (!target || value === undefined || rest.length > 2) {
				throw new Error('usage: cua fill <ref|"query"> "<value>"');
			}
			if (isElementRef(target)) return { action, ref: target, value };
			return { action, query: target, value };
		}
		case "press": {
			const keys = rest.map((key) => key.trim()).filter((key) => key.length > 0);
			if (keys.length === 0) throw new Error("usage: cua press <key> [key...]");
			return { action, keys };
		}
		case "click": {
			if (rest.length === 1 && isElementRef(rest[0])) return { action, ref: rest[0] };
			if (!isCoordinatePair(rest)) throw new Error("usage: cua click <x> <y> | cua click <ref>");
			return { action, x: Number(rest[0]), y: Number(rest[1]) };
		}
		case "tabs":
			if (rest.length > 0) throw new Error("usage: cua tabs");
			return { action };
		case "screenshot": {
			if (rest.length > 0) throw new Error("usage: cua screenshot [--out file|-]");
			return { action, out: flags.out ?? "screenshot.png" };
		}
	}
}

/**
 * Persistence seam for element refs so they survive across invocations of
 * the same named session. Absent for fresh (non `-s`) browsers, whose refs
 * cannot outlive the browser anyway.
 */
export interface RefStateStore {
	load(): Promise<BrowserRefState | undefined>;
	save(state: BrowserRefState): Promise<void>;
}

/** Run a deterministic subcommand end to end: parse, provision/attach, execute, print, tear down. */
export async function runDeterministicCommand(
	action: DeterministicActionType,
	rest: string[],
	flags: HarnessCliFlags,
): Promise<number> {
	const req = parseDeterministicArgs(action, rest, flags);
	// Deterministic commands ignore the runtime mode, but an invalid value is
	// still a usage error, same as the harness-backed entry points.
	parseMode(flags.mode);
	parseNativeTool(flags.nativeTool);
	const { apiKey, baseUrl } = requireKernelApiKey();
	const provisioned = await provisionForFlags(flags, { kernelApiKey: apiKey, kernelBaseUrl: baseUrl });
	const name = flags.namedSession;
	const refStore: RefStateStore | undefined = name
		? {
				load: () => readNamedSessionRefs(name),
				save: (state) => writeNamedSessionRefs(name, state),
			}
		: undefined;
	return runDeterministicOnHandle(req, provisioned.handle, defaultTranslator, refStore);
}

/** Execute a parsed request against a browser handle. Split from provisioning for tests. */
export async function runDeterministicOnHandle(
	req: DeterministicRequest,
	handle: CuaBrowserHandle,
	createTranslator: (handle: CuaBrowserHandle) => InternalComputerTranslator = defaultTranslator,
	refStore?: RefStateStore,
): Promise<number> {
	const translator = createTranslator(handle);
	try {
		if (refStore) {
			const state = await refStore.load();
			if (state) translator.browser().importRefState(state);
		}
		const res = await executeDeterministic(req, translator, handle);
		return emitCompact(res);
	} finally {
		if (refStore) {
			try {
				await refStore.save(translator.browser().exportRefState());
			} catch (err) {
				stderr.write(`[cua] cleanup warning: ${(err as Error).message}\n`);
			}
		}
		try {
			translator.dispose();
		} catch (err) {
			stderr.write(`[cua] cleanup warning: ${(err as Error).message}\n`);
		}
		try {
			await handle.close();
		} catch (err) {
			stderr.write(`[cua] cleanup warning: ${(err as Error).message}\n`);
		}
	}
}

function defaultTranslator(handle: CuaBrowserHandle): InternalComputerTranslator {
	return new InternalComputerTranslator({ browser: handle.browser, client: handle.client });
}

async function executeDeterministic(
	req: DeterministicRequest,
	translator: InternalComputerTranslator,
	handle: CuaBrowserHandle,
): Promise<RunActionResult> {
	const startedAt = Date.now();
	const finish = (partial: Omit<ActionResult, "elapsedMs" | "timestamp">): RunActionResult => {
		const result: ActionResult = { ...partial, elapsedMs: Date.now() - startedAt, timestamp: Date.now() };
		return { result, exitCode: exitCodeFor(result) };
	};
	try {
		switch (req.action) {
			case "open":
				await translator.browser().execute({ type: "browser_navigate", url: req.url });
				return finish({ action: req.action, status: "ok" });
			case "url":
				return finish({ action: req.action, status: "ok", url: await translator.browser().currentUrl() });
			case "snapshot": {
				const reads = await translator.browser().execute({ type: "browser_snapshot", ...(req.filter ? { filter: req.filter } : {}) });
				return finish({ action: req.action, status: "ok", text: readText(reads) });
			}
			case "text": {
				const reads = await translator.browser().execute({ type: "browser_text" });
				return finish({ action: req.action, status: "ok", text: readText(reads) });
			}
			case "find": {
				const candidates = await translator.browser().findCandidates(req.query);
				if (candidates.length === 0) {
					return finish({ action: req.action, status: "not_found", text: `no elements matched ${JSON.stringify(req.query)}` });
				}
				return finish({ action: req.action, status: "ok", text: candidates.map(formatCandidate).join("\n") });
			}
			case "fill": {
				const executor = translator.browser();
				if ("ref" in req) {
					await executor.execute({ type: "browser_fill", ref: req.ref, value: refFillValue(req.value) });
					return finish({ action: req.action, status: "ok", text: req.ref });
				}
				const candidates = await executor.findCandidates(req.query, undefined, FILLABLE_ROLES);
				if (candidates.length === 0) {
					return finish({ action: req.action, status: "not_found", text: `no fillable element matched ${JSON.stringify(req.query)}` });
				}
				const tied = candidates.filter((c) => c.score === candidates[0]!.score);
				if (tied.length > 1) {
					const listing = tied.map((c) => `${c.role} ${JSON.stringify(c.name)}`).join(", ");
					return finish({
						action: req.action,
						status: "not_found",
						text: `ambiguous query ${JSON.stringify(req.query)} (${tied.length} matches): ${listing}`,
					});
				}
				const match = candidates[0]!;
				const value = TOGGLE_ROLES.has(match.role) ? parseToggleValue(req.value) : req.value;
				await executor.execute({ type: "browser_fill", ref: match.ref, value });
				return finish({ action: req.action, status: "ok", text: `${match.role} ${JSON.stringify(match.name)}` });
			}
			case "press":
				await translator.executeBatch([{ type: "keypress", keys: req.keys }]);
				return finish({ action: req.action, status: "ok" });
			case "click":
				if ("ref" in req) {
					await translator.browser().execute({ type: "browser_click", ref: req.ref });
					return finish({ action: req.action, status: "ok", text: req.ref });
				}
				await translator.executeBatch([{ type: "click", x: req.x, y: req.y }]);
				return finish({ action: req.action, status: "ok", coordinates: [req.x, req.y] });
			case "tabs": {
				const reads = await translator.browser().execute({ type: "browser_list_tabs" });
				return finish({ action: req.action, status: "ok", text: readText(reads) });
			}
			case "screenshot": {
				const png = await captureScreenshot(handle.client, handle.browser.session_id);
				if (!png) {
					return finish({ action: req.action, status: "error", text: "failed to capture screenshot" });
				}
				if (req.out === "-") {
					// stdout is the PNG bytes; the compact status line would corrupt a pipe.
					stdout.write(png);
					return finish({ action: req.action, status: "ok", text: "" });
				}
				await writeFile(req.out, png);
				return finish({ action: req.action, status: "ok", text: req.out });
			}
		}
	} catch (err) {
		const message = (err as Error).message;
		// A stale ref is "not found" (exit 1): the caller should re-snapshot,
		// same as a failed description match — not an infrastructure error.
		const status = /stale|not on the current page/i.test(message) ? "not_found" : "error";
		return finish({ action: req.action, status, text: message });
	}
}

function formatCandidate(candidate: BrowserFindCandidate): string {
	const name = candidate.name ? ` ${JSON.stringify(candidate.name)}` : "";
	return `${candidate.role || "node"}${name} [${candidate.ref}]`;
}

function readText(reads: BatchReadResult[]): string {
	const parts: string[] = [];
	for (const read of reads) {
		if (read.type === "browser_text") parts.push(read.text);
	}
	return parts.join("\n");
}
