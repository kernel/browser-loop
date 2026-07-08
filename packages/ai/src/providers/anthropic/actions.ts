import type { Tool, TSchema } from "@earendil-works/pi-ai";
import {
	CUA_BATCH_TOOL_DESCRIPTION,
	CUA_BATCH_TOOL_NAME,
	CUA_BROWSER_ACTION_TYPES,
	createCuaActionSchema,
	createCuaActionToolExecutors,
	createCuaActionToolDefinitions,
	createCuaBatchToolExecutor,
	createCuaBatchToolDefinition,
	defaultActionsForMode,
	isCuaBrowserActionType,
	type ComputerToolsOptions,
	type CuaAction,
	type CuaActionType,
	type CuaMode,
	type CuaToolExecutorSpec,
} from "../common";

/**
 * Canonical CUA action types Anthropic browser computer-use tools support.
 *
 * Source of truth: Anthropic's computer-use best-practices quickstart
 * computer/browser tool action enums. These are the browser actions Anthropic
 * currently accepts under CUA's canonical individual tool names.
 * https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-best-practices/computer_use/tools/computer.py
 * https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-best-practices/computer_use/tools/browser.py
 */
export const ANTHROPIC_CUA_ACTION_TYPES = [
	"click",
	"double_click",
	"mouse_down",
	"mouse_up",
	"type",
	"keypress",
	"scroll",
	"move",
	"drag",
	"wait",
	"screenshot",
	"zoom",
	"goto",
	"cursor_position",
] as const satisfies readonly CuaActionType[];

type AnthropicCanonicalActionType = (typeof ANTHROPIC_CUA_ACTION_TYPES)[number] | (typeof CUA_BROWSER_ACTION_TYPES)[number];

const ANTHROPIC_CANONICAL_ACTION_TYPE_SET: ReadonlySet<string> = new Set([...ANTHROPIC_CUA_ACTION_TYPES, ...CUA_BROWSER_ACTION_TYPES]);

/** Name of the batch tool included by default in Anthropic computer-use tools. */
export const ANTHROPIC_BATCH_TOOL_NAME = CUA_BATCH_TOOL_NAME;

const ANTHROPIC_BATCH_TOOL_DESCRIPTION = [
	CUA_BATCH_TOOL_DESCRIPTION,
	"Coordinates in a batch refer to the screenshot taken before the batch call.",
].join("\n");

/** Options for building Anthropic browser computer-use tools. */
export interface AnthropicComputerToolsOptions extends ComputerToolsOptions {
	/** Exclude the batch computer action tool from the returned tools. */
	excludeBatch?: boolean;
}

/** Canonical CUA action shape supported by Anthropic browser computer-use tools. */
export type AnthropicAction = Extract<CuaAction, { type: AnthropicCanonicalActionType }>;

function resolveAnthropicActions(options: AnthropicComputerToolsOptions): readonly AnthropicCanonicalActionType[] {
	const mode = options.mode ?? "computer";
	const resolved =
		options.actions ??
		(mode === "computer"
			? ANTHROPIC_CUA_ACTION_TYPES.filter((action) => action !== "zoom")
			: defaultActionsForMode(mode, { javascriptExec: options.javascriptExec }).filter(
					(action) => isCuaBrowserActionType(action) || isAnthropicCanonicalAction(action),
				));
	const supported: AnthropicCanonicalActionType[] = [];
	const unsupported: CuaActionType[] = [];
	for (const action of resolved) {
		if (isAnthropicCanonicalAction(action)) supported.push(action);
		else unsupported.push(action);
	}
	if (unsupported.length > 0) throw new Error(`unsupported Anthropic canonical action(s): ${unsupported.join(", ")}`);
	return supported;
}

function isAnthropicCanonicalAction(action: CuaActionType): action is AnthropicCanonicalActionType {
	return ANTHROPIC_CANONICAL_ACTION_TYPE_SET.has(action);
}

/** Build the TypeBox schema for Anthropic-supported canonical browser actions. */
export function createActionSchema(actions?: readonly CuaActionType[], mode: CuaMode = "computer"): TSchema {
	return createCuaActionSchema(resolveAnthropicActions({ actions, mode }), mode);
}

/**
 * Build Anthropic CUA computer-use tools.
 *
 * Use this when calling `complete()` or `stream()` directly and you need an
 * array of `Tool` objects for Anthropic browser actions. Pass `actions` to
 * expose only a supported subset, such as `["click"]`. Anthropic includes a
 * batch tool by default; pass `excludeBatch: true` to omit it.
 */
export function computerTools(options: AnthropicComputerToolsOptions = {}): Tool[] {
	const mode = options.mode ?? "computer";
	const actions = resolveAnthropicActions(options);
	const tools = createCuaActionToolDefinitions(actions, mode);
	if (!options.excludeBatch) {
		tools.push(createCuaBatchToolDefinition(actions, {
			name: ANTHROPIC_BATCH_TOOL_NAME,
			description: ANTHROPIC_BATCH_TOOL_DESCRIPTION,
			mode,
		}));
	}
	return tools;
}

/** Build the local execution adapters used by CuaAgent and CuaAgentHarness. */
export function computerToolExecutors(options: AnthropicComputerToolsOptions = {}): CuaToolExecutorSpec[] {
	const mode = options.mode ?? "computer";
	const actions = resolveAnthropicActions(options);
	const executors = createCuaActionToolExecutors(actions, mode);
	if (!options.excludeBatch) {
		executors.push(createCuaBatchToolExecutor(actions, {
			name: ANTHROPIC_BATCH_TOOL_NAME,
			description: ANTHROPIC_BATCH_TOOL_DESCRIPTION,
			mode,
		}));
	}
	return executors;
}
