import type Kernel from "@onkernel/sdk";
import type { ImageContent, TextContent, Tool } from "@earendil-works/pi-ai";
import {
	CUA_NAVIGATION_TOOL_NAME,
	CUA_PLAYWRIGHT_TOOL_NAME,
	createCuaNavigationToolDefinition,
	createCuaPlaywrightToolDefinition,
	type ComputerToolCoordinateSystem,
	type CuaBatchInput,
	type CuaMode,
	type CuaNavigationInput,
	type CuaPlaywrightInput,
	type CuaScreenshotSpec,
	type CuaToolExecutorSpec,
	type TSchema,
} from "@onkernel/cua-ai";
import { InternalComputerTranslator, type KernelBrowser } from "./translator/translator";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { BrowserActResult, BrowserWaitForResult } from "./translator/types";

const BROWSER_ACT_DIFF_ENTRY_LIMIT = 200;
const BROWSER_ACT_DIFF_CHAR_LIMIT = 20_000;
const BROWSER_ACT_RESULT_CHAR_LIMIT = 50_000;

export interface ComputerToolOptions {
	browser: KernelBrowser;
	client: Kernel;
	toolExecutors: CuaToolExecutorSpec[];
	coordinateSystem?: ComputerToolCoordinateSystem;
	screenshot?: CuaScreenshotSpec;
	/** Action plane(s) in play; controls whether the post-action fallback capture is the OS display or the viewport. Default "computer". */
	mode?: CuaMode;
	playwright?: boolean;
}

type ToolContent = Array<TextContent | ImageContent>;

export interface BatchDetails {
	statusText: string;
	/** Remaining canonical actions skipped after an unsatisfied semantic wait. */
	skippedActions?: number;
	readResults: Array<
		| { type: "url"; url: string }
		| { type: "screenshot"; bytes: number }
		| { type: "cursor_position"; x: number; y: number }
		| { type: "browser_text"; label: string; bytes: number }
		| { type: "browser_wait_for"; result: BrowserWaitForResult }
		| { type: "browser_act"; result: BrowserActResult }
	>;
}

export interface NavigationDetails {
	action: string;
	statusText: string;
	url?: string;
}

/**
 * Structured details for a `playwright_execute` tool result. Library
 * consumers can read these directly instead of re-parsing the model-facing
 * tool content blocks.
 *
 * - `success` — whether the Playwright code itself completed without error.
 *   A `false` value means the code threw or the SDK reported failure; in
 *   that case the failure is also surfaced as tool content for the model.
 * - `statusText` — short human-readable status (success or failure summary).
 * - `result` — present only when the code returned a JSON-serializable value.
 * - `stdout`/`stderr` — raw daemon output, present whenever the daemon
 *   reported a non-empty value on that stream (may be whitespace-only).
 * - `error` — present only when `success` is `false`; the error message from
 *   the daemon.
 */
export interface PlaywrightDetails {
	success: boolean;
	statusText: string;
	result?: unknown;
	stdout?: string;
	stderr?: string;
	error?: string;
}

type BatchTool = AgentTool<TSchema, BatchDetails>;
type NavigationTool = AgentTool<TSchema, NavigationDetails>;
type PlaywrightTool = AgentTool<TSchema, PlaywrightDetails>;
type ActionTool = AgentTool<TSchema, BatchDetails>;
export type CuaExecutorTool = BatchTool | NavigationTool | PlaywrightTool | ActionTool;
type NavigationExecutorSpec = { kind: "navigation"; definition: Tool };
type PlaywrightExecutorSpec = { kind: "playwright"; definition: Tool };
type ComputerExecutorSpec = CuaToolExecutorSpec | NavigationExecutorSpec | PlaywrightExecutorSpec;

export function createCuaComputerTools(args: ComputerToolOptions): CuaExecutorTool[] {
	return buildCuaComputerTools(args, new InternalComputerTranslator(args));
}

/** Build executor tools against an existing translator (internal; not part of the package surface). */
export function buildCuaComputerTools(
	args: Pick<ComputerToolOptions, "toolExecutors" | "playwright" | "mode">,
	translator: InternalComputerTranslator,
): CuaExecutorTool[] {
	return withExtraTools(args).map((executor) => createExecutorTool(executor, translator, args.mode ?? "computer"));
}

function withExtraTools(args: Pick<ComputerToolOptions, "toolExecutors" | "playwright">): ComputerExecutorSpec[] {
	const executors: ComputerExecutorSpec[] = [...args.toolExecutors];
	const existing = new Set(executors.map((executor) => executor.definition.name));
	if (!existing.has(CUA_NAVIGATION_TOOL_NAME)) {
		executors.push({ kind: "navigation", definition: createCuaNavigationToolDefinition() });
	}
	if (args.playwright && !existing.has(CUA_PLAYWRIGHT_TOOL_NAME)) {
		executors.push({ kind: "playwright", definition: createCuaPlaywrightToolDefinition() });
	}
	return executors;
}

function createExecutorTool(executor: ComputerExecutorSpec, translator: InternalComputerTranslator, mode: CuaMode): CuaExecutorTool {
	const { definition } = executor;
	if (isNavigationExecutor(executor)) {
		const tool: NavigationTool = {
			name: definition.name,
			label: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			async execute(_toolCallId: string, params: unknown): Promise<AgentToolResult<NavigationDetails>> {
				return executeNavigationTool(translator, asNavigationInput(params), mode);
			},
		};
		return tool;
	}
	if (isPlaywrightExecutor(executor)) {
		const tool: PlaywrightTool = {
			name: definition.name,
			label: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			executionMode: "sequential",
			async execute(_toolCallId: string, params: unknown): Promise<AgentToolResult<PlaywrightDetails>> {
				return executePlaywrightTool(translator, asPlaywrightInput(params));
			},
		};
		return tool;
	}
	const tool: ActionTool = {
		name: definition.name,
		label: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		executionMode: "sequential",
		async execute(_toolCallId: string, params: unknown): Promise<AgentToolResult<BatchDetails>> {
			return executeBatchTool(translator, { actions: executor.toActions(params) }, mode);
		},
	};
	return tool;
}

function isNavigationExecutor(executor: ComputerExecutorSpec): executor is NavigationExecutorSpec {
	return "kind" in executor && executor.kind === "navigation";
}

function isPlaywrightExecutor(executor: ComputerExecutorSpec): executor is PlaywrightExecutorSpec {
	return "kind" in executor && executor.kind === "playwright";
}

async function executeBatchTool(
	translator: InternalComputerTranslator,
	params: CuaBatchInput,
	mode: CuaMode = "computer",
): Promise<AgentToolResult<BatchDetails>> {
	const content: ToolContent = [];
	const readResults: BatchDetails["readResults"] = [];
	let skippedActions = 0;
	try {
		const result = await translator.executeBatch(params.actions);
		skippedActions = result.skippedActions ?? 0;
		for (const read of result.readResults) {
			if (read.type === "url") {
				readResults.push({ type: "url", url: read.url });
				content.push({ type: "text", text: `url(): ${read.url}` });
			} else if (read.type === "cursor_position") {
				readResults.push({ type: "cursor_position", x: read.x, y: read.y });
				content.push({ type: "text", text: `cursor_position(): ${read.x},${read.y}` });
			} else if (read.type === "browser_text") {
				readResults.push({ type: "browser_text", label: read.label, bytes: read.text.length });
				content.push({ type: "text", text: read.text });
			} else if (read.type === "browser_wait_for") {
				readResults.push(read);
				content.push({ type: "text", text: formatBrowserWaitResult(read.result) });
			} else if (read.type === "browser_act") {
				readResults.push(read);
				content.push({ type: "text", text: formatBrowserActResult(read.result) });
			} else {
				readResults.push({ type: "screenshot", bytes: read.data.length });
				content.push({ type: "image", data: read.data.toString("base64"), mimeType: read.mimeType });
			}
		}
		if (content.length === 0) {
			// Post-action grounding capture: the OS display in computer/hybrid mode,
			// the browser viewport in browser mode (the only frame the model sees).
			const screenshot = mode === "browser" ? await translator.browser().screenshot() : await translator.screenshot();
			readResults.push({ type: "screenshot", bytes: screenshot.data.length });
			content.push({ type: "image", data: screenshot.data.toString("base64"), mimeType: screenshot.mimeType });
		}
	} catch (err) {
		throw new Error(`Actions failed: ${errorMessage(err)}`, { cause: err });
	}
	const acts = readResults.flatMap((read) => read.type === "browser_act" ? [read.result] : []);
	const waits = readResults.flatMap((read) => read.type === "browser_wait_for" ? [read.result] : []);
	const failedWait = ["interrupted", "timed_out", "unverifiable"].find((status) => waits.some((wait) => wait.status === status));
	let statusText = acts.some((act) => act.outcome === "didnt")
		? "Browser action plan did not satisfy its expectations."
		: failedWait
			? `Browser condition ${failedWait}.`
			: acts.some((act) => act.outcome === "unknown")
				? "Browser action plan outcome is unknown."
				: acts.length > 0
					? "Browser action plan worked."
					: waits.length > 0 ? "Browser condition satisfied." : "Actions executed successfully.";
	if (skippedActions) {
		const skipped = `${skippedActions} subsequent action${skippedActions === 1 ? " was" : "s were"} skipped.`;
		statusText = `${statusText} ${skipped}`;
		content.push({ type: "text", text: skipped });
	}
	return {
		content,
		details: {
			statusText,
			readResults,
			...(skippedActions ? { skippedActions } : {}),
		},
	};
}

async function executeNavigationTool(
	translator: InternalComputerTranslator,
	params: CuaNavigationInput,
	mode: CuaMode,
): Promise<AgentToolResult<NavigationDetails>> {
	const action = params.action;
	try {
		let statusText = `${action} executed successfully.`;
		let url: string | undefined;
		// When the browser plane is exposed (browser/hybrid), navigation stays
		// on it (CDP) so it invalidates element refs and reads the tab-aware URL;
		// the OS keyboard-shortcut path would navigate outside that plane.
		if (action === "url") {
			url = mode === "computer" ? await translator.currentUrl() : await translator.browser().currentUrl();
			statusText = `Current URL: ${url}`;
		} else if (mode !== "computer") {
			await translator.executeBatch([{ type: "browser_navigate", url: action === "goto" ? (params.url ?? "") : action }]);
		} else if (action === "goto") {
			await translator.executeBatch([{ type: "goto", url: params.url ?? "" }]);
		} else {
			await translator.executeBatch([{ type: action }]);
		}
		// Same grounding frame as post-action captures: the browser viewport in
		// browser mode, the OS display otherwise.
		const screenshot = mode === "browser" ? await translator.browser().screenshot() : await translator.screenshot();
		return {
			content: [
				{ type: "text", text: statusText },
				{ type: "image", data: screenshot.data.toString("base64"), mimeType: screenshot.mimeType },
			],
			details: { action, statusText, ...(url ? { url } : {}) },
		};
	} catch (err) {
		throw new Error(`${action} failed: ${errorMessage(err)}`, { cause: err });
	}
}

async function executePlaywrightTool(translator: InternalComputerTranslator, params: CuaPlaywrightInput): Promise<AgentToolResult<PlaywrightDetails>> {
	try {
		const execution = await translator.executePlaywright(params.code, params.timeout_sec);

		const content: ToolContent = [];
		if (execution.result !== undefined) {
			content.push({ type: "text", text: `result: ${formatPlaywrightResult(execution.result)}` });
		}
		if (execution.stdout?.trim()) {
			content.push({ type: "text", text: `stdout:\n${execution.stdout.trimEnd()}` });
		}
		if (execution.stderr?.trim()) {
			content.push({ type: "text", text: `stderr:\n${execution.stderr.trimEnd()}` });
		}
		if (!execution.success) {
			content.push({ type: "text", text: `error: ${execution.error ?? "playwright execution reported failure"}` });
		}

		const statusText = execution.success ? "Playwright executed successfully." : `Playwright execution failed: ${execution.error ?? "unknown error"}`;
		if (content.length === 0) content.push({ type: "text", text: statusText });

		const details: PlaywrightDetails = { success: execution.success, statusText };
		if (execution.result !== undefined) details.result = execution.result;
		if (execution.stdout) details.stdout = execution.stdout;
		if (execution.stderr) details.stderr = execution.stderr;
		if (execution.error) details.error = execution.error;
		return { content, details };
	} catch (err) {
		throw new Error(`playwright_execute failed: ${errorMessage(err)}`, { cause: err });
	}
}

function formatBrowserWaitResult(result: BrowserWaitForResult): string {
	const reason = result.reason ? ` (${result.reason})` : "";
	return [`wait_for: ${result.status}/${result.evidence}${reason} after ${result.elapsed_ms}ms`, ...result.details].join("\n");
}

/** Format model-facing plan feedback with bounded diff entries, diff characters, and total characters. */
export function formatBrowserActResult(result: BrowserActResult): string {
	const lines = [`browser_act: ${result.outcome}`];
	if (result.stopped_at !== undefined) lines.push(`stopped_at: ${result.stopped_at} (${result.stop_reason ?? "unknown"})`);
	else if (result.stop_reason) lines.push(`stop_reason: ${result.stop_reason}`);
	for (const step of result.steps) {
		lines.push(`step ${step.index} ${step.type}: ${step.outcome} — ${step.diagnostics.join("; ")}`);
		for (const diagnostic of step.expectation?.diagnostics ?? []) lines.push(`  ${diagnostic}`);
	}
	if (result.final_expectation) {
		lines.push(`final expectation: ${result.final_expectation.status}`);
		for (const diagnostic of result.final_expectation.diagnostics) lines.push(`  ${diagnostic}`);
	}
	if (result.successor.status === "unavailable") {
		lines.push(`successor unavailable: ${result.successor.error}`);
		return boundedBrowserActOutput(lines);
	}
	const { diff } = result.successor;
	const addedCount = diff.added.reduce((total, entry) => total + entry.count, 0);
	const removedCount = diff.removed.reduce((total, entry) => total + entry.count, 0);
	lines.push(`successor: ${result.successor.title} (${result.successor.url})`);
	lines.push(`diff: ${diff.changed ? `+${addedCount} -${removedCount}` : "unchanged"}`);
	if (diff.url) lines.push(`  url: ${diff.url.before} -> ${diff.url.after}`);
	if (diff.title) lines.push(`  title: ${diff.title.before} -> ${diff.title.after}`);
	const changes = [
		...diff.added.map((entry) => `  + ${entry.line}${entry.count === 1 ? "" : ` ×${entry.count}`}`),
		...diff.removed.map((entry) => `  - ${entry.line}${entry.count === 1 ? "" : ` ×${entry.count}`}`),
	];
	let emittedChars = 0;
	let emittedEntries = 0;
	for (const change of changes) {
		if (emittedEntries >= BROWSER_ACT_DIFF_ENTRY_LIMIT || emittedChars + change.length > BROWSER_ACT_DIFF_CHAR_LIMIT) break;
		lines.push(change);
		emittedEntries += 1;
		emittedChars += change.length;
	}
	if (emittedEntries < changes.length) lines.push(`  … ${changes.length - emittedEntries} more diff entries omitted`);
	lines.push(result.successor.text);
	return boundedBrowserActOutput(lines);
}

function boundedBrowserActOutput(lines: readonly string[]): string {
	const output = lines.join("\n");
	if (output.length <= BROWSER_ACT_RESULT_CHAR_LIMIT) return output;
	return `${output.slice(0, BROWSER_ACT_RESULT_CHAR_LIMIT)}\n… browser_act output truncated at ${BROWSER_ACT_RESULT_CHAR_LIMIT} characters`;
}

function formatPlaywrightResult(result: unknown): string {
	return typeof result === "string" ? result : JSON.stringify(result);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function asNavigationInput(value: unknown): CuaNavigationInput {
	if (
		value &&
		typeof value === "object" &&
		typeof (value as { action?: unknown }).action === "string"
	) {
		return value as CuaNavigationInput;
	}
	throw new Error("invalid computer_use_extra parameters");
}

function asPlaywrightInput(value: unknown): CuaPlaywrightInput {
	if (value && typeof value === "object" && typeof (value as { code?: unknown }).code === "string") {
		return value as CuaPlaywrightInput;
	}
	throw new Error("invalid playwright_execute parameters");
}
