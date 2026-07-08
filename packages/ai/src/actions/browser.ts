import { Type, type TSchema } from "@earendil-works/pi-ai";

/**
 * Browser-plane canonical actions.
 *
 * These execute over CDP against the browser itself: accessibility-tree
 * reads with element references, element-targeted interaction, navigation,
 * tabs, and viewport screenshots. Where a browser action takes coordinates
 * (`browser_click`, `browser_hover`, `browser_drag`, `browser_scroll`), they are pixels
 * in the browser viewport — a different frame from the computer-plane actions in
 * `./computer`. Modes that expose both planes (hybrid) therefore restrict browser
 * actions to element references so exactly one coordinate frame is live.
 *
 * Element references (`ref`) are snapshot-scoped opaque ids (`e12`) minted
 * by `browser_snapshot` / `browser_find`; a stale ref is an error instructing the
 * model to re-snapshot.
 */
export const CUA_BROWSER_ACTION_TYPES = [
	"browser_snapshot",
	"browser_text",
	"browser_find",
	"browser_click",
	"browser_hover",
	"browser_drag",
	"browser_fill",
	"browser_scroll_to",
	"browser_scroll",
	"browser_type",
	"browser_key",
	"browser_navigate",
	"browser_list_tabs",
	"browser_new_tab",
	"browser_screenshot",
	"browser_evaluate",
] as const;

export type CuaBrowserActionType = (typeof CUA_BROWSER_ACTION_TYPES)[number];

export interface CuaActionBrowserSnapshot {
	type: "browser_snapshot";
	filter?: "all" | "interactive";
	ref?: string;
	depth?: number;
	tab_id?: string;
}

export interface CuaActionBrowserText {
	type: "browser_text";
	tab_id?: string;
}

export interface CuaActionBrowserFind {
	type: "browser_find";
	query: string;
	tab_id?: string;
}

export interface CuaActionBrowserClick {
	type: "browser_click";
	ref?: string;
	x?: number;
	y?: number;
	button?: "left" | "right" | "middle";
	num_clicks?: number;
	modifiers?: string[];
	tab_id?: string;
}

export interface CuaActionBrowserHover {
	type: "browser_hover";
	ref?: string;
	x?: number;
	y?: number;
	tab_id?: string;
}

export interface CuaActionBrowserDrag {
	type: "browser_drag";
	from: { x: number; y: number };
	to: { x: number; y: number };
	tab_id?: string;
}

export interface CuaActionBrowserFill {
	type: "browser_fill";
	ref: string;
	value: string | number | boolean;
	tab_id?: string;
}

export interface CuaActionBrowserScrollTo {
	type: "browser_scroll_to";
	ref: string;
	tab_id?: string;
}

export interface CuaActionBrowserScroll {
	type: "browser_scroll";
	x: number;
	y: number;
	direction: "up" | "down" | "left" | "right";
	amount?: number;
	tab_id?: string;
}

export interface CuaActionBrowserType {
	type: "browser_type";
	text: string;
	tab_id?: string;
}

export interface CuaActionBrowserKey {
	type: "browser_key";
	text: string;
	repeat?: number;
	tab_id?: string;
}

export interface CuaActionBrowserNavigate {
	type: "browser_navigate";
	/** A URL, or the sentinels "back" / "forward" for history navigation. */
	url: string;
	tab_id?: string;
}

export interface CuaActionBrowserListTabs {
	type: "browser_list_tabs";
}

export interface CuaActionBrowserNewTab {
	type: "browser_new_tab";
}

export interface CuaActionBrowserScreenshot {
	type: "browser_screenshot";
	/** Optional crop region, [x0, y0, x1, y1] in viewport pixels. */
	region?: [number, number, number, number];
	tab_id?: string;
}

export interface CuaActionBrowserEvaluate {
	type: "browser_evaluate";
	code: string;
	tab_id?: string;
}

export type CuaBrowserAction =
	| CuaActionBrowserSnapshot
	| CuaActionBrowserText
	| CuaActionBrowserFind
	| CuaActionBrowserClick
	| CuaActionBrowserHover
	| CuaActionBrowserDrag
	| CuaActionBrowserFill
	| CuaActionBrowserScrollTo
	| CuaActionBrowserScroll
	| CuaActionBrowserType
	| CuaActionBrowserKey
	| CuaActionBrowserNavigate
	| CuaActionBrowserListTabs
	| CuaActionBrowserNewTab
	| CuaActionBrowserScreenshot
	| CuaActionBrowserEvaluate;

/** Options for building browser action schemas. */
export interface CuaBrowserSchemaOptions {
	/**
	 * Whether coordinate targeting is allowed on `browser_click` / `browser_hover`
	 * and whether `browser_drag` / `browser_scroll` are expressible at all. Browser
	 * mode allows viewport coordinates (they are the only frame); hybrid mode
	 * must disallow them so the OS screenshot frame stays the single live
	 * coordinate frame.
	 */
	coordinates: boolean;
}

const TabId = () => Type.Optional(Type.String({ description: "Tab to act on. Defaults to the active tab." }));

const RefProperty = () => Type.String({ description: "Element reference from browser_snapshot or browser_find, e.g. \"e12\"." });

export function createCuaBrowserActionSchemaByType(options: CuaBrowserSchemaOptions): Record<CuaBrowserActionType, TSchema> {
	const clickTarget: Record<string, TSchema> = options.coordinates
		? {
				ref: Type.Optional(RefProperty()),
				x: Type.Optional(Type.Number({ description: "Viewport x in pixels. Prefer ref targeting when available." })),
				y: Type.Optional(Type.Number({ description: "Viewport y in pixels. Prefer ref targeting when available." })),
			}
		: { ref: RefProperty() };

	return {
		browser_snapshot: Type.Object(
			{
				type: Type.Literal("browser_snapshot"),
				filter: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("interactive")])),
				ref: Type.Optional(Type.String({ description: "Restrict the snapshot to the subtree rooted at this element reference." })),
				depth: Type.Optional(Type.Number({ description: "Maximum tree depth (default 15)." })),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		browser_text: Type.Object(
			{
				type: Type.Literal("browser_text"),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		browser_find: Type.Object(
			{
				type: Type.Literal("browser_find"),
				query: Type.String({ description: "Natural-language element description, e.g. \"the cookie consent accept button\"." }),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		browser_click: Type.Object(
			{
				type: Type.Literal("browser_click"),
				...clickTarget,
				button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
				num_clicks: Type.Optional(Type.Number()),
				modifiers: Type.Optional(Type.Array(Type.String())),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		browser_hover: Type.Object(
			{
				type: Type.Literal("browser_hover"),
				...clickTarget,
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		browser_drag: Type.Object(
			{
				type: Type.Literal("browser_drag"),
				from: Type.Object({ x: Type.Number(), y: Type.Number() }, { additionalProperties: false }),
				to: Type.Object({ x: Type.Number(), y: Type.Number() }, { additionalProperties: false }),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		browser_fill: Type.Object(
			{
				type: Type.Literal("browser_fill"),
				ref: RefProperty(),
				value: Type.Union([Type.String(), Type.Number(), Type.Boolean()], {
					description: "Value to set. Use a boolean for checkboxes, an option value or label for selects.",
				}),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		browser_scroll_to: Type.Object(
			{
				type: Type.Literal("browser_scroll_to"),
				ref: RefProperty(),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		browser_scroll: Type.Object(
			{
				type: Type.Literal("browser_scroll"),
				x: Type.Number({ description: "Viewport x anchor in pixels." }),
				y: Type.Number({ description: "Viewport y anchor in pixels." }),
				direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
				amount: Type.Optional(Type.Number({ description: "Scroll-wheel notches (default 3)." })),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		browser_type: Type.Object(
			{
				type: Type.Literal("browser_type"),
				text: Type.String(),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		browser_key: Type.Object(
			{
				type: Type.Literal("browser_key"),
				text: Type.String({ description: "Key or chord, e.g. \"Return\", \"ctrl+a\"." }),
				repeat: Type.Optional(Type.Number()),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		browser_navigate: Type.Object(
			{
				type: Type.Literal("browser_navigate"),
				url: Type.String({ description: "URL to navigate to, or \"back\" / \"forward\" for history navigation." }),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		browser_list_tabs: Type.Object({ type: Type.Literal("browser_list_tabs") }, { additionalProperties: false }),
		browser_new_tab: Type.Object({ type: Type.Literal("browser_new_tab") }, { additionalProperties: false }),
		browser_screenshot: Type.Object(
			{
				type: Type.Literal("browser_screenshot"),
				// Not Type.Tuple: tuples emit draft-07 `items: [...]`, which Anthropic's
				// draft 2020-12 schema validation rejects.
				region: Type.Optional(
					Type.Array(Type.Number(), {
						minItems: 4,
						maxItems: 4,
						description: "Optional crop region, [x0, y0, x1, y1] in viewport pixels.",
					}),
				),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		browser_evaluate: Type.Object(
			{
				type: Type.Literal("browser_evaluate"),
				code: Type.String({ description: "JavaScript to evaluate in the page context. The value of the last expression is returned." }),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
	};
}
