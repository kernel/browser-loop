import {
	CUA_DEFAULT_DOM_ACTION_TYPES,
	CUA_DEFAULT_OS_ACTION_TYPES,
	isCuaOsActionType,
	type CuaActionSchemaOptions,
	type CuaActionType,
	type CuaDomActionType,
	type CuaOsActionType,
} from "./actions/index";

/**
 * Which canonical action plane(s) a CUA agent exposes to the model.
 *
 * - `os` — OS-level input only (mouse/keyboard/display against the VM).
 *   Today's default; coordinates are OS screenshot pixels.
 * - `dom` — DOM-level tools only, driven over CDP: accessibility snapshots
 *   with element refs, element-targeted interaction, navigation, tabs, and
 *   viewport screenshots. Coordinates, where used, are viewport pixels.
 * - `hybrid` — both planes, deduplicated to one tool per capability. OS
 *   tools are prefixed `computer_`, DOM tools keep their `page_` prefix,
 *   DOM tools accept element refs only, and the OS screenshot frame is the
 *   single live coordinate frame.
 */
export type CuaMode = "os" | "dom" | "hybrid";

/** Options for resolving a mode's action set. */
export interface CuaModeOptions {
	/** Expose `page_evaluate` (arbitrary JavaScript in the page). Default false. */
	javascriptExec?: boolean;
}

/**
 * OS actions exposed in hybrid mode: navigation reads/writes are excluded
 * because they live on the DOM plane (`page_navigate`, `page_list_tabs`),
 * and `zoom` is included since the OS screenshot is hybrid's only capture.
 */
export const CUA_HYBRID_OS_ACTION_TYPES: readonly CuaOsActionType[] = [
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
	"cursor_position",
];

/**
 * DOM actions exposed in hybrid mode: reads and element-targeted writes
 * only. Pointer/keyboard capabilities (`page_click` by coordinate,
 * `page_type`, `page_key`, `page_scroll`, `page_hover`, `page_drag`) and
 * `page_screenshot` are excluded — real OS input and the OS screenshot cover
 * those, keeping one tool per capability and one coordinate frame.
 */
export const CUA_HYBRID_DOM_ACTION_TYPES: readonly CuaDomActionType[] = [
	"page_snapshot",
	"page_text",
	"page_find",
	"page_click",
	"page_fill",
	"page_scroll_to",
	"page_navigate",
	"page_list_tabs",
	"page_new_tab",
];

/** Resolve the default canonical action set for a mode. */
export function defaultActionsForMode(mode: CuaMode, options: CuaModeOptions = {}): readonly CuaActionType[] {
	switch (mode) {
		case "os":
			return CUA_DEFAULT_OS_ACTION_TYPES;
		case "dom":
			return [...CUA_DEFAULT_DOM_ACTION_TYPES, ...(options.javascriptExec ? (["page_evaluate"] as const) : []), "wait"];
		case "hybrid":
			return [
				...CUA_HYBRID_OS_ACTION_TYPES,
				...CUA_HYBRID_DOM_ACTION_TYPES,
				...(options.javascriptExec ? (["page_evaluate"] as const) : []),
			];
	}
}

/** Resolve the schema-building options for a mode; see {@link CuaActionSchemaOptions}. */
export function schemaOptionsForMode(mode: CuaMode): CuaActionSchemaOptions {
	// Hybrid restricts DOM actions to element refs so the OS screenshot frame
	// is the single live coordinate frame. DOM mode has no OS frame, so
	// viewport coordinates are allowed there.
	return { dom: { coordinates: mode !== "hybrid" } };
}

/**
 * The model-facing tool name for a canonical action in a mode.
 *
 * - `os`: canonical action ids as-is (`click`, `screenshot`, …).
 * - `dom`: DOM ids with the `page_` prefix stripped (`snapshot`, `click`, …);
 *   the prefix only exists to disambiguate planes, and dom mode has one.
 * - `hybrid`: OS ids prefixed `computer_`, DOM ids kept as `page_*`.
 */
export function cuaToolNameForAction(action: CuaActionType, mode: CuaMode): string {
	switch (mode) {
		case "os":
			if (!isCuaOsActionType(action)) throw new Error(`DOM action "${action}" is not available in os mode`);
			return action;
		case "dom":
			return isCuaOsActionType(action) ? action : action.slice("page_".length);
		case "hybrid":
			return isCuaOsActionType(action) ? `computer_${action}` : action;
	}
}

const DOM_ACTION_DESCRIPTIONS: Record<CuaDomActionType, string> = {
	page_snapshot:
		"Return an accessibility-tree snapshot of the page with element references like [e12]. " +
		"Use the refs to target elements in other page tools. Refs are only valid until the page changes; re-snapshot when told a ref is stale.",
	page_text: "Return the page's visible text content as plain text. Best for articles and text-heavy pages.",
	page_find: "Find elements matching a natural-language description and return them with element references, like a filtered snapshot.",
	page_click: "Click an element. Prefer targeting by element reference from a snapshot.",
	page_hover: "Move the pointer over an element without clicking.",
	page_drag: "Drag from one viewport coordinate to another.",
	page_fill: "Set the value of a form element (input, textarea, select, checkbox) by element reference.",
	page_scroll_to: "Scroll an element into view by element reference.",
	page_scroll: "Scroll the page at a viewport position by wheel notches.",
	page_type: "Type a literal string at the current focus.",
	page_key: "Press a key or chord, e.g. \"Return\" or \"ctrl+a\".",
	page_navigate: "Navigate the page to a URL, or \"back\" / \"forward\" in history.",
	page_list_tabs: "List open tabs with each tab's id, title, and URL.",
	page_new_tab: "Open a new empty tab and return its tab id.",
	page_screenshot: "Capture the current browser viewport.",
	page_evaluate: "Execute JavaScript in the page context and return the value of the last expression.",
};

// Hybrid exposes both planes, so tool descriptions carry the arbitration
// rules the model needs: which plane is preferred for a capability and why
// (real OS input vs CDP), plus the single-coordinate-frame statement.
const HYBRID_OS_DESCRIPTION_OVERRIDES: Partial<Record<CuaOsActionType, string>> = {
	click:
		"Click at a coordinate in OS screenshot pixels using real OS-level input. " +
		"Preferred over page_click when the target is visible in the screenshot — OS input is indistinguishable from a human user.",
	screenshot: "Capture the display. This is the only screenshot tool; all coordinates refer to this image's pixels.",
	zoom: "Return a cropped view of the current display for closer inspection. Coordinates in later actions still refer to the full screenshot, not the crop.",
	scroll: "Scroll with the OS-level mouse wheel at a coordinate in OS screenshot pixels.",
	type: "Type a literal string with OS-level keyboard input at the current focus.",
	keypress: "Press keys with OS-level keyboard input.",
};

const HYBRID_DOM_DESCRIPTION_OVERRIDES: Partial<Record<CuaDomActionType, string>> = {
	page_click:
		"Click an element by reference from a page_snapshot. Dispatched via CDP, which protected sites may detect — " +
		"prefer computer_click when the element is visible in the screenshot; use page_click for elements that are hard to hit by coordinate.",
	page_snapshot:
		"Return an accessibility-tree snapshot of the page with element references like [e12]. " +
		"This is the high-fidelity way to read page structure — prefer it over screenshots for reading and locating elements. " +
		"Refs are only valid until the page changes; re-snapshot when told a ref is stale.",
};

/** The model-facing tool description for a canonical action in a mode. */
export function cuaToolDescriptionForAction(action: CuaActionType, mode: CuaMode): string {
	if (isCuaOsActionType(action)) {
		if (mode === "hybrid") {
			return HYBRID_OS_DESCRIPTION_OVERRIDES[action] ?? `Execute one ${action} computer action using real OS-level input.`;
		}
		return `Execute one ${action} computer action.`;
	}
	if (mode === "hybrid") {
		return HYBRID_DOM_DESCRIPTION_OVERRIDES[action] ?? DOM_ACTION_DESCRIPTIONS[action];
	}
	return DOM_ACTION_DESCRIPTIONS[action];
}
