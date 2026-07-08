import {
	Type,
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type Static,
	type TSchema,
	type Tool,
} from "@earendil-works/pi-ai";
import { CUA_DEFAULT_COMPUTER_ACTION_TYPES, cuaActionSchemaByType, type CuaAction, type CuaActionType } from "../actions/index";
import { cuaToolDescriptionForAction, cuaToolNameForAction, defaultActionsForMode, schemaOptionsForMode, type CuaMode } from "../modes";
import type { ResolvedCuaNativeTool } from "../native-tools";
import type { CuaModelRef, CuaProvider } from "../models";

export * from "../actions/index";
export * from "../modes";
export * from "../native-tools";

/**
 * The default computer-mode action set: every computer-plane action except `zoom`.
 * The full canonical vocabulary is split by plane into
 * {@link CUA_COMPUTER_ACTION_TYPES} and {@link CUA_BROWSER_ACTION_TYPES}.
 */
export const CUA_ACTION_TYPES = CUA_DEFAULT_COMPUTER_ACTION_TYPES;

type ObjectSchemaWithProperties = TSchema & { properties: Record<string, TSchema> };

function createCuaActionArgumentSchema(action: CuaActionType, mode: CuaMode): TSchema {
	const schemaByType = cuaActionSchemaByType(schemaOptionsForMode(mode));
	const { type: _type, ...properties } = (schemaByType[action] as ObjectSchemaWithProperties).properties;
	return Type.Object(properties, { additionalProperties: false });
}

export function createCuaActionSchema(actions: readonly CuaActionType[] = CUA_ACTION_TYPES, mode: CuaMode = "computer"): TSchema {
	if (actions.length === 0) throw new Error("actions must include at least one CUA action type");
	const schemaByType = cuaActionSchemaByType(schemaOptionsForMode(mode));
	if (actions.length === 1) return schemaByType[actions[0]!];
	return Type.Union(actions.map((action) => schemaByType[action]));
}

export function createCuaActionToolDefinitions(actions: readonly CuaActionType[] = CUA_ACTION_TYPES, mode: CuaMode = "computer"): Tool[] {
	return actions.map((action) => ({
		name: cuaToolNameForAction(action, mode),
		description: cuaToolDescriptionForAction(action, mode),
		parameters: createCuaActionArgumentSchema(action, mode),
	}));
}

export const CuaActionSchema = createCuaActionSchema();

export function createCuaBatchSchema(actions?: readonly CuaActionType[], mode: CuaMode = "computer"): TSchema {
	return Type.Object({
		actions: Type.Array(createCuaActionSchema(actions, mode), { description: "Ordered computer actions to execute." }),
	});
}

export const CuaBatchSchema = createCuaBatchSchema();

export const CuaNavigationSchema = Type.Object(
	{
		action: Type.Union([Type.Literal("goto"), Type.Literal("back"), Type.Literal("forward"), Type.Literal("url")]),
		url: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const CuaPlaywrightSchema = Type.Object(
	{
		code: Type.String({
			description:
				"Playwright/TypeScript to run against the live browser. `page`, `context`, and `browser` are in scope; end with a `return` to send a JSON-serializable value back. Example: \"await page.goto('https://example.com'); return await page.title();\"",
		}),
		timeout_sec: Type.Optional(Type.Number({ description: "Optional execution timeout in seconds. Default 60, max 300." })),
	},
	{ additionalProperties: false },
);

export interface CuaBatchInput {
	actions: CuaAction[];
}
export type CuaNavigationInput = Static<typeof CuaNavigationSchema>;
export type CuaPlaywrightInput = Static<typeof CuaPlaywrightSchema>;

/** Tool schema plus execution adapter for a browser computer-use tool. */
export interface CuaToolExecutorSpec {
	/** Tool schema installed by CuaAgent/CuaAgentHarness. The name must match the provider tool call name. */
	definition: Tool;
	/** Convert that tool's arguments into canonical CUA actions for browser execution. */
	toActions(args: unknown): CuaAction[];
}

/**
 * Default name for batch computer-action tools created by
 * {@link createCuaBatchToolDefinition} and the name Anthropic's batch tool
 * ships under (the only provider that includes one by default).
 */
export const CUA_BATCH_TOOL_NAME = "computer_batch";
export const CUA_NAVIGATION_TOOL_NAME = "computer_use_extra";
export const CUA_PLAYWRIGHT_TOOL_NAME = "playwright_execute";

export const CUA_BATCH_TOOL_DESCRIPTION = [
	"Execute multiple computer actions in sequence, including ordered read steps like url(), cursor_position(), and screenshot().",
	"Prefer this tool for predictable browser interaction sequences such as click-then-type, typing a URL, keyboard navigation, drag paths, and mixed write/read batches.",
	"If no explicit read step is included, the tool returns one fresh screenshot after execution.",
].join("\n");

export const CUA_NAVIGATION_TOOL_DESCRIPTION = "High-level browser navigation helpers for goto, back, forward, and url.";

export const CUA_PLAYWRIGHT_TOOL_DESCRIPTION = [
	"Run Playwright/TypeScript directly against the live browser session for steps that are awkward as raw pointer/keyboard actions: precise DOM reads, form fills, data extraction, and waiting on selectors.",
	"`page`, `context`, and `browser` are in scope and the code may `return` a JSON-serializable value, which comes back as the result.",
	"Each call runs in a fresh JS context — local variables do not persist across calls, but the browser session does (navigation, cookies, DOM state carry over via `page`/`context`/`browser`).",
	"No screenshot is returned automatically; request one with a follow-up screenshot action when you need to see the page, rather than calling page.screenshot() inside the code.",
].join("\n");

export interface ComputerToolsOptions {
	actions?: readonly CuaActionType[];
	/** Which action plane(s) to expose. Default "computer". */
	mode?: CuaMode;
}

export type ComputerToolCoordinateSystem =
	| {
			type: "pixel";
		}
	| {
			type: "normalized";
			range: readonly [number, number];
		};

/**
 * Build the provider's CUA computer-use tools.
 *
 * Use this when calling `complete()` or `stream()` directly and you need an
 * array of `Tool` objects for browser actions. Pass `actions` to expose only a
 * smaller set, such as `["click"]`.
 */
export function computerTools(options: ComputerToolsOptions = {}): Tool[] {
	return createCuaActionToolDefinitions(resolveModeActions(options), options.mode ?? "computer");
}

/** Resolve the action list for a tools-options object: explicit list, or the mode's default set. */
export function resolveModeActions(options: ComputerToolsOptions = {}): readonly CuaActionType[] {
	return options.actions ?? defaultActionsForMode(options.mode ?? "computer");
}

/** Guard for providers whose computer-use vocabulary only covers the computer plane. */
export function assertComputerModeOnly(provider: CuaProvider, options: ComputerToolsOptions = {}): void {
	const mode = options.mode ?? "computer";
	if (mode !== "computer") throw new Error(`provider "${provider}" does not support mode "${mode}" (computer only)`);
}

/** Build execution adapters for individual canonical CUA action tools. */
export function createCuaActionToolExecutors(actions: readonly CuaActionType[] = CUA_ACTION_TYPES, mode: CuaMode = "computer"): CuaToolExecutorSpec[] {
	const definitions = createCuaActionToolDefinitions(actions, mode);
	return definitions.map((definition, index) => {
		const actionType = actions[index]!;
		return {
			definition,
			toActions(args: unknown): CuaAction[] {
				return [{ ...(args && typeof args === "object" ? args : {}), type: actionType } as CuaAction];
			},
		};
	});
}

/** Return the canonical tool name that should execute a normalized CUA action. */
export function canonicalToolCallName(action: CuaAction): CuaActionType {
	return action.type;
}

/** Convert a normalized CUA action into tool-call arguments by removing its `type` tag. */
export function canonicalToolCallArguments(action: CuaAction): Record<string, unknown> {
	const { type: _type, ...args } = action as CuaAction & Record<string, unknown>;
	return args;
}

/** Prefix bare hostnames/paths with `https://` before browser navigation. */
export function normalizeGotoUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const url = value.trim();
	if (!url) return undefined;
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

export function createCuaBatchToolDefinition(
	actions?: readonly CuaActionType[],
	options: { name?: string; description?: string; mode?: CuaMode } = {},
): Tool {
	return {
		name: options.name ?? CUA_BATCH_TOOL_NAME,
		description: options.description ?? CUA_BATCH_TOOL_DESCRIPTION,
		parameters: createCuaBatchSchema(actions, options.mode ?? "computer"),
	};
}

/** Build an execution adapter for a batch tool whose input is `{ actions }`. */
export function createCuaBatchToolExecutor(
	actions?: readonly CuaActionType[],
	options: { name?: string; description?: string; mode?: CuaMode } = {},
): CuaToolExecutorSpec {
	const definition = createCuaBatchToolDefinition(actions, options);
	return {
		definition,
		toActions(args: unknown): CuaAction[] {
			if (!isBatchInput(args)) throw new Error("invalid batch tool parameters");
			return args.actions;
		},
	};
}

/** Build the provider's default CUA tool execution adapters. */
export function computerToolExecutors(options: ComputerToolsOptions = {}): CuaToolExecutorSpec[] {
	return createCuaActionToolExecutors(resolveModeActions(options), options.mode ?? "computer");
}

function isBatchInput(value: unknown): value is CuaBatchInput {
	return Boolean(value && typeof value === "object" && Array.isArray((value as { actions?: unknown }).actions));
}

export function createCuaNavigationToolDefinition(): Tool {
	return {
		name: CUA_NAVIGATION_TOOL_NAME,
		description: CUA_NAVIGATION_TOOL_DESCRIPTION,
		parameters: CuaNavigationSchema,
	};
}

export function createCuaPlaywrightToolDefinition(): Tool {
	return {
		name: CUA_PLAYWRIGHT_TOOL_NAME,
		description: CUA_PLAYWRIGHT_TOOL_DESCRIPTION,
		parameters: CuaPlaywrightSchema,
	};
}

export interface CuaScreenshotTransformSpec {
	width: number;
	height: number;
	format: "png" | "jpeg" | "webp";
	quality?: number;
}

export interface CuaScreenshotSpec {
	/** Append a provider-prepared screenshot to the latest user/tool message before each request. */
	appendToLatestMessage?: boolean;
	/** Optional image transform applied to Kernel screenshots before they are sent to the provider. */
	transform?: CuaScreenshotTransformSpec;
}

export interface CuaPayloadContext {
	/** Tool names that should remain in the outbound provider payload even if the provider strips local CUA executors. */
	keepToolNames?: readonly string[];
	/** Capture a fresh browser screenshot, already transformed per the provider's screenshot spec. */
	getScreenshot?: () => Promise<{ data: Buffer; mimeType: string }>;
}

export type CuaPayloadHook = (payload: unknown, model: Model<Api>, context?: CuaPayloadContext) => unknown | Promise<unknown>;

/**
 * pi-ai `SimpleStreamOptions` plus the CUA extension consumed by the
 * Yutori/Tzafon stream adapters. Pass `keepToolNames` for caller tools that
 * must survive provider-native tool-set substitution.
 */
export interface CuaSimpleStreamOptions extends SimpleStreamOptions {
	keepToolNames?: readonly string[];
}

/** Environment variable that disables server-side `previous_response_id` threading when truthy. */
export const CUA_DISABLE_RESPONSE_THREADING_ENV_VAR = "CUA_DISABLE_RESPONSE_THREADING";

/** Per-call control over `previous_response_id` threading for Responses API providers. */
export interface ResponseThreadingOptions {
	/** Force full-history replay for this request, overriding the environment default. */
	disableResponseThreading?: boolean;
}

/**
 * Whether a Responses API provider should thread requests with
 * `previous_response_id` + delta input instead of replaying the full message
 * history. Threading is on by default and disabled by an explicit option or a
 * truthy {@link CUA_DISABLE_RESPONSE_THREADING_ENV_VAR}.
 */
export function responseThreadingEnabled(options?: ResponseThreadingOptions): boolean {
	if (options?.disableResponseThreading) return false;
	const flag = process.env[CUA_DISABLE_RESPONSE_THREADING_ENV_VAR];
	return !(flag && flag !== "0" && flag.toLowerCase() !== "false");
}

/** Result of {@link responseThreadingDelta}: the chaining id and the messages to send this turn. */
export interface ResponseThreadingDelta {
	/** The most recent assistant turn's `responseId`, or undefined when it has none. */
	previousResponseId?: string;
	/** Messages to send this turn: those after the anchor assistant turn, or all messages when not threading. */
	deltaMessages: Message[];
}

/**
 * Derive the `previous_response_id` continuation from a message history.
 *
 * Anchors on the most recent assistant turn: returns its `responseId` and the
 * messages after it (the delta). An errored or aborted turn may carry a
 * `responseId` captured from an incomplete response the server never stored, so
 * its id is ignored. When the anchor has no usable `responseId`, or there is no
 * assistant turn yet, returns every message and no id so the caller replays the
 * full history, rather than chaining to a phantom id and pruning past it.
 */
export function responseThreadingDelta(messages: readonly Message[]): ResponseThreadingDelta {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]!;
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		const failed = assistant.stopReason === "error" || assistant.stopReason === "aborted";
		const responseId = failed ? undefined : assistant.responseId;
		return responseId ? { previousResponseId: responseId, deltaMessages: messages.slice(index + 1) } : { deltaMessages: [...messages] };
	}
	return { deltaMessages: [...messages] };
}

/**
 * Runtime configuration for a supported CUA model.
 *
 * Use this to pair a model with the agent tool definitions, baseline prompt,
 * coordinate convention, screenshot policy, and request payload middleware
 * expected by its provider.
 */
export interface CuaRuntimeSpec {
	model: Model<Api>;
	provider: CuaProvider;
	/** Which canonical action plane(s) this runtime exposes. */
	mode: CuaMode;
	/** Present when the model is driven through a provider-native tool declaration. */
	nativeTool?: ResolvedCuaNativeTool;
	/** Provider-facing CUA tool definitions used for model requests. */
	toolDefinitions: Tool[];
	/** Local execution adapters that turn provider tool calls into canonical CUA actions. */
	toolExecutors: CuaToolExecutorSpec[];
	/** Provider-tuned baseline prompt for browser control behavior. */
	defaultSystemPrompt: string;
	/** Coordinate convention emitted by provider tool calls. */
	coordinateSystem: ComputerToolCoordinateSystem;
	/** Optional provider screenshot input policy used by CuaAgent/CuaAgentHarness. */
	screenshot?: CuaScreenshotSpec;
	/** Optional provider middleware for request payload adaptation. */
	onPayload?: CuaPayloadHook;
}

export type CuaRuntimeSpecInput = CuaModelRef | Model<Api>;

/** Uniform provider contract resolved by the CUA runtime registry. */
export interface CuaProviderModule {
	/** Model-facing CUA tool definitions sent in provider requests. */
	toolDefinitions(options?: ComputerToolsOptions): Tool[];
	/** Local execution adapters (provider tool-call name -> canonical CUA actions). */
	toolExecutors(options?: ComputerToolsOptions): CuaToolExecutorSpec[];
	/** Coordinate convention emitted by this provider's tool calls. */
	coordinateSystem(): ComputerToolCoordinateSystem;
	/** Provider-tuned baseline browser-control system prompt. */
	buildSystemPrompt(opts?: { suffix?: string; mode?: CuaMode }): string;
	/** Optional request-payload middleware for provider protocol quirks. */
	onPayload?: CuaPayloadHook;
	/** Optional provider screenshot input policy. */
	screenshot?: CuaScreenshotSpec;
}
