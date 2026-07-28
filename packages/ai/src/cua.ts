import { Type, type Static, type Tool, type TSchema } from "@earendil-works/pi-ai";
import {
	CUA_COMPUTER_ACTION_TYPES,
	createCuaBrowserActionSchemaByType,
	type CuaAction,
	type CuaBrowserActionType,
	type CuaComputerActionType,
} from "./actions/index";
import { supportsAnthropicNativeBrowser } from "./providers/anthropic/capabilities";
import { mapNativeBrowserInput, mapNativeComputerInput } from "./providers/anthropic/native";
import { toCanonicalActions as toTzafonActions } from "./providers/tzafon/provider";
import {
	toCanonicalActions as toYutoriActions,
	YUTORI_N1_ACTION_TYPES,
	YUTORI_N15_CORE_ACTION_TYPES,
	YUTORI_N15_CORE_TOOL_SET,
} from "./providers/yutori/actions";
import {
	CUA_TOOL_SPEC_KIND,
	type CuaCoordinateContract,
	type CuaProviderBinding,
	type CuaToolDynamicLoading,
	type CuaToolExecution,
	type CuaToolOrigin,
	type CuaToolResultPolicy,
	type CuaToolSpec,
	type CuaToolTransport,
} from "./tool-catalog";

export interface CuaToolNameOptions {
	/** Explicit model-facing alias. Provider-native fixed-name tools do not accept this option. */
	name?: string;
}

export interface CuaComputerToolOptions extends CuaToolNameOptions {
	coordinates?: CuaCoordinateContract;
}

export interface CuaToolsetOptions {
	/** Deterministically prefixes every preferred name as `<namespace>_<preferredName>`. */
	namespace?: string;
}

export interface CuaComputerToolsetOptions extends CuaToolsetOptions {
	coordinates?: CuaCoordinateContract;
}

export type CuaBrowserBatchAction =
	| "snapshot"
	| "text"
	| "find"
	| "click"
	| "hover"
	| "drag"
	| "fill"
	| "scroll_to"
	| "scroll"
	| "type"
	| "key"
	| "navigate"
	| "list_tabs"
	| "new_tab"
	| "screenshot"
	| "evaluate"
	| "wait_for";

export interface CuaComputerBatchOptions extends CuaToolNameOptions {
	actions: readonly CuaComputerActionType[];
	coordinates?: CuaCoordinateContract;
}

export interface CuaBrowserBatchOptions extends CuaToolNameOptions {
	actions: readonly CuaBrowserBatchAction[];
}

const pixels = Object.freeze({ type: "pixel" as const });

function normalized(range: readonly [number, number]): CuaCoordinateContract {
	if (!Number.isFinite(range[0]) || !Number.isFinite(range[1]) || range[1] <= range[0]) {
		throw new Error("normalized coordinate range must contain two finite, ascending values");
	}
	return Object.freeze({ type: "normalized", range: Object.freeze([range[0], range[1]] as const) });
}

function coordinateDescription(contract: CuaCoordinateContract): string {
	return contract.type === "pixel"
		? "Coordinates are pixels in the latest OS screenshot."
		: `Coordinates are normalized to [${contract.range[0]}, ${contract.range[1]}] in the latest OS screenshot.`;
}

const browserSchemas = createCuaBrowserActionSchemaByType({ coordinates: true });

const browserActionByFactory = {
	snapshot: "browser_snapshot",
	text: "browser_text",
	find: "browser_find",
	click: "browser_click",
	hover: "browser_hover",
	drag: "browser_drag",
	fill: "browser_fill",
	scrollTo: "browser_scroll_to",
	scroll: "browser_scroll",
	type: "browser_type",
	key: "browser_key",
	navigate: "browser_navigate",
	listTabs: "browser_list_tabs",
	newTab: "browser_new_tab",
	screenshot: "browser_screenshot",
	evaluate: "browser_evaluate",
	waitFor: "browser_wait_for",
	act: "browser_act",
} as const;

type BrowserFactoryName = keyof typeof browserActionByFactory;

const computerFactoryAction = {
	click: "click",
	doubleClick: "double_click",
	mouseDown: "mouse_down",
	mouseUp: "mouse_up",
	type: "type",
	keypress: "keypress",
	scroll: "scroll",
	move: "move",
	drag: "drag",
	wait: "wait",
	screenshot: "screenshot",
	zoom: "zoom",
	goto: "goto",
	back: "back",
	forward: "forward",
	url: "url",
	cursorPosition: "cursor_position",
} as const;

type ComputerFactoryName = keyof typeof computerFactoryAction;

const browserDescriptions: Record<CuaBrowserActionType, string> = {
	browser_act: "Run 1–20 dependent browser actions with semantic expectations. Ref-based steps require current refs from browser_snapshot or browser_find; never invent refs, and re-snapshot after navigation or when a ref is stale. The plan stops at failed or unverifiable boundaries and returns causal outcomes plus a stable successor snapshot.",
	browser_snapshot: "Return an accessibility snapshot with element refs. Re-snapshot after navigation or when a ref is stale.",
	browser_text: "Return visible page text.",
	browser_find: "Find matching elements and return snapshot-scoped refs.",
	browser_click: "Click an element, preferably by a ref from a current snapshot.",
	browser_hover: "Hover an element.",
	browser_drag: "Drag between viewport coordinates.",
	browser_fill: "Set a form element value by ref.",
	browser_scroll_to: "Scroll an element ref into view.",
	browser_scroll: "Scroll the page at a viewport position.",
	browser_type: "Type literal text at the current focus.",
	browser_key: "Press a key or chord.",
	browser_navigate: "Navigate to a URL or move back/forward in history.",
	browser_list_tabs: "List open tabs.",
	browser_new_tab: "Open a new tab.",
	browser_screenshot: "Capture the current viewport.",
	browser_evaluate: "Execute JavaScript in the page context.",
	browser_wait_for: "Wait for page text, element, URL, title, value, or state evidence without delivering input.",
};

function browserTool(factory: BrowserFactoryName, options: CuaToolNameOptions = {}): CuaToolSpec {
	const action = browserActionByFactory[factory];
	const preferredName = action;
	const resultPolicy: CuaToolResultPolicy = action === "browser_act"
		? "browser-act"
		: action === "browser_wait_for" ? "browser-wait" : "browser";
	return createSpec({
		identity: `cua.browser.${action.slice("browser_".length).replaceAll("_", "-")}.v1`,
		preferredName,
		name: options.name,
		origin: "cua",
		declaration: {
			name: preferredName,
			description: browserDescriptions[action],
			parameters: removeDiscriminator(browserSchemas[action], "type"),
		},
		execution: {
			kind: "actions",
			toActions: (input) => [{ ...asInput(input), type: action } as CuaAction],
			coordinates: pixels,
			resultPolicy,
			batch: false,
		},
		executorFingerprint: `browser-${action}-v1`,
		stateMutating: !["browser_snapshot", "browser_text", "browser_find", "browser_list_tabs", "browser_screenshot", "browser_wait_for"].includes(action),
		complexSchema: action === "browser_wait_for" || action === "browser_act",
	});
}

function computerTool(factory: ComputerFactoryName, options: CuaComputerToolOptions = {}): CuaToolSpec {
	const action = computerFactoryAction[factory];
	const preferredName = `computer_${action}`;
	const schema = computerSchema(action);
	const coordinates = options.coordinates ?? pixels;
	return createSpec({
		identity: `cua.computer.${action.replaceAll("_", "-")}.v1`,
		preferredName,
		name: options.name,
		origin: "cua",
		declaration: {
			name: preferredName,
			description: `Execute one ${action} computer action. ${coordinateDescription(coordinates)}`,
			parameters: schema,
		},
		execution: {
			kind: "actions",
			toActions: (input) => [{ ...asInput(input), type: action } as CuaAction],
			coordinates,
			resultPolicy: "computer",
			batch: false,
		},
		executorFingerprint: `computer-${action}-v1`,
		stateMutating: !["screenshot", "zoom", "url", "cursor_position"].includes(action),
	});
}

function computerBatch(options: CuaComputerBatchOptions): CuaToolSpec {
	if (!options.actions?.length) throw new Error("computer_batch actions must be non-empty");
	const actions = uniqueKnownComputerActions(options.actions);
	const coordinates = options.coordinates ?? pixels;
	const actionSchemas = actions.map((action) => renameDiscriminator(computerActionSchema(action), "type", "action"));
	return createSpec({
		identity: "cua.computer.batch.v1",
		preferredName: "computer_batch",
		name: options.name,
		origin: "cua",
		declaration: {
			name: "computer_batch",
			description: `Execute an explicit ordered sequence of computer-plane actions. Reads flush pending writes; execution stops at the first failure. ${coordinateDescription(coordinates)}`,
			parameters: Type.Object({ actions: Type.Array(actionSchemas.length === 1 ? actionSchemas[0]! : Type.Union(actionSchemas), { minItems: 1 }) }, { additionalProperties: false }),
		},
		execution: {
			kind: "actions",
			toActions(input) {
				const value = asActionsInput(input);
				return value.actions.map((action) => ({ ...action, type: requireString(action.action, "action") } as CuaAction));
			},
			coordinates,
			resultPolicy: "computer",
			batch: true,
		},
		executorFingerprint: `computer-batch-v1:${actions.join(",")}`,
		stateMutating: actions.some((action) => !["screenshot", "zoom", "url", "cursor_position"].includes(action)),
	});
}

function browserBatch(options: CuaBrowserBatchOptions): CuaToolSpec {
	if (!options.actions?.length) throw new Error("browser_batch actions must be non-empty");
	const actions = [...new Set(options.actions)];
	for (const action of actions) {
		if (!browserBatchActionToCanonical(action)) throw new Error(`unsupported browser_batch action "${action}"`);
	}
	const schemas = actions.map((action) => {
		const canonical = browserBatchActionToCanonical(action)!;
		return renameDiscriminator(browserSchemas[canonical], "type", "action", action);
	});
	return createSpec({
		identity: "cua.browser.batch.v1",
		preferredName: "browser_batch",
		name: options.name,
		origin: "cua",
		declaration: {
			name: "browser_batch",
			description: "Execute a mechanical ordered sequence of browser-plane operations over one shared ref table. Snapshot/find refresh refs before later actions; there is no interpolation or workflow syntax.",
			parameters: Type.Object({ actions: Type.Array(schemas.length === 1 ? schemas[0]! : Type.Union(schemas), { minItems: 1 }) }, { additionalProperties: false }),
		},
		execution: {
			kind: "actions",
			toActions(input) {
				const value = asActionsInput(input);
				return value.actions.map((action) => {
					const canonical = browserBatchActionToCanonical(requireString(action.action, "action") as CuaBrowserBatchAction);
					if (!canonical) throw new Error(`unsupported browser_batch action "${String(action.action)}"`);
					const { action: _action, ...parameters } = action;
					return { ...parameters, type: canonical } as CuaAction;
				});
			},
			coordinates: pixels,
			resultPolicy: "browser",
			batch: true,
		},
		executorFingerprint: `browser-batch-v1:${actions.join(",")}`,
		stateMutating: actions.some((action) => !["snapshot", "text", "find", "list_tabs", "screenshot", "wait_for"].includes(action)),
		complexSchema: actions.includes("wait_for"),
	});
}

function playwright(options: CuaToolNameOptions = {}): CuaToolSpec {
	return createSpec({
		identity: "cua.playwright.v1",
		preferredName: "playwright_execute",
		name: options.name,
		origin: "cua",
		declaration: {
			name: "playwright_execute",
			description: "Run Playwright/TypeScript against the live browser. page, context, and browser are in scope. No screenshot is returned automatically.",
			parameters: Type.Object({
				code: Type.String(),
				timeout_sec: Type.Optional(Type.Number({ minimum: 1, maximum: 300 })),
			}, { additionalProperties: false }),
		},
		execution: { kind: "playwright" },
		executorFingerprint: "playwright-v1",
		stateMutating: true,
	});
}

function anthropicNativeComputer(options: { version: "20260701"; enableZoom?: boolean; displayNumber?: number } = { version: "20260701" }): CuaToolSpec {
	if (options.version !== "20260701") throw new Error(`unsupported Anthropic native computer version "${String(options.version)}"`);
	const declaration = {
		type: "computer_20260701",
		name: "computer",
		...(options.enableZoom !== undefined ? { enable_zoom: options.enableZoom } : {}),
		...(options.displayNumber !== undefined ? { display_number: options.displayNumber } : {}),
	};
	return providerNativeSpec({
		identity: "provider.anthropic.native.computer.20260701",
		name: "computer",
		declaration,
		binding: { kind: "anthropic-native", declaration, beta: "computer-use-2026-07-01" },
		toActions: (input) => mapNativeComputerInput(asNativeInput(input)),
		coordinates: pixels,
		resultPolicy: "computer",
		executorFingerprint: `anthropic-native-computer-20260701:${options.enableZoom === true}`,
		stopTurnOnFailureMessage: "Not executed: an earlier computer action in this turn failed.",
	});
}

function anthropicNativeBrowser(options: { version: "20260701"; javascript?: boolean } = { version: "20260701" }): CuaToolSpec {
	if (options.version !== "20260701") throw new Error(`unsupported Anthropic native browser version "${String(options.version)}"`);
	const declaration = {
		type: "browser_20260701",
		name: "browser",
		...(options.javascript !== undefined ? { enable_javascript_exec: options.javascript } : {}),
	};
	return providerNativeSpec({
		identity: "provider.anthropic.native.browser.20260701",
		name: "browser",
		declaration,
		binding: {
			kind: "anthropic-native",
			declaration,
			beta: "browser-use-2026-07-01",
			accessFallback: {
				beta: "browser-use-2026-07-01",
				nativeType: "browser_20260701",
				declaration: anthropicBrowserFunctionFallback(options.javascript !== false),
			},
		},
		toActions: (input) => mapNativeBrowserInput(asNativeInput(input)),
		coordinates: pixels,
		resultPolicy: "browser",
		executorFingerprint: `anthropic-native-browser-20260701:${options.javascript !== false}`,
		stopTurnOnFailureMessage: "Not executed: an earlier action in this turn failed.",
	});
}

const anthropicRecommendedComputerActions = [
	"screenshot", "left_click", "right_click", "middle_click", "double_click", "triple_click", "left_click_drag",
	"mouse_move", "left_mouse_down", "left_mouse_up", "scroll", "type", "key", "hold_key", "wait", "cursor_position", "zoom",
] as const;
const anthropicRecommendedBrowserActions = [
	"navigate", "list_tabs", "new_tab", "read_page", "get_page_text", "find", "form_input", "scroll_to", "screenshot", "zoom",
	"left_click", "right_click", "double_click", "triple_click", "hover", "left_click_drag", "scroll", "type", "key", "wait", "javascript_exec",
] as const;

type AnthropicRecommendedComputerAction = (typeof anthropicRecommendedComputerActions)[number];
type AnthropicRecommendedBrowserAction = (typeof anthropicRecommendedBrowserActions)[number];

function anthropicBrowserFunctionFallback(javascript: boolean): Record<string, unknown> {
	const actions = javascript
		? anthropicRecommendedBrowserActions
		: anthropicRecommendedBrowserActions.filter((action) => action !== "javascript_exec");
	const union = Type.Union(actions.map((action) => anthropicRecommendedActionSchema("browser", action)));
	return {
		name: "browser",
		description: "Use a browser through structured navigation, observation, and interaction actions.",
		input_schema: { ...union, type: "object" },
	};
}

interface AnthropicRecommendedToolsetOptions extends CuaToolsetOptions {
	actions?: readonly string[];
}

function anthropicRecommendedTool(
	plane: "computer" | "browser",
	batch: boolean,
	options: AnthropicRecommendedToolsetOptions = {},
): CuaToolSpec {
	const preferredName = batch ? `${plane}_batch` : plane;
	const name = namespaced(preferredName, options.namespace);
	const allowed = plane === "computer" ? anthropicRecommendedComputerActions : anthropicRecommendedBrowserActions;
	const actions = options.actions ?? allowed;
	for (const action of actions) if (!(allowed as readonly string[]).includes(action)) throw new Error(`unsupported Anthropic ${plane} action "${action}"`);
	const actionSchemas = actions.map((action) => anthropicRecommendedActionSchema(plane, action));
	const nativeSchema = actionSchemas.length === 1 ? actionSchemas[0]! : Type.Union(actionSchemas);
	const parameters = batch
		? Type.Object({ actions: Type.Array(nativeSchema, { minItems: 1 }) }, { additionalProperties: false })
		: nativeSchema;
	return createSpec({
		identity: `provider.anthropic.recommended.${plane}${batch ? "-batch" : ""}.v1`,
		preferredName,
		name,
		origin: "provider-recommended",
		declaration: {
			name: preferredName,
			description: `Anthropic-recommended ${plane}${batch ? " batch" : ""} function tool. Coordinates are pixels in the latest ${plane === "browser" ? "browser viewport" : "OS"} screenshot.`,
			parameters,
		},
		execution: {
			kind: "actions",
			toActions(input) {
				const values = batch ? asActionsInput(input).actions : [asInput(input)];
				return values.flatMap((value) => plane === "computer" ? mapNativeComputerInput(asNativeInput(value)) : mapNativeBrowserInput(asNativeInput(value)));
			},
			coordinates: pixels,
			resultPolicy: plane,
			batch,
		},
		executorFingerprint: `anthropic-recommended-${plane}-${batch ? "batch" : "single"}-v1:${actions.join(",")}`,
		stateMutating: actions.some((action) => !(plane === "computer"
			? ["screenshot", "cursor_position", "zoom"].includes(action)
			: ["list_tabs", "read_page", "get_page_text", "find", "screenshot", "zoom", "wait"].includes(action))),
		complexSchema: true,
	});
}

function anthropicRecommendedActionSchema(plane: "computer" | "browser", action: string): TSchema {
	return plane === "computer"
		? anthropicRecommendedComputerActionSchema(action as AnthropicRecommendedComputerAction)
		: anthropicRecommendedBrowserActionSchema(action as AnthropicRecommendedBrowserAction);
}

function anthropicRecommendedComputerActionSchema(action: AnthropicRecommendedComputerAction): TSchema {
	const coordinate = () => Type.Array(Type.Integer(), { minItems: 2, maxItems: 2 });
	const region = () => Type.Array(Type.Integer(), { minItems: 4, maxItems: 4 });
	const click = () => Type.Object({
		action: Type.Literal(action),
		coordinate: coordinate(),
		text: Type.Optional(Type.String()),
	}, { additionalProperties: false });
	switch (action) {
		case "screenshot": case "left_mouse_down": case "left_mouse_up": case "cursor_position":
			return Type.Object({ action: Type.Literal(action) }, { additionalProperties: false });
		case "left_click": case "right_click": case "middle_click": case "double_click": case "triple_click":
			return click();
		case "left_click_drag":
			return Type.Object({ action: Type.Literal(action), start_coordinate: coordinate(), coordinate: coordinate(), text: Type.Optional(Type.String()) }, { additionalProperties: false });
		case "mouse_move":
			return Type.Object({ action: Type.Literal(action), coordinate: coordinate() }, { additionalProperties: false });
		case "scroll":
			return Type.Object({
				action: Type.Literal(action),
				coordinate: coordinate(),
				scroll_direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
				scroll_amount: Type.Optional(Type.Integer({ minimum: 1 })),
				text: Type.Optional(Type.String()),
			}, { additionalProperties: false });
		case "type":
			return Type.Object({ action: Type.Literal(action), text: Type.String() }, { additionalProperties: false });
		case "key":
			return Type.Object({ action: Type.Literal(action), text: Type.String(), repeat: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false });
		case "hold_key":
			return Type.Object({ action: Type.Literal(action), text: Type.String(), duration: Type.Number({ minimum: 0, maximum: 100 }) }, { additionalProperties: false });
		case "wait":
			return Type.Object({ action: Type.Literal(action), duration: Type.Number({ minimum: 0, maximum: 100 }) }, { additionalProperties: false });
		case "zoom":
			return Type.Object({ action: Type.Literal(action), region: region() }, { additionalProperties: false });
	}
}

function anthropicRecommendedBrowserActionSchema(action: AnthropicRecommendedBrowserAction): TSchema {
	const tab = () => Type.Optional(Type.String());
	const region = () => Type.Array(Type.Integer(), { minItems: 4, maxItems: 4 });
	const refTarget = () => Type.Object({ type: Type.Literal("ref"), ref: Type.String() }, { additionalProperties: false });
	const coordinateTarget = () => Type.Object({ type: Type.Literal("coordinate"), x: Type.Integer(), y: Type.Integer() }, { additionalProperties: false });
	const pageTarget = () => Type.Union([refTarget(), coordinateTarget()]);
	const clickable = () => Type.Object({
		action: Type.Literal(action),
		target: pageTarget(),
		modifiers: Type.Optional(Type.String()),
		tab_id: tab(),
	}, { additionalProperties: false });
	switch (action) {
		case "navigate":
			return Type.Object({ action: Type.Literal(action), url: Type.String(), tab_id: tab() }, { additionalProperties: false });
		case "list_tabs": case "new_tab":
			return Type.Object({ action: Type.Literal(action) }, { additionalProperties: false });
		case "read_page":
			return Type.Object({
				action: Type.Literal(action),
				filter: Type.Optional(Type.Union([Type.Literal("interactive"), Type.Literal("all")])),
				depth: Type.Optional(Type.Integer({ minimum: 0 })),
				ref: Type.Optional(Type.String()),
				tab_id: tab(),
			}, { additionalProperties: false });
		case "get_page_text": case "screenshot":
			return Type.Object({ action: Type.Literal(action), tab_id: tab() }, { additionalProperties: false });
		case "find":
			return Type.Object({ action: Type.Literal(action), query: Type.String(), tab_id: tab() }, { additionalProperties: false });
		case "form_input":
			return Type.Object({
				action: Type.Literal(action),
				target: refTarget(),
				value: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
				tab_id: tab(),
			}, { additionalProperties: false });
		case "scroll_to":
			return Type.Object({ action: Type.Literal(action), target: refTarget(), tab_id: tab() }, { additionalProperties: false });
		case "zoom":
			return Type.Object({ action: Type.Literal(action), region: region(), tab_id: tab() }, { additionalProperties: false });
		case "left_click": case "right_click": case "double_click": case "triple_click": case "hover":
			return clickable();
		case "left_click_drag":
			return Type.Object({ action: Type.Literal(action), from: coordinateTarget(), target: coordinateTarget(), tab_id: tab() }, { additionalProperties: false });
		case "scroll":
			return Type.Object({
				action: Type.Literal(action),
				target: coordinateTarget(),
				scroll_direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
				scroll_amount: Type.Optional(Type.Integer({ minimum: 1 })),
				tab_id: tab(),
			}, { additionalProperties: false });
		case "type": case "javascript_exec":
			return Type.Object({ action: Type.Literal(action), text: Type.String(), tab_id: tab() }, { additionalProperties: false });
		case "key":
			return Type.Object({ action: Type.Literal(action), text: Type.String(), repeat: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), tab_id: tab() }, { additionalProperties: false });
		case "wait":
			return Type.Object({ action: Type.Literal(action), duration: Type.Number({ minimum: 0, maximum: 100 }) }, { additionalProperties: false });
	}
}

function openaiNativeComputer(): CuaToolSpec {
	const declaration = { type: "computer" };
	return providerNativeSpec({
		identity: "provider.openai.native.computer.v1",
		name: "computer",
		declaration,
		binding: { kind: "openai-native", declaration },
		toActions: mapOpenAIComputerInput,
		coordinates: pixels,
		resultPolicy: "computer",
		executorFingerprint: "openai-native-computer-v1",
	});
}

function tzafonNativeComputer(options: { displayWidth?: number; displayHeight?: number } = {}): CuaToolSpec {
	const declaration = {
		type: "computer_use",
		display_width: options.displayWidth,
		display_height: options.displayHeight,
		environment: "browser",
	};
	return providerNativeSpec({
		identity: "provider.tzafon.native.computer.v1",
		name: "computer",
		declaration,
		binding: { kind: "tzafon-native", declaration },
		toActions(input) {
			const action = asInput(input).action;
			return toTzafonActions(action).filter((value): value is CuaAction => value.type !== "answer");
		},
		coordinates: normalized([0, 999]),
		resultPolicy: "computer",
		executorFingerprint: "tzafon-native-computer-v1",
	});
}

function yutoriToolset(generation: "n1" | "n15"): CuaToolSpec[] {
	const names = generation === "n1" ? YUTORI_N1_ACTION_TYPES : YUTORI_N15_CORE_ACTION_TYPES;
	return names.map((nativeName) => {
		const identityName = nativeName.replaceAll("_", "-");
		const binding: CuaProviderBinding = {
			kind: "yutori-native",
			generation,
			nativeName,
			...(generation === "n15" ? { toolSet: YUTORI_N15_CORE_TOOL_SET } : {}),
			allNativeNames: names,
		};
		return providerNativeSpec({
			identity: `provider.yutori.native.${generation}.${identityName}.${generation === "n15" ? "20260403" : "v1"}`,
			name: nativeName,
			declaration: { type: "function", name: nativeName },
			binding,
			toActions(input) {
				return toYutoriActions(nativeName, asInput(input)) ?? [];
			},
			coordinates: normalized([0, 1000]),
			resultPolicy: "request-grounded",
			executorFingerprint: `yutori-${generation}-${nativeName}`,
		});
	});
}

const GOOGLE_LEGACY_ACTIONS = [
	"open_web_browser", "wait_5_seconds", "go_back", "go_forward", "search", "navigate", "click_at",
	"hover_at", "type_text_at", "key_combination", "scroll_document", "scroll_at", "drag_and_drop",
] as const;

const GOOGLE_CURRENT_ACTIONS = [
	"click", "double_click", "triple_click", "middle_click", "right_click", "mouse_down", "mouse_up", "move",
	"type", "drag_and_drop", "wait", "press_key", "key_down", "key_up", "hotkey", "take_screenshot",
	"scroll", "go_back", "navigate", "go_forward",
] as const;

// Gemini 3 Interactions endpoints can still expose legacy predefined functions.
// Excluding the complete published vocabulary keeps a current catalog exact
// without installing legacy helpers as selectable tools.
const GOOGLE_CURRENT_EXCLUDABLE_ACTIONS = Object.freeze([
	...GOOGLE_CURRENT_ACTIONS,
	...GOOGLE_LEGACY_ACTIONS.filter((name) => !(GOOGLE_CURRENT_ACTIONS as readonly string[]).includes(name)),
]);

export interface GoogleBrowserToolsetOptions {
	/** Predefined Google browser actions to disable. */
	exclude?: readonly string[];
}

function googleToolset(generation: "legacy" | "current", options: GoogleBrowserToolsetOptions = {}): CuaToolSpec[] {
	const names = generation === "legacy" ? GOOGLE_LEGACY_ACTIONS : GOOGLE_CURRENT_ACTIONS;
	const allNativeNames = generation === "legacy" ? GOOGLE_LEGACY_ACTIONS : GOOGLE_CURRENT_EXCLUDABLE_ACTIONS;
	const unknown = (options.exclude ?? []).filter((name) => !names.includes(name as never));
	if (unknown.length > 0) throw new Error(`unknown Google ${generation} predefined action(s): ${unknown.join(", ")}`);
	const excluded = new Set(options.exclude ?? []);
	return names.filter((name) => !excluded.has(name)).map((nativeName) => providerNativeSpec({
		identity: `provider.google.native.${generation}.${nativeName.replaceAll("_", "-")}.v1`,
		name: nativeName,
		declaration: { computerUse: { environment: "ENVIRONMENT_BROWSER" } },
		binding: { kind: "google-native", generation, nativeName, allNativeNames },
		toActions: (input) => mapGoogleAction(nativeName, asInput(input)),
		coordinates: normalized([0, 999]),
		resultPolicy: "computer",
		executorFingerprint: `google-${generation}-${nativeName}-v1`,
	}));
}

function providerNativeSpec(options: {
	identity: string;
	name: string;
	declaration: Record<string, unknown>;
	binding: CuaProviderBinding;
	toActions: (input: unknown) => CuaAction[];
	coordinates: CuaCoordinateContract;
	resultPolicy: CuaToolResultPolicy;
	executorFingerprint: string;
	stopTurnOnFailureMessage?: string;
}): CuaToolSpec {
	return createSpec({
		identity: options.identity,
		preferredName: options.name,
		origin: "provider-native",
		transport: "native",
		dynamicLoading: "eager-only",
		declaration: {
			name: options.name,
			description: `${options.identity} local execution placeholder.`,
			parameters: Type.Object({}, { additionalProperties: true }),
		},
		execution: {
			kind: "actions",
			toActions: options.toActions,
			coordinates: options.coordinates,
			resultPolicy: options.resultPolicy,
			batch: true,
			...(options.stopTurnOnFailureMessage ? { stopTurnOnFailureMessage: options.stopTurnOnFailureMessage } : {}),
		},
		providerBinding: options.binding,
		executorFingerprint: options.executorFingerprint,
		stateMutating: true,
	});
}

function createSpec(options: {
	identity: string;
	preferredName: string;
	name?: string;
	origin: CuaToolOrigin;
	transport?: CuaToolTransport;
	dynamicLoading?: CuaToolDynamicLoading;
	declaration: Tool;
	execution: CuaToolExecution;
	providerBinding?: CuaProviderBinding;
	executorFingerprint: string;
	stateMutating: boolean;
	complexSchema?: boolean;
}): CuaToolSpec {
	const name = options.name ?? options.preferredName;
	const declaration = Object.freeze({ ...options.declaration, name });
	return Object.freeze({
		kind: CUA_TOOL_SPEC_KIND,
		identity: options.identity,
		preferredName: options.preferredName,
		name,
		origin: options.origin,
		transport: options.transport ?? "function",
		dynamicLoading: options.dynamicLoading ?? "eligible",
		declaration,
		execution: Object.freeze(options.execution),
		...(options.providerBinding ? { providerBinding: Object.freeze(options.providerBinding) } : {}),
		executorFingerprint: options.executorFingerprint,
		stateMutating: options.stateMutating,
		...(options.complexSchema ? { complexSchema: true } : {}),
	});
}

function toolsetNameOptions(preferredName: string, options: CuaToolsetOptions): CuaToolNameOptions {
	return options.namespace ? { name: namespaced(preferredName, options.namespace) } : {};
}

function namespaced(preferredName: string, namespace: string | undefined): string {
	return namespace ? `${namespace}_${preferredName}` : preferredName;
}

function computerSchema(action: CuaComputerActionType): TSchema {
	return removeDiscriminator(computerActionSchema(action), "type");
}

function computerActionSchema(action: CuaComputerActionType): TSchema {
	const schemas = Object.fromEntries(CUA_COMPUTER_ACTION_TYPES.map((name) => [name, computerSchemaWithType(name)]));
	return schemas[action]!;
}

function computerSchemaWithType(action: CuaComputerActionType): TSchema {
	// Importing the canonical schema map directly would expose a mutable object through
	// the public namespace; rebuild the selected schema from the package's action map.
	const all = awaitlessComputerSchemas();
	return all[action];
}

function awaitlessComputerSchemas(): Record<CuaComputerActionType, TSchema> {
	// Kept as a function so factories never return the canonical object by reference.
	const point = { x: Type.Number(), y: Type.Number() };
	return {
		click: Type.Object({ type: Type.Literal("click"), x: Type.Number(), y: Type.Number(), button: Type.Optional(Type.String()), hold_keys: Type.Optional(Type.Array(Type.String())), num_clicks: Type.Optional(Type.Number()) }, { additionalProperties: false }),
		double_click: Type.Object({ type: Type.Literal("double_click"), x: Type.Number(), y: Type.Number(), hold_keys: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
		mouse_down: Type.Object({ type: Type.Literal("mouse_down"), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), button: Type.Optional(Type.String()), hold_keys: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
		mouse_up: Type.Object({ type: Type.Literal("mouse_up"), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), button: Type.Optional(Type.String()), hold_keys: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
		type: Type.Object({ type: Type.Literal("type"), text: Type.String() }, { additionalProperties: false }),
		keypress: Type.Object({ type: Type.Literal("keypress"), keys: Type.Array(Type.String()), duration: Type.Optional(Type.Number()) }, { additionalProperties: false }),
		scroll: Type.Object({ type: Type.Literal("scroll"), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), scroll_x: Type.Optional(Type.Number()), scroll_y: Type.Optional(Type.Number()), hold_keys: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
		move: Type.Object({ type: Type.Literal("move"), ...point }, { additionalProperties: false }),
		drag: Type.Object({ type: Type.Literal("drag"), path: Type.Array(Type.Object(point, { additionalProperties: false }), { minItems: 2 }), button: Type.Optional(Type.String()), hold_keys: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
		wait: Type.Object({ type: Type.Literal("wait"), ms: Type.Optional(Type.Number()) }, { additionalProperties: false }),
		screenshot: Type.Object({ type: Type.Literal("screenshot") }, { additionalProperties: false }),
		zoom: Type.Object({ type: Type.Literal("zoom"), region: Type.Array(Type.Number(), { minItems: 4, maxItems: 4 }) }, { additionalProperties: false }),
		goto: Type.Object({ type: Type.Literal("goto"), url: Type.String() }, { additionalProperties: false }),
		back: Type.Object({ type: Type.Literal("back") }, { additionalProperties: false }),
		forward: Type.Object({ type: Type.Literal("forward") }, { additionalProperties: false }),
		url: Type.Object({ type: Type.Literal("url") }, { additionalProperties: false }),
		cursor_position: Type.Object({ type: Type.Literal("cursor_position") }, { additionalProperties: false }),
	};
}

function removeDiscriminator(schema: TSchema, field: string): TSchema {
	const objectSchema = schema as TSchema & { properties?: unknown; required?: unknown };
	const properties = isSchemaRecord(objectSchema.properties) ? { ...objectSchema.properties } : {};
	delete properties[field];
	const required = Array.isArray(objectSchema.required)
		? objectSchema.required.filter((name: unknown): name is string => typeof name === "string" && name !== field)
		: undefined;
	return { ...schema, properties, ...(required?.length ? { required } : { required: undefined }) };
}

function renameDiscriminator(schema: TSchema, from: string, to: string, literal?: string): TSchema {
	const objectSchema = schema as TSchema & { properties?: unknown; required?: unknown };
	const properties = isSchemaRecord(objectSchema.properties) ? { ...objectSchema.properties } : {};
	const source = properties[from];
	delete properties[from];
	properties[to] = literal ? Type.Literal(literal) : source;
	const required = Array.isArray(objectSchema.required)
		? objectSchema.required.filter((name: unknown): name is string => typeof name === "string").map((name) => name === from ? to : name)
		: [to];
	return { ...schema, properties, required };
}

function isSchemaRecord(value: unknown): value is Record<string, TSchema> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function uniqueKnownComputerActions(actions: readonly CuaComputerActionType[]): CuaComputerActionType[] {
	const unique = [...new Set(actions)];
	for (const action of unique) if (!(CUA_COMPUTER_ACTION_TYPES as readonly string[]).includes(action)) throw new Error(`unsupported computer_batch action "${action}"`);
	return unique;
}

function browserBatchActionToCanonical(action: CuaBrowserBatchAction): CuaBrowserActionType | undefined {
	const entries: Record<CuaBrowserBatchAction, CuaBrowserActionType> = {
		snapshot: "browser_snapshot",
		text: "browser_text",
		find: "browser_find",
		click: "browser_click",
		hover: "browser_hover",
		drag: "browser_drag",
		fill: "browser_fill",
		scroll_to: "browser_scroll_to",
		scroll: "browser_scroll",
		type: "browser_type",
		key: "browser_key",
		navigate: "browser_navigate",
		list_tabs: "browser_list_tabs",
		new_tab: "browser_new_tab",
		screenshot: "browser_screenshot",
		evaluate: "browser_evaluate",
		wait_for: "browser_wait_for",
	};
	return entries[action];
}

function mapOpenAIComputerInput(input: unknown): CuaAction[] {
	const value = asInput(input);
	const actions = Array.isArray(value.actions) ? value.actions : value.action && typeof value.action === "object" ? [value.action] : [value];
	const result: CuaAction[] = [];
	for (const action of actions) {
		if (!action || typeof action !== "object") continue;
		const current = action as Record<string, unknown>;
		const type = requireString(current.type ?? current.action, "action.type");
		switch (type) {
			case "click": result.push({ type: "click", x: number(current.x), y: number(current.y), button: optionalString(current.button) as "left" | "right" | "middle" | undefined }); break;
			case "double_click": result.push({ type: "double_click", x: number(current.x), y: number(current.y) }); break;
			case "move": result.push({ type: "move", x: number(current.x), y: number(current.y) }); break;
			case "drag": result.push({ type: "drag", path: Array.isArray(current.path) ? current.path.map(point) : [point(current), { x: number(current.x2), y: number(current.y2) }] }); break;
			case "scroll": result.push({ type: "scroll", x: optionalNumber(current.x), y: optionalNumber(current.y), scroll_x: optionalNumber(current.scroll_x), scroll_y: optionalNumber(current.scroll_y) }); break;
			case "type": result.push({ type: "type", text: requireString(current.text, "text") }); break;
			case "keypress": result.push({ type: "keypress", keys: Array.isArray(current.keys) ? current.keys.map(String) : [requireString(current.key, "key")] }); break;
			case "wait": result.push({ type: "wait", ms: optionalNumber(current.ms) }); break;
			case "screenshot": result.push({ type: "screenshot" }); break;
			default: throw new Error(`unsupported OpenAI computer action "${type}"`);
		}
	}
	return result;
}

function mapGoogleAction(name: string, input: Record<string, unknown>): CuaAction[] {
	const safety = input.safety_decision;
	if (safety && typeof safety === "object") {
		const decision = (safety as { decision?: unknown }).decision;
		if (decision === "blocked" || decision === "require_confirmation") {
			throw new Error(`Google computer action "${name}" was not executed: safety decision ${decision}`);
		}
	}
	const x = optionalNumber(input.x) ?? optionalNumber(input.coordinate_x);
	const y = optionalNumber(input.y) ?? optionalNumber(input.coordinate_y);
	switch (name) {
		case "click_at": case "click": return [{ type: "click", x: number(x), y: number(y) }];
		case "double_click": return [{ type: "double_click", x: number(x), y: number(y) }];
		case "triple_click": return [{ type: "click", x: number(x), y: number(y), num_clicks: 3 }];
		case "middle_click": return [{ type: "click", x: number(x), y: number(y), button: "middle" }];
		case "right_click": return [{ type: "click", x: number(x), y: number(y), button: "right" }];
		case "mouse_down": return [{ type: "mouse_down", x: number(x), y: number(y) }];
		case "mouse_up": return [{ type: "mouse_up", x: number(x), y: number(y) }];
		case "hover_at": case "move": return [{ type: "move", x: number(x), y: number(y) }];
		case "type_text_at": return [
			{ type: "click", x: number(x), y: number(y) },
			...(input.clear_before_typing !== false ? [{ type: "keypress", keys: ["ctrl", "a"] } as CuaAction] : []),
			{ type: "type", text: requireString(input.text, "text") },
			...(input.press_enter !== false ? [{ type: "keypress", keys: ["enter"] } as CuaAction] : []),
		];
		case "type": return [
			{ type: "type", text: requireString(input.text, "text") },
			...(input.press_enter === true ? [{ type: "keypress", keys: ["enter"] } as CuaAction] : []),
		];
		case "scroll_document": case "scroll_at": case "scroll": {
			const defaultAmount = name === "scroll" ? 300 : 800;
			const amount = optionalNumber(input.scroll_y) ?? optionalNumber(input.magnitude_in_pixels) ?? optionalNumber(input.magnitude) ?? defaultAmount;
			const direction = optionalString(input.direction);
			return [{
				type: "scroll",
				x: name === "scroll_document" ? 500 : number(x),
				y: name === "scroll_document" ? 500 : number(y),
				scroll_x: optionalNumber(input.scroll_x) ?? (direction === "left" ? -amount : direction === "right" ? amount : 0),
				scroll_y: direction === "up" ? -amount : amount,
			}];
		}
		case "key_combination": case "hotkey": return [{ type: "keypress", keys: Array.isArray(input.keys) ? input.keys.map(String) : requireString(input.keys, "keys").split("+") }];
		case "press_key": return [{ type: "keypress", keys: [requireString(input.key, "key")] }];
		case "key_down": return [{ type: "keypress", keys: [requireString(input.key, "key")], duration: 1000 }];
		case "key_up": return [{ type: "wait", ms: 0 }];
		case "drag_and_drop": case "drag": return [{ type: "drag", path: [
			{ x: number(optionalNumber(input.start_x) ?? x), y: number(optionalNumber(input.start_y) ?? y) },
			{ x: number(optionalNumber(input.end_x) ?? optionalNumber(input.destination_x)), y: number(optionalNumber(input.end_y) ?? optionalNumber(input.destination_y)) },
		] }];
		case "navigate": return [{ type: "goto", url: requireString(input.url, "url") }];
		case "go_back": return [{ type: "back" }];
		case "go_forward": return [{ type: "forward" }];
		case "wait": case "wait_5_seconds": return [{ type: "wait", ms: name === "wait_5_seconds" ? 5000 : (optionalNumber(input.seconds) ?? 1) * 1000 }];
		case "take_screenshot": return [{ type: "screenshot" }];
		case "open_web_browser": return [{ type: "wait", ms: 0 }];
		case "search": return [{ type: "goto", url: "https://www.google.com" }];
		default: throw new Error(`unsupported Google computer action "${name}"`);
	}
}

function asInput(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tool input must be an object");
	return value as Record<string, unknown>;
}

function asNativeInput(value: unknown): { action: string; [key: string]: unknown } {
	const input = asInput(value);
	return { ...input, action: requireString(input.action, "action") };
}

function asActionsInput(value: unknown): { actions: Record<string, unknown>[] } {
	const input = asInput(value);
	if (!Array.isArray(input.actions) || input.actions.length === 0) throw new Error("actions must be a non-empty array");
	return { actions: input.actions.map(asInput) };
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value) throw new Error(`${field} must be a non-empty string`);
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("coordinate must be a finite number");
	return value;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function point(value: unknown): { x: number; y: number } {
	const input = asInput(value);
	return { x: number(input.x), y: number(input.y) };
}

const browserTools = Object.freeze({
	snapshot: (options?: CuaToolNameOptions) => browserTool("snapshot", options),
	text: (options?: CuaToolNameOptions) => browserTool("text", options),
	find: (options?: CuaToolNameOptions) => browserTool("find", options),
	click: (options?: CuaToolNameOptions) => browserTool("click", options),
	hover: (options?: CuaToolNameOptions) => browserTool("hover", options),
	drag: (options?: CuaToolNameOptions) => browserTool("drag", options),
	fill: (options?: CuaToolNameOptions) => browserTool("fill", options),
	scrollTo: (options?: CuaToolNameOptions) => browserTool("scrollTo", options),
	scroll: (options?: CuaToolNameOptions) => browserTool("scroll", options),
	type: (options?: CuaToolNameOptions) => browserTool("type", options),
	key: (options?: CuaToolNameOptions) => browserTool("key", options),
	navigate: (options?: CuaToolNameOptions) => browserTool("navigate", options),
	listTabs: (options?: CuaToolNameOptions) => browserTool("listTabs", options),
	newTab: (options?: CuaToolNameOptions) => browserTool("newTab", options),
	screenshot: (options?: CuaToolNameOptions) => browserTool("screenshot", options),
	evaluate: (options?: CuaToolNameOptions) => browserTool("evaluate", options),
	waitFor: (options?: CuaToolNameOptions) => browserTool("waitFor", options),
	act: (options?: CuaToolNameOptions) => browserTool("act", options),
	batch: browserBatch,
});

const computerTools = Object.freeze({
	click: (options?: CuaComputerToolOptions) => computerTool("click", options),
	doubleClick: (options?: CuaComputerToolOptions) => computerTool("doubleClick", options),
	mouseDown: (options?: CuaComputerToolOptions) => computerTool("mouseDown", options),
	mouseUp: (options?: CuaComputerToolOptions) => computerTool("mouseUp", options),
	type: (options?: CuaComputerToolOptions) => computerTool("type", options),
	keypress: (options?: CuaComputerToolOptions) => computerTool("keypress", options),
	scroll: (options?: CuaComputerToolOptions) => computerTool("scroll", options),
	move: (options?: CuaComputerToolOptions) => computerTool("move", options),
	drag: (options?: CuaComputerToolOptions) => computerTool("drag", options),
	wait: (options?: CuaComputerToolOptions) => computerTool("wait", options),
	screenshot: (options?: CuaComputerToolOptions) => computerTool("screenshot", options),
	zoom: (options?: CuaComputerToolOptions) => computerTool("zoom", options),
	goto: (options?: CuaComputerToolOptions) => computerTool("goto", options),
	back: (options?: CuaComputerToolOptions) => computerTool("back", options),
	forward: (options?: CuaComputerToolOptions) => computerTool("forward", options),
	url: (options?: CuaComputerToolOptions) => computerTool("url", options),
	cursorPosition: (options?: CuaComputerToolOptions) => computerTool("cursorPosition", options),
	batch: computerBatch,
});

function browserToolset(options: CuaToolsetOptions = {}): CuaToolSpec[] {
	return [
		browserTools.snapshot(toolsetNameOptions("browser_snapshot", options)),
		browserTools.text(toolsetNameOptions("browser_text", options)),
		browserTools.find(toolsetNameOptions("browser_find", options)),
		browserTools.click(toolsetNameOptions("browser_click", options)),
		browserTools.hover(toolsetNameOptions("browser_hover", options)),
		browserTools.drag(toolsetNameOptions("browser_drag", options)),
		browserTools.fill(toolsetNameOptions("browser_fill", options)),
		browserTools.scrollTo(toolsetNameOptions("browser_scroll_to", options)),
		browserTools.scroll(toolsetNameOptions("browser_scroll", options)),
		browserTools.type(toolsetNameOptions("browser_type", options)),
		browserTools.key(toolsetNameOptions("browser_key", options)),
		browserTools.navigate(toolsetNameOptions("browser_navigate", options)),
		browserTools.listTabs(toolsetNameOptions("browser_list_tabs", options)),
		browserTools.newTab(toolsetNameOptions("browser_new_tab", options)),
		browserTools.screenshot(toolsetNameOptions("browser_screenshot", options)),
		browserTools.evaluate(toolsetNameOptions("browser_evaluate", options)),
		browserTools.waitFor(toolsetNameOptions("browser_wait_for", options)),
	];
}

function computerToolset(options: CuaComputerToolsetOptions = {}): CuaToolSpec[] {
	const toolOptions = (preferredName: string): CuaComputerToolOptions => ({
		...toolsetNameOptions(preferredName, options),
		...(options.coordinates ? { coordinates: options.coordinates } : {}),
	});
	return [
		computerTools.click(toolOptions("computer_click")),
		computerTools.doubleClick(toolOptions("computer_double_click")),
		computerTools.mouseDown(toolOptions("computer_mouse_down")),
		computerTools.mouseUp(toolOptions("computer_mouse_up")),
		computerTools.type(toolOptions("computer_type")),
		computerTools.keypress(toolOptions("computer_keypress")),
		computerTools.scroll(toolOptions("computer_scroll")),
		computerTools.move(toolOptions("computer_move")),
		computerTools.drag(toolOptions("computer_drag")),
		computerTools.wait(toolOptions("computer_wait")),
		computerTools.screenshot(toolOptions("computer_screenshot")),
		computerTools.goto(toolOptions("computer_goto")),
		computerTools.back(toolOptions("computer_back")),
		computerTools.forward(toolOptions("computer_forward")),
		computerTools.url(toolOptions("computer_url")),
		computerTools.cursorPosition(toolOptions("computer_cursor_position")),
	];
}

const providers = Object.freeze({
	openai: Object.freeze({ tools: Object.freeze({ computer: openaiNativeComputer }) }),
	anthropic: Object.freeze({
		supports: Object.freeze({ browser: supportsAnthropicNativeBrowser }),
		tools: Object.freeze({ computer: anthropicNativeComputer, browser: anthropicNativeBrowser }),
		toolsets: Object.freeze({
			computer(options: AnthropicRecommendedToolsetOptions = {}) {
				return [anthropicRecommendedTool("computer", false, options), anthropicRecommendedTool("computer", true, options)];
			},
			browser(options: AnthropicRecommendedToolsetOptions = {}) {
				return [anthropicRecommendedTool("browser", false, options), anthropicRecommendedTool("browser", true, options)];
			},
		}),
	}),
	google: Object.freeze({ toolsets: Object.freeze({
		legacyBrowser: (options?: GoogleBrowserToolsetOptions) => googleToolset("legacy", options),
		browser: (options?: GoogleBrowserToolsetOptions) => googleToolset("current", options),
	}) }),
	tzafon: Object.freeze({ tools: Object.freeze({ computer: tzafonNativeComputer }) }),
	yutori: Object.freeze({ toolsets: Object.freeze({ n1: () => yutoriToolset("n1"), n15Core: () => yutoriToolset("n15") }) }),
});

/** Frozen, discoverable tool namespace shared by @onkernel/cua-ai and @onkernel/cua-agent. */
export const cua = Object.freeze({
	coordinates: Object.freeze({ pixels: () => pixels, normalized }),
	tools: Object.freeze({ browser: browserTools, computer: computerTools, playwright }),
	toolsets: Object.freeze({
		browser: browserToolset,
		computer: computerToolset,
		mixed(options: CuaComputerToolsetOptions = {}) {
			return [...computerToolset(options), ...browserToolset(options)];
		},
	}),
	providers,
});

export type CuaNamespace = typeof cua;
