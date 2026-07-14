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
	"browser_act",
	"browser_wait_for",
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

type RoleNameExpectation =
	| { type: "role_name"; role: string; name?: string; exists?: boolean }
	| { type: "role_name"; role?: string; name: string; exists?: boolean };
type RefExpectationState = { value?: string; checked?: boolean | "mixed"; selected?: boolean; expanded?: boolean };
type RefExpectation = { type: "ref"; ref: string } & (
	| (RefExpectationState & { value: string })
	| (RefExpectationState & { checked: boolean | "mixed" })
	| (RefExpectationState & { selected: boolean })
	| (RefExpectationState & { expanded: boolean })
);
type LocationExpectation = { type: "url" | "title" } & (
	| { equals: string; contains?: string; changed?: boolean }
	| { equals?: string; contains: string; changed?: boolean }
	| { equals?: string; contains?: string; changed: boolean }
);
type CuaBrowserExpectationLeaf =
	| { type: "text"; text: string; exists?: boolean }
	| RoleNameExpectation
	| RefExpectation
	| LocationExpectation;
type NonEmptyArray<T> = [T, ...T[]];
/** Semantic condition over accessible content, ref state, location, or all/any leaf groups. */
export type CuaBrowserExpectation = CuaBrowserExpectationLeaf | { all: NonEmptyArray<CuaBrowserExpectationLeaf> } | { any: NonEmptyArray<CuaBrowserExpectationLeaf> };

export interface CuaActionBrowserWaitFor {
	type: "browser_wait_for";
	expect: CuaBrowserExpectation;
	/** Semantic polling timeout; an in-flight browser read settles before timeout is reported. */
	timeout_ms?: number;
	poll_ms?: number;
	tab_id?: string;
}

type CuaBrowserActStepOptions = {
	/** Timeout for performing this step and verifying its expectation, capped by the plan deadline. */
	timeout_ms?: number;
	expect?: CuaBrowserExpectation;
};

/** Ref- or focus-based operation with an optional per-step semantic expectation. */
export type CuaBrowserActStep = (
	| { type: "click"; ref: string; button?: "left" | "right" | "middle"; num_clicks?: 1 | 2 | 3; modifiers?: string[] }
	| { type: "hover"; ref: string }
	| { type: "fill"; ref: string; value: string | number | boolean }
	| { type: "type"; text: string }
	| { type: "key"; text: string; repeat?: number }
	| { type: "scroll_to"; ref: string }
	| { type: "wait"; ms?: number }
) & CuaBrowserActStepOptions;

/** Dependent action plan whose optional `expect` verifies the complete plan result. */
export interface CuaActionBrowserAct {
	type: "browser_act";
	steps: NonEmptyArray<CuaBrowserActStep>;
	expect?: CuaBrowserExpectation;
	/** Global timeout for performing every step and verifying the plan expectation. */
	timeout_ms?: number;
	poll_ms?: number;
	successor?: { filter?: "all" | "interactive"; depth?: number };
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
	num_clicks?: 1 | 2 | 3;
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
	| CuaActionBrowserAct
	| CuaActionBrowserWaitFor
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
	const exists = () => Type.Optional(Type.Boolean({ description: "Whether the matching content must exist (default true)." }));
	const roleName = (required: "role" | "name") => Type.Object(
		{
			type: Type.Literal("role_name"),
			role: required === "role"
				? Type.String({ description: "Exact accessibility role, e.g. button or textbox." })
				: Type.Optional(Type.String({ description: "Exact accessibility role, e.g. button or textbox." })),
			name: required === "name"
				? Type.String({ description: "Exact, case-sensitive accessible name." })
				: Type.Optional(Type.String({ description: "Exact, case-sensitive accessible name." })),
			exists: exists(),
		},
		{ additionalProperties: false },
	);
	const checked = () => Type.Union([Type.Boolean(), Type.Literal("mixed")], { description: "Required checkbox/radio state." });
	const refState = (required: "value" | "checked" | "selected" | "expanded") => Type.Object(
		{
			type: Type.Literal("ref"),
			ref: RefProperty(),
			value: required === "value"
				? Type.String({ description: "Exact element value." })
				: Type.Optional(Type.String({ description: "Exact element value." })),
			checked: required === "checked" ? checked() : Type.Optional(checked()),
			selected: required === "selected"
				? Type.Boolean({ description: "Required selected state." })
				: Type.Optional(Type.Boolean({ description: "Required selected state." })),
			expanded: required === "expanded"
				? Type.Boolean({ description: "Required expanded state." })
				: Type.Optional(Type.Boolean({ description: "Required expanded state." })),
		},
		{ additionalProperties: false },
	);
	const location = (required: "equals" | "contains" | "changed") => Type.Object(
		{
			type: Type.Union([Type.Literal("url"), Type.Literal("title")]),
			equals: required === "equals"
				? Type.String({ description: "Exact URL or title." })
				: Type.Optional(Type.String({ description: "Exact URL or title." })),
			contains: required === "contains"
				? Type.String({ description: "Case-sensitive URL or title substring." })
				: Type.Optional(Type.String({ description: "Case-sensitive URL or title substring." })),
			changed: required === "changed"
				? Type.Boolean({ description: "Whether the URL or title must differ from the value observed when this wait starts." })
				: Type.Optional(Type.Boolean({ description: "Whether the URL or title must differ from the value observed when this wait starts." })),
		},
		{ additionalProperties: false },
	);
	const leaves = [
		Type.Object(
			{
				type: Type.Literal("text"),
				text: Type.String({ description: "Case-insensitive, whitespace-normalized accessible-text substring." }),
				exists: exists(),
			},
			{ additionalProperties: false },
		),
		roleName("role"),
		roleName("name"),
		refState("value"),
		refState("checked"),
		refState("selected"),
		refState("expanded"),
		location("equals"),
		location("contains"),
		location("changed"),
	];
	const leaf = Type.Union(leaves);
	const expectation = Type.Union(
		[
			leaf,
			Type.Object({ all: Type.Array(leaf, { minItems: 1, description: "Every leaf must match." }) }, { additionalProperties: false }),
			Type.Object({ any: Type.Array(leaf, { minItems: 1, description: "At least one leaf must match." }) }, { additionalProperties: false }),
		],
		{ description: "Semantic condition evaluated from structured browser observations." },
	);
	const actStepOptions = {
		timeout_ms: Type.Optional(Type.Number({ minimum: 1, maximum: 30_000, description: "Timeout for performing this step and verifying its expectation, capped by the plan deadline." })),
		expect: Type.Optional(expectation),
	};
	const actStep = Type.Union([
		Type.Object({ type: Type.Literal("click"), ref: RefProperty(), button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])), num_clicks: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })), modifiers: Type.Optional(Type.Array(Type.String())), ...actStepOptions }, { additionalProperties: false }),
		Type.Object({ type: Type.Literal("hover"), ref: RefProperty(), ...actStepOptions }, { additionalProperties: false }),
		Type.Object({ type: Type.Literal("fill"), ref: RefProperty(), value: Type.Union([Type.String(), Type.Number(), Type.Boolean()]), ...actStepOptions }, { additionalProperties: false }),
		Type.Object({ type: Type.Literal("type"), text: Type.String(), ...actStepOptions }, { additionalProperties: false }),
		Type.Object({ type: Type.Literal("key"), text: Type.String(), repeat: Type.Optional(Type.Number()), ...actStepOptions }, { additionalProperties: false }),
		Type.Object({ type: Type.Literal("scroll_to"), ref: RefProperty(), ...actStepOptions }, { additionalProperties: false }),
		Type.Object({ type: Type.Literal("wait"), ms: Type.Optional(Type.Number({ minimum: 0, maximum: 30_000 })), ...actStepOptions }, { additionalProperties: false }),
	]);

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
		browser_wait_for: Type.Object(
			{ type: Type.Literal("browser_wait_for"), expect: expectation, timeout_ms: Type.Optional(Type.Number({ minimum: 1, maximum: 30_000, description: "Semantic polling timeout in milliseconds (default 2000); in-flight browser reads settle before timeout is reported." })), poll_ms: Type.Optional(Type.Number({ minimum: 10, maximum: 1_000, description: "Polling interval in milliseconds (default 50)." })), tab_id: TabId() },
			{ additionalProperties: false },
		),
		browser_act: Type.Object(
			{
				type: Type.Literal("browser_act"),
				steps: Type.Array(actStep, { minItems: 1, maxItems: 20 }),
				expect: Type.Optional(expectation),
				timeout_ms: Type.Optional(Type.Number({ minimum: 1, maximum: 30_000, description: "Global timeout for performing all steps and verifying the plan expectation (default 30000)." })),
				poll_ms: Type.Optional(Type.Number({ minimum: 10, maximum: 1_000 })),
				successor: Type.Optional(Type.Object({ filter: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("interactive")])), depth: Type.Optional(Type.Number()) }, { additionalProperties: false })),
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
				num_clicks: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
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
