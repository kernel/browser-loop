import type Kernel from "@onkernel/sdk";
import type { ComputerUseAction } from "./actions/index";
import type { LoopCoordinateContract, LoopToolSpec } from "./tool-catalog";
import { formatBrowserActResult } from "./browser-result-format";
import { BatchExecutionError, InternalComputerTranslator, type KernelBrowser, type PlaywrightExecutionResult } from "./translator/translator";
import type { BrowserExecutor } from "./translator/browser";
import type { BatchExecutionResult, BatchReadResult, BrowserWaitForResult } from "./translator/types";

/** Structured execution metadata returned by materialized Loop tools. */
export interface LoopExecutionDetails {
	statusText: string;
	readResults?: Array<Record<string, unknown>>;
	skippedActions?: number;
	failedActionIndex?: number;
	/** Internal marker consumed by the behaviors `activate()` installs, to set ToolResultMessage.isError. */
	isError?: boolean;
	result?: unknown;
	stdout?: string;
	stderr?: string;
	error?: string;
}

/** One content block returned to the model by a materialized Loop tool. */
export type LoopToolResultContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

/** Framework-neutral result of executing a materialized Loop tool. */
export interface LoopToolExecutionResult {
	content: LoopToolResultContent[];
	details: LoopExecutionDetails;
}

/**
 * Framework-neutral executable: a spec bound to this pool's browser. A
 * framework binding wraps `execute` in its own tool shape; the executable
 * itself only ever sees the model-provided input and an abort signal.
 */
export interface LoopExecutableTool {
	readonly spec: LoopToolSpec;
	execute(input: unknown, signal?: AbortSignal): Promise<LoopToolExecutionResult>;
}

type ToolContent = LoopToolResultContent[];

/**
 * One per-agent browser resource pool. Tool catalogs may be rebuilt without
 * replacing this object, its lazy CDP connection, refs, or tab lifecycle.
 */
export class LoopExecutionResources {
	readonly browser: KernelBrowser;
	readonly client: Kernel;
	private readonly translator: InternalComputerTranslator;
	/** Each spec is materialized exactly once per resource pool. */
	private readonly materialized = new WeakMap<LoopToolSpec, LoopExecutableTool>();

	constructor(options: {
		browser: KernelBrowser;
		client: Kernel;
		/** Test seam; production uses the pool's lazy raw-CDP BrowserExecutor. */
		createBrowserExecutor?: (cdpWsUrl: string) => BrowserExecutor;
	}) {
		this.browser = options.browser;
		this.client = options.client;
		this.translator = new InternalComputerTranslator(options);
	}

	materialize(spec: LoopToolSpec): LoopExecutableTool {
		const cached = this.materialized.get(spec);
		if (cached) return cached;
		const tool: LoopExecutableTool = {
			spec,
			execute: async (input, signal) => {
				if (spec.execution.kind === "playwright") return this.executePlaywright(spec.name, input);
				const actions = spec.execution.toActions(input);
				return this.executeActions(spec, actions, signal);
			},
		};
		this.materialized.set(spec, tool);
		return tool;
	}

	async computer(actions: ComputerUseAction[], coordinateContract: LoopCoordinateContract, signal?: AbortSignal): Promise<BatchExecutionResult> {
		return this.translator.executeBatch(actions, coordinateContract, signal);
	}

	browserExecutor() {
		return this.translator.browser();
	}

	async playwright(code: string, timeoutSec?: number): Promise<PlaywrightExecutionResult> {
		return this.translator.executePlaywright(code, timeoutSec);
	}

	async dispose(): Promise<void> {
		this.translator.dispose();
	}

	private async executeActions(spec: LoopToolSpec, actions: ComputerUseAction[], signal?: AbortSignal): Promise<LoopToolExecutionResult> {
		if (spec.execution.kind !== "actions") throw new Error(`tool "${spec.name}" has no action executor`);
		let result: BatchExecutionResult;
		let failure: BatchExecutionError | undefined;
		try {
			result = await this.computer(actions, spec.execution.coordinates, signal);
		} catch (error) {
			if (!(error instanceof BatchExecutionError) || !spec.execution.batch) {
				throw new Error(`${spec.name} failed: ${errorMessage(error)}`, { cause: error });
			}
			result = error.result;
			failure = error;
		}

		const semanticFailure = hasUnsatisfiedSemanticRead(result.readResults);
		const isError = failure !== undefined || semanticFailure;
		const formatted = formatReadResults(result.readResults, isError);
		if (isError) {
			const message = failure
				? `Action ${failure.failedActionIndex} failed: ${errorMessage(failure.cause)}`
				: `Action ${result.stoppedActionIndex ?? "unknown"} stopped at an unsatisfied semantic browser condition.`;
			formatted.content.push({ type: "text", text: message });
		}
		if (formatted.content.length === 0) formatted.content.push({ type: "text", text: "Actions executed successfully." });

		const skippedActions = result.skippedActions ?? 0;
		const statusText = isError
			? `Actions stopped before completion.${skippedActions ? ` ${skippedActions} action${skippedActions === 1 ? " was" : "s were"} skipped.` : ""}`
			: "Actions executed successfully.";
		return {
			content: formatted.content,
			details: {
				statusText,
				...(formatted.details.length ? { readResults: formatted.details } : {}),
				...(skippedActions ? { skippedActions } : {}),
				...(failure ? { failedActionIndex: failure.failedActionIndex } : {}),
				...(!failure && semanticFailure && result.stoppedActionIndex !== undefined ? { failedActionIndex: result.stoppedActionIndex } : {}),
				...(isError ? { isError: true } : {}),
			},
		};
	}

	private async executePlaywright(name: string, input: unknown): Promise<LoopToolExecutionResult> {
		const parameters = asRecord(input);
		const code = parameters.code;
		if (typeof code !== "string") throw new Error(`${name} requires string code`);
		try {
			const execution = await this.playwright(code, typeof parameters.timeout_sec === "number" ? parameters.timeout_sec : undefined);
			const content: ToolContent = [];
			if (execution.result !== undefined) content.push({ type: "text", text: `result: ${formatValue(execution.result)}` });
			if (execution.stdout?.trim()) content.push({ type: "text", text: `stdout:\n${execution.stdout.trimEnd()}` });
			if (execution.stderr?.trim()) content.push({ type: "text", text: `stderr:\n${execution.stderr.trimEnd()}` });
			if (!execution.success) content.push({ type: "text", text: `error: ${execution.error ?? "playwright execution reported failure"}` });
			const statusText = execution.success ? "Playwright executed successfully." : `Playwright execution failed: ${execution.error ?? "unknown error"}`;
			if (content.length === 0) content.push({ type: "text", text: statusText });
			return {
				content,
				details: {
					statusText,
					...(execution.result !== undefined ? { result: execution.result } : {}),
					...(execution.stdout ? { stdout: execution.stdout } : {}),
					...(execution.stderr ? { stderr: execution.stderr } : {}),
					...(execution.error ? { error: execution.error } : {}),
				},
			};
		} catch (error) {
			throw new Error(`${name} failed: ${errorMessage(error)}`, { cause: error });
		}
	}
}

function formatReadResults(
	reads: readonly BatchReadResult[],
	replaceImages: boolean,
): { content: ToolContent; details: Array<Record<string, unknown>> } {
	const content: ToolContent = [];
	const details: Array<Record<string, unknown>> = [];
	for (const read of reads) {
		switch (read.type) {
			case "url":
				content.push({ type: "text", text: `url(): ${read.url}` });
				details.push({ type: "url", url: read.url });
				break;
			case "cursor_position":
				content.push({ type: "text", text: `cursor_position(): ${read.x},${read.y}` });
				details.push({ type: "cursor_position", x: read.x, y: read.y });
				break;
			case "browser_text":
				content.push({ type: "text", text: read.text });
				details.push({ type: "browser_text", label: read.label, bytes: read.text.length });
				break;
			case "browser_wait_for":
				content.push({ type: "text", text: formatBrowserWaitResult(read.result) });
				details.push({ type: "browser_wait_for", result: read.result });
				break;
			case "browser_act":
				content.push({ type: "text", text: formatBrowserActResult(read.result) });
				details.push({ type: "browser_act", result: read.result });
				break;
			case "screenshot":
				details.push({ type: "screenshot", bytes: read.data.length });
				if (replaceImages) content.push({ type: "text", text: `[screenshot captured: ${read.data.length} bytes]` });
				else content.push(toImage(read));
				break;
		}
	}
	return { content, details };
}

function hasUnsatisfiedSemanticRead(reads: readonly BatchReadResult[]): boolean {
	return reads.some((read) =>
		read.type === "browser_wait_for"
			? read.result.status !== "satisfied"
			: read.type === "browser_act" && (
				read.result.outcome === "didnt"
				|| (read.result.outcome === "unknown" && read.result.stop_reason !== undefined)
			),
	);
}

function formatBrowserWaitResult(result: BrowserWaitForResult): string {
	const reason = result.reason ? ` (${result.reason})` : "";
	return [`wait_for: ${result.status}/${result.evidence}${reason} after ${result.elapsed_ms}ms`, ...result.details].join("\n");
}

function toImage(screenshot: { data: Buffer; mimeType: string }): LoopToolResultContent {
	return { type: "image", data: screenshot.data.toString("base64"), mimeType: screenshot.mimeType };
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tool input must be an object");
	return value as Record<string, unknown>;
}

function formatValue(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
