import {
	CUA_BROWSER_ACTION_TYPES,
	CUA_DEFAULT_COMPUTER_ACTION_TYPES,
	isCuaComputerActionType,
	type CuaActionSchemaOptions,
	type CuaActionType,
	type CuaBrowserActionType,
	type CuaComputerActionType,
} from "./actions/index";

/**
 * Which canonical action plane(s) a CUA agent exposes to the model.
 *
 * - `computer` — OS-level input only (mouse/keyboard/display against the
 *   VM). Today's default; coordinates are OS screenshot pixels. Pairs with
 *   Anthropic's native `computer_20260701` tool.
 * - `browser` — page tools only, driven over CDP: accessibility snapshots
 *   with element refs, element-targeted interaction, navigation, tabs, and
 *   viewport screenshots. Coordinates, where used, are viewport pixels.
 *   Pairs with Anthropic's native `browser_20260701` tool.
 * - `hybrid` — both planes, deduplicated to one tool per capability.
 *   Computer tools are prefixed `computer_`, browser tools keep their
 *   `browser_` prefix and accept element refs only, and the OS screenshot
 *   frame is the single live coordinate frame.
 */
export type CuaMode = "computer" | "browser" | "hybrid";

/**
 * Computer actions exposed in hybrid mode: navigation reads/writes are
 * excluded because they live on the browser plane (`browser_navigate`,
 * `browser_list_tabs`), and `zoom` is included since the OS screenshot is
 * hybrid's only capture.
 */
export const CUA_HYBRID_COMPUTER_ACTION_TYPES: readonly CuaComputerActionType[] = [
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
 * Browser actions exposed in hybrid mode: reads, element-targeted writes,
 * and JavaScript evaluation. Pointer/keyboard capabilities (`browser_click` by coordinate,
 * `browser_type`, `browser_key`, `browser_scroll`, `browser_hover`, `browser_drag`) and
 * `browser_screenshot` are excluded — real OS input and the OS screenshot cover
 * those, keeping one tool per capability and one coordinate frame.
 */
export const CUA_HYBRID_BROWSER_ACTION_TYPES: readonly CuaBrowserActionType[] = [
	"browser_snapshot",
	"browser_wait_for",
	"browser_text",
	"browser_find",
	"browser_click",
	"browser_fill",
	"browser_scroll_to",
	"browser_navigate",
	"browser_list_tabs",
	"browser_new_tab",
	"browser_evaluate",
];

/** Resolve the default canonical action set for a mode. */
export function defaultActionsForMode(mode: CuaMode): readonly CuaActionType[] {
	switch (mode) {
		case "computer":
			return CUA_DEFAULT_COMPUTER_ACTION_TYPES;
		case "browser":
			return [...CUA_BROWSER_ACTION_TYPES, "wait"];
		case "hybrid":
			return [...CUA_HYBRID_COMPUTER_ACTION_TYPES, ...CUA_HYBRID_BROWSER_ACTION_TYPES];
	}
}

/** Resolve the schema-building options for a mode; see {@link CuaActionSchemaOptions}. */
export function schemaOptionsForMode(mode: CuaMode): CuaActionSchemaOptions {
	// Hybrid restricts browser actions to element refs so the OS screenshot
	// frame is the single live coordinate frame. Browser mode has no OS frame,
	// so viewport coordinates are allowed there.
	return { browser: { coordinates: mode !== "hybrid" } };
}

/**
 * The model-facing tool name for a canonical action in a mode.
 *
 * - `computer`: canonical action ids as-is (`click`, `screenshot`, …).
 * - `browser`: browser ids with the `browser_` prefix stripped (`snapshot`,
 *   `click`, …); the prefix only exists to disambiguate planes, and
 *   browser mode has one.
 * - `hybrid`: computer ids prefixed `computer_`, browser ids kept as `browser_*`.
 */
export function cuaToolNameForAction(action: CuaActionType, mode: CuaMode): string {
	switch (mode) {
		case "computer":
			if (!isCuaComputerActionType(action)) throw new Error(`browser action "${action}" is not available in computer mode`);
			return action;
		case "browser":
			return isCuaComputerActionType(action) ? action : action.slice("browser_".length);
		case "hybrid":
			return isCuaComputerActionType(action) ? `computer_${action}` : action;
	}
}

const BROWSER_ACTION_DESCRIPTIONS: Record<CuaBrowserActionType, string> = {
	browser_wait_for: "Wait for a semantic page condition without delivering input.",
	browser_snapshot:
		"Return an accessibility-tree snapshot of the page, including iframe content, with element references like [e12]. " +
		"Use the refs to target elements in other page tools. Refs are only valid until the page changes; re-snapshot when told a ref is stale. " +
		"If the page has not changed since your previous snapshot, a short unchanged notice is returned instead and earlier refs remain valid.",
	browser_text: "Return the page's visible text content as plain text. Best for articles and text-heavy pages.",
	browser_find:
		"Find elements on the page (including iframe content) matching a natural-language description and return them with element references, like a filtered snapshot.",
	browser_click: "Click an element. Prefer targeting by element reference from a snapshot.",
	browser_hover: "Move the pointer over an element without clicking.",
	browser_drag: "Drag from one viewport coordinate to another.",
	browser_fill: "Set the value of a form element (input, textarea, select, checkbox) by element reference.",
	browser_scroll_to: "Scroll an element into view by element reference.",
	browser_scroll: "Scroll the page at a viewport position by wheel notches.",
	browser_type: "Type a literal string at the current focus.",
	browser_key: "Press a key or chord, e.g. \"Return\" or \"ctrl+a\".",
	browser_navigate: "Navigate the page to a URL, or \"back\" / \"forward\" in history.",
	browser_list_tabs: "List open tabs with each tab's id, title, and URL.",
	browser_new_tab: "Open a new empty tab and return its tab id.",
	browser_screenshot: "Capture the current browser viewport.",
	browser_evaluate: "Execute JavaScript in the page context and return the value of the last expression.",
};

// Hybrid exposes both planes, so tool descriptions carry the arbitration
// rules the model needs: which plane is preferred for a capability and why
// (real OS input vs CDP), plus the single-coordinate-frame statement.
const HYBRID_COMPUTER_DESCRIPTION_OVERRIDES: Partial<Record<CuaComputerActionType, string>> = {
	click:
		"Click at a coordinate in OS screenshot pixels using real OS-level input. " +
		"Preferred over browser_click when the target is visible in the screenshot — OS input is indistinguishable from a human user.",
	screenshot: "Capture the display. This is the only screenshot tool; all coordinates refer to this image's pixels.",
	zoom: "Return a cropped view of the current display for closer inspection. Coordinates in later actions still refer to the full screenshot, not the crop.",
	scroll: "Scroll with the OS-level mouse wheel at a coordinate in OS screenshot pixels.",
	type: "Type a literal string with OS-level keyboard input at the current focus.",
	keypress: "Press keys with OS-level keyboard input.",
};

const HYBRID_BROWSER_DESCRIPTION_OVERRIDES: Partial<Record<CuaBrowserActionType, string>> = {
	browser_click:
		"Click an element by reference from a browser_snapshot. Dispatched via CDP, which protected sites may detect — " +
		"prefer computer_click when the element is visible in the screenshot; use browser_click for elements that are hard to hit by coordinate.",
	browser_wait_for: "Wait for a semantic page condition without delivering input.",
	browser_snapshot:
		"Return an accessibility-tree snapshot of the page, including iframe content, with element references like [e12]. " +
		"This is the high-fidelity way to read page structure — prefer it over screenshots for reading and locating elements. " +
		"Refs are only valid until the page changes; re-snapshot when told a ref is stale. " +
		"If the page has not changed since your previous snapshot, a short unchanged notice is returned instead and earlier refs remain valid.",
};

/** The model-facing tool description for a canonical action in a mode. */
export function cuaToolDescriptionForAction(action: CuaActionType, mode: CuaMode): string {
	if (isCuaComputerActionType(action)) {
		if (mode === "hybrid") {
			return HYBRID_COMPUTER_DESCRIPTION_OVERRIDES[action] ?? `Execute one ${action} computer action using real OS-level input.`;
		}
		return `Execute one ${action} computer action.`;
	}
	if (mode === "hybrid") {
		return HYBRID_BROWSER_DESCRIPTION_OVERRIDES[action] ?? BROWSER_ACTION_DESCRIPTIONS[action];
	}
	return BROWSER_ACTION_DESCRIPTIONS[action];
}
