import { Type, type TSchema } from "@earendil-works/pi-ai";

/**
 * DOM-plane canonical actions.
 *
 * These execute over CDP against the browser itself: accessibility-tree
 * reads with element references, element-targeted interaction, navigation,
 * tabs, and viewport screenshots. Where a DOM action takes coordinates
 * (`page_click`, `page_hover`, `page_drag`, `page_scroll`), they are pixels
 * in the browser viewport — a different frame from the OS-plane actions in
 * `./os`. Modes that expose both planes (hybrid) therefore restrict DOM
 * actions to element references so exactly one coordinate frame is live.
 *
 * Element references (`ref`) are snapshot-scoped opaque ids (`e12`) minted
 * by `page_snapshot` / `page_find`; a stale ref is an error instructing the
 * model to re-snapshot.
 */
export const CUA_DOM_ACTION_TYPES = [
	"page_snapshot",
	"page_text",
	"page_find",
	"page_click",
	"page_hover",
	"page_drag",
	"page_fill",
	"page_scroll_to",
	"page_scroll",
	"page_type",
	"page_key",
	"page_navigate",
	"page_list_tabs",
	"page_new_tab",
	"page_screenshot",
	"page_evaluate",
] as const;

export type CuaDomActionType = (typeof CUA_DOM_ACTION_TYPES)[number];

/**
 * The default DOM-mode toolset: everything except `page_evaluate`, which
 * runs arbitrary JavaScript in the page and must be enabled explicitly
 * (`javascriptExec: true`).
 */
export const CUA_DEFAULT_DOM_ACTION_TYPES = CUA_DOM_ACTION_TYPES.filter(
	(action): action is Exclude<CuaDomActionType, "page_evaluate"> => action !== "page_evaluate",
);

export interface CuaActionPageSnapshot {
	type: "page_snapshot";
	filter?: "all" | "interactive";
	ref?: string;
	depth?: number;
	tab_id?: string;
}

export interface CuaActionPageText {
	type: "page_text";
	tab_id?: string;
}

export interface CuaActionPageFind {
	type: "page_find";
	query: string;
	tab_id?: string;
}

export interface CuaActionPageClick {
	type: "page_click";
	ref?: string;
	x?: number;
	y?: number;
	button?: "left" | "right" | "middle";
	num_clicks?: number;
	modifiers?: string[];
	tab_id?: string;
}

export interface CuaActionPageHover {
	type: "page_hover";
	ref?: string;
	x?: number;
	y?: number;
	tab_id?: string;
}

export interface CuaActionPageDrag {
	type: "page_drag";
	from: { x: number; y: number };
	to: { x: number; y: number };
	tab_id?: string;
}

export interface CuaActionPageFill {
	type: "page_fill";
	ref: string;
	value: string | number | boolean;
	tab_id?: string;
}

export interface CuaActionPageScrollTo {
	type: "page_scroll_to";
	ref: string;
	tab_id?: string;
}

export interface CuaActionPageScroll {
	type: "page_scroll";
	x: number;
	y: number;
	direction: "up" | "down" | "left" | "right";
	amount?: number;
	tab_id?: string;
}

export interface CuaActionPageType {
	type: "page_type";
	text: string;
	tab_id?: string;
}

export interface CuaActionPageKey {
	type: "page_key";
	text: string;
	repeat?: number;
	tab_id?: string;
}

export interface CuaActionPageNavigate {
	type: "page_navigate";
	/** A URL, or the sentinels "back" / "forward" for history navigation. */
	url: string;
	tab_id?: string;
}

export interface CuaActionPageListTabs {
	type: "page_list_tabs";
}

export interface CuaActionPageNewTab {
	type: "page_new_tab";
}

export interface CuaActionPageScreenshot {
	type: "page_screenshot";
	/** Optional crop region, [x0, y0, x1, y1] in viewport pixels. */
	region?: [number, number, number, number];
	tab_id?: string;
}

export interface CuaActionPageEvaluate {
	type: "page_evaluate";
	code: string;
	tab_id?: string;
}

export type CuaDomAction =
	| CuaActionPageSnapshot
	| CuaActionPageText
	| CuaActionPageFind
	| CuaActionPageClick
	| CuaActionPageHover
	| CuaActionPageDrag
	| CuaActionPageFill
	| CuaActionPageScrollTo
	| CuaActionPageScroll
	| CuaActionPageType
	| CuaActionPageKey
	| CuaActionPageNavigate
	| CuaActionPageListTabs
	| CuaActionPageNewTab
	| CuaActionPageScreenshot
	| CuaActionPageEvaluate;

/** Options for building DOM action schemas. */
export interface CuaDomSchemaOptions {
	/**
	 * Whether coordinate targeting is allowed on `page_click` / `page_hover`
	 * and whether `page_drag` / `page_scroll` are expressible at all. DOM
	 * mode allows viewport coordinates (they are the only frame); hybrid mode
	 * must disallow them so the OS screenshot frame stays the single live
	 * coordinate frame.
	 */
	coordinates: boolean;
}

const TabId = () => Type.Optional(Type.String({ description: "Tab to act on. Defaults to the active tab." }));

const RefProperty = () => Type.String({ description: "Element reference from page_snapshot or page_find, e.g. \"e12\"." });

export function createCuaDomActionSchemaByType(options: CuaDomSchemaOptions): Record<CuaDomActionType, TSchema> {
	const clickTarget: Record<string, TSchema> = options.coordinates
		? {
				ref: Type.Optional(RefProperty()),
				x: Type.Optional(Type.Number({ description: "Viewport x in pixels. Prefer ref targeting when available." })),
				y: Type.Optional(Type.Number({ description: "Viewport y in pixels. Prefer ref targeting when available." })),
			}
		: { ref: RefProperty() };

	return {
		page_snapshot: Type.Object(
			{
				type: Type.Literal("page_snapshot"),
				filter: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("interactive")])),
				ref: Type.Optional(Type.String({ description: "Restrict the snapshot to the subtree rooted at this element reference." })),
				depth: Type.Optional(Type.Number({ description: "Maximum tree depth (default 15)." })),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		page_text: Type.Object(
			{
				type: Type.Literal("page_text"),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		page_find: Type.Object(
			{
				type: Type.Literal("page_find"),
				query: Type.String({ description: "Natural-language element description, e.g. \"the cookie consent accept button\"." }),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		page_click: Type.Object(
			{
				type: Type.Literal("page_click"),
				...clickTarget,
				button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
				num_clicks: Type.Optional(Type.Number()),
				modifiers: Type.Optional(Type.Array(Type.String())),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		page_hover: Type.Object(
			{
				type: Type.Literal("page_hover"),
				...clickTarget,
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		page_drag: Type.Object(
			{
				type: Type.Literal("page_drag"),
				from: Type.Object({ x: Type.Number(), y: Type.Number() }, { additionalProperties: false }),
				to: Type.Object({ x: Type.Number(), y: Type.Number() }, { additionalProperties: false }),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		page_fill: Type.Object(
			{
				type: Type.Literal("page_fill"),
				ref: RefProperty(),
				value: Type.Union([Type.String(), Type.Number(), Type.Boolean()], {
					description: "Value to set. Use a boolean for checkboxes, an option value or label for selects.",
				}),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		page_scroll_to: Type.Object(
			{
				type: Type.Literal("page_scroll_to"),
				ref: RefProperty(),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		page_scroll: Type.Object(
			{
				type: Type.Literal("page_scroll"),
				x: Type.Number({ description: "Viewport x anchor in pixels." }),
				y: Type.Number({ description: "Viewport y anchor in pixels." }),
				direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
				amount: Type.Optional(Type.Number({ description: "Scroll-wheel notches (default 3)." })),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		page_type: Type.Object(
			{
				type: Type.Literal("page_type"),
				text: Type.String(),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		page_key: Type.Object(
			{
				type: Type.Literal("page_key"),
				text: Type.String({ description: "Key or chord, e.g. \"Return\", \"ctrl+a\"." }),
				repeat: Type.Optional(Type.Number()),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		page_navigate: Type.Object(
			{
				type: Type.Literal("page_navigate"),
				url: Type.String({ description: "URL to navigate to, or \"back\" / \"forward\" for history navigation." }),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		page_list_tabs: Type.Object({ type: Type.Literal("page_list_tabs") }, { additionalProperties: false }),
		page_new_tab: Type.Object({ type: Type.Literal("page_new_tab") }, { additionalProperties: false }),
		page_screenshot: Type.Object(
			{
				type: Type.Literal("page_screenshot"),
				region: Type.Optional(
					Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()], {
						description: "Optional crop region, [x0, y0, x1, y1] in viewport pixels.",
					}),
				),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
		page_evaluate: Type.Object(
			{
				type: Type.Literal("page_evaluate"),
				code: Type.String({ description: "JavaScript to evaluate in the page context. The value of the last expression is returned." }),
				tab_id: TabId(),
			},
			{ additionalProperties: false },
		),
	};
}
