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
import type { BrowserActResult } from "./translator/types";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

const BROWSER_ACT_DIFF_LINE_LIMIT = 200;

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
	readResults: Array<
		| { type: "url"; url: string }
		| { type: "screenshot"; bytes: number }
		| { type: "cursor_position"; x: number; y: number }
		| { type: "browser_text"; label: string; bytes: number }
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
	try {
		const result = await translator.executeBatch(params.actions);
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
			} else if (read.type === "browser_act") {
				readResults.push({ type: "browser_act", result: read.result });
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
	const actResults = readResults.flatMap((read) => (read.type === "browser_act" ? [read.result] : []));
	const statusText =
		actResults.length === 0
			? "Actions executed successfully."
			: actResults.some((result) => result.outcome === "didnt")
				? "Browser actions did not satisfy their expectations."
				: actResults.every((result) => result.outcome === "worked")
					? "Browser actions worked."
					: "Browser action outcome is unknown.";
	return { content, details: { statusText, readResults } };
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

function formatBrowserActResult(result: BrowserActResult): string {
	const lines = [`browser_act outcome: ${result.outcome}`];
	if (result.stopped_at !== undefined) lines.push(`stopped_at: ${result.stopped_at} (${result.stop_reason ?? "unknown"})`);
	for (const step of result.steps) {
		lines.push(`step ${step.index} ${step.type}: ${step.outcome} — ${step.evidence.join("; ")}`);
		for (const detail of step.expectation?.details ?? []) lines.push(`  ${detail}`);
	}
	if (result.final_expectation) {
		lines.push(`final expectation: ${result.final_expectation.status}`);
		for (const detail of result.final_expectation.details) lines.push(`  ${detail}`);
	}
	if (result.successor.status === "unavailable") {
		lines.push(`successor unavailable: ${result.successor.error}`);
	} else {
		const { diff } = result.successor;
		lines.push(`successor url: ${result.successor.url}`);
		lines.push(`successor title: ${result.successor.title}`);
		lines.push(`successor diff: ${diff.changed ? `+${diff.added.length} -${diff.removed.length}` : "unchanged"}`);
		if (diff.url) lines.push(`  url: ${diff.url.before} -> ${diff.url.after}`);
		if (diff.title) lines.push(`  title: ${diff.title.before} -> ${diff.title.after}`);
		for (const line of diff.added.slice(0, BROWSER_ACT_DIFF_LINE_LIMIT)) lines.push(`  + ${line}`);
		const remaining = Math.max(0, BROWSER_ACT_DIFF_LINE_LIMIT - diff.added.length);
		for (const line of diff.removed.slice(0, remaining)) lines.push(`  - ${line}`);
		const omitted = diff.added.length + diff.removed.length - BROWSER_ACT_DIFF_LINE_LIMIT;
		if (omitted > 0) lines.push(`  … ${omitted} more diff lines omitted`);
		lines.push(result.successor.text);
	}
	return lines.join("\n");
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
