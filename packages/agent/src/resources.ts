import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type Kernel from "@onkernel/sdk";
import {
	type CuaAction,
	type CuaCoordinateContract,
	type CuaToolCatalogResources,
	type CuaToolSpec,
} from "@onkernel/cua-ai";
import { formatBrowserActResult } from "./browser-result-format";
import { BatchExecutionError, InternalComputerTranslator, type KernelBrowser, type PlaywrightExecutionResult } from "./translator/translator";
import type { BrowserExecutor } from "./translator/browser";
import type { BatchExecutionResult, BatchReadResult, BrowserWaitForResult } from "./translator/types";

/** Structured execution metadata returned by materialized CUA tools. */
export interface CuaExecutionDetails {
	statusText: string;
	readResults?: Array<Record<string, unknown>>;
	skippedActions?: number;
	failedActionIndex?: number;
	/** Internal marker consumed by CuaAgent/CuaAgentHarness to set ToolResultMessage.isError. */
	isError?: boolean;
	result?: unknown;
	stdout?: string;
	stderr?: string;
	error?: string;
}

type ToolContent = Array<TextContent | ImageContent>;

/**
 * One per-agent browser resource pool. Tool catalogs may be rebuilt without
 * replacing this object, its lazy CDP connection, refs, or tab lifecycle.
 */
export class CuaExecutionResources implements CuaToolCatalogResources {
	readonly browser: KernelBrowser;
	readonly client: Kernel;
	readonly viewport: { readonly width: number; readonly height: number };
	private readonly translator: InternalComputerTranslator;

	constructor(options: {
		browser: KernelBrowser;
		client: Kernel;
		/** Test seam; production uses the pool's lazy raw-CDP BrowserExecutor. */
		createBrowserExecutor?: (cdpWsUrl: string) => BrowserExecutor;
	}) {
		this.browser = options.browser;
		this.client = options.client;
		this.viewport = options.browser.viewport ?? { width: 1920, height: 1080 };
		this.translator = new InternalComputerTranslator(options);
	}

	materialize(spec: CuaToolSpec): AgentTool {
		const definition = spec.declaration;
		return {
			name: spec.name,
			label: spec.name,
			description: definition.description,
			parameters: definition.parameters,
			executionMode: "sequential",
			execute: async (_toolCallId, input, signal) => {
				if (spec.execution.kind === "playwright") return this.executePlaywright(spec.name, input);
				const actions = spec.execution.toActions(input);
				return this.executeActions(spec, actions, signal);
			},
		};
	}

	async computer(actions: CuaAction[], coordinateContract: CuaCoordinateContract, signal?: AbortSignal): Promise<BatchExecutionResult> {
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

	private async executeActions(spec: CuaToolSpec, actions: CuaAction[], signal?: AbortSignal): Promise<AgentToolResult<CuaExecutionDetails>> {
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

		const semanticFailure = spec.execution.batch && hasUnsatisfiedSemanticRead(result.readResults);
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

	private async executePlaywright(name: string, input: unknown): Promise<AgentToolResult<CuaExecutionDetails>> {
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
			: read.type === "browser_act" && (read.result.outcome === "didnt" || read.result.stop_reason !== undefined),
	);
}

function formatBrowserWaitResult(result: BrowserWaitForResult): string {
	const reason = result.reason ? ` (${result.reason})` : "";
	return [`wait_for: ${result.status}/${result.evidence}${reason} after ${result.elapsed_ms}ms`, ...result.details].join("\n");
}

function toImage(screenshot: { data: Buffer; mimeType: string }): ImageContent {
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
