import { Type, type TSchema } from "@earendil-works/pi-ai";

/**
 * Computer-plane canonical actions.
 *
 * These execute as real OS-level input against the Kernel browser VM (mouse,
 * keyboard, display capture) — never CDP. All coordinates are pixels in the
 * OS screenshot frame. The browser-plane vocabulary lives in `./browser` and is
 * executed over CDP; the two planes never share a coordinate frame.
 */
export const CUA_COMPUTER_ACTION_TYPES = [
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
	"back",
	"forward",
	"url",
	"cursor_position",
] as const;

export type CuaComputerActionType = (typeof CUA_COMPUTER_ACTION_TYPES)[number];

/**
 * The default computer-mode toolset. This is the pre-modes canonical action list:
 * every computer action except `zoom`, which is only exposed by default in hybrid
 * mode and by Anthropic's native computer tool (`enable_zoom`).
 */
export const CUA_DEFAULT_COMPUTER_ACTION_TYPES = CUA_COMPUTER_ACTION_TYPES.filter(
	(action): action is Exclude<CuaComputerActionType, "zoom"> => action !== "zoom",
);

/**
 * Mouse buttons accepted by click, mouse_down, and mouse_up actions. The
 * executor coerces anything outside this set to "left".
 */
export type CuaMouseButton = "left" | "right" | "middle" | "back" | "forward";

/**
 * Mouse buttons accepted by drag actions. The executor coerces anything
 * outside this set to "left".
 */
export type CuaDragMouseButton = "left" | "right" | "middle";

export interface CuaActionClick {
	type: "click";
	/** OS screenshot pixels. Omitted (native mappings only) means the current cursor position. */
	x?: number;
	y?: number;
	button?: CuaMouseButton;
	hold_keys?: string[];
	num_clicks?: number;
}

export interface CuaActionDoubleClick {
	type: "double_click";
	x: number;
	y: number;
	hold_keys?: string[];
}

export interface CuaActionMouseDown {
	type: "mouse_down";
	x?: number;
	y?: number;
	button?: CuaMouseButton;
	hold_keys?: string[];
}

export interface CuaActionMouseUp {
	type: "mouse_up";
	x?: number;
	y?: number;
	button?: CuaMouseButton;
	hold_keys?: string[];
}

export interface CuaActionTypeText {
	type: "type";
	text: string;
}

export interface CuaActionKeypress {
	type: "keypress";
	keys: string[];
	duration?: number;
}

export interface CuaActionScroll {
	type: "scroll";
	x?: number;
	y?: number;
	scroll_x?: number;
	scroll_y?: number;
	hold_keys?: string[];
}

export interface CuaActionMove {
	type: "move";
	x: number;
	y: number;
}

export interface CuaActionDrag {
	type: "drag";
	path: Array<{ x: number; y: number }>;
	button?: CuaDragMouseButton;
	hold_keys?: string[];
}

export interface CuaActionWait {
	type: "wait";
	ms?: number;
}

export interface CuaActionScreenshot {
	type: "screenshot";
}

/** Crop of the most recent OS screenshot; region is [x0, y0, x1, y1] in OS screenshot pixels. */
export interface CuaActionZoom {
	type: "zoom";
	region: [number, number, number, number];
}

export interface CuaActionGoto {
	type: "goto";
	url: string;
}

export interface CuaActionBack {
	type: "back";
}

export interface CuaActionForward {
	type: "forward";
}

export interface CuaActionUrl {
	type: "url";
}

export interface CuaActionCursorPosition {
	type: "cursor_position";
}

export type CuaComputerAction =
	| CuaActionClick
	| CuaActionDoubleClick
	| CuaActionMouseDown
	| CuaActionMouseUp
	| CuaActionTypeText
	| CuaActionKeypress
	| CuaActionScroll
	| CuaActionMove
	| CuaActionDrag
	| CuaActionWait
	| CuaActionScreenshot
	| CuaActionZoom
	| CuaActionGoto
	| CuaActionBack
	| CuaActionForward
	| CuaActionUrl
	| CuaActionCursorPosition;

const PointSchema = Type.Object(
	{
		x: Type.Number(),
		y: Type.Number(),
	},
	{ additionalProperties: false },
);

export const CUA_COMPUTER_ACTION_SCHEMA_BY_TYPE = {
	click: Type.Object(
		{
			type: Type.Literal("click"),
			x: Type.Number(),
			y: Type.Number(),
			button: Type.Optional(Type.String()),
			hold_keys: Type.Optional(Type.Array(Type.String())),
			num_clicks: Type.Optional(Type.Number()),
		},
		{ additionalProperties: false },
	),
	double_click: Type.Object(
		{
			type: Type.Literal("double_click"),
			x: Type.Number(),
			y: Type.Number(),
			hold_keys: Type.Optional(Type.Array(Type.String())),
		},
		{ additionalProperties: false },
	),
	mouse_down: Type.Object(
		{
			type: Type.Literal("mouse_down"),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			button: Type.Optional(Type.String()),
			hold_keys: Type.Optional(Type.Array(Type.String())),
		},
		{ additionalProperties: false },
	),
	mouse_up: Type.Object(
		{
			type: Type.Literal("mouse_up"),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			button: Type.Optional(Type.String()),
			hold_keys: Type.Optional(Type.Array(Type.String())),
		},
		{ additionalProperties: false },
	),
	type: Type.Object(
		{
			type: Type.Literal("type"),
			text: Type.String(),
		},
		{ additionalProperties: false },
	),
	keypress: Type.Object(
		{
			type: Type.Literal("keypress"),
			keys: Type.Array(Type.String()),
			duration: Type.Optional(Type.Number()),
		},
		{ additionalProperties: false },
	),
	scroll: Type.Object(
		{
			type: Type.Literal("scroll"),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			scroll_x: Type.Optional(Type.Number()),
			scroll_y: Type.Optional(Type.Number()),
			hold_keys: Type.Optional(Type.Array(Type.String())),
		},
		{ additionalProperties: false },
	),
	move: Type.Object(
		{
			type: Type.Literal("move"),
			x: Type.Number(),
			y: Type.Number(),
		},
		{ additionalProperties: false },
	),
	drag: Type.Object(
		{
			type: Type.Literal("drag"),
			path: Type.Array(PointSchema, { minItems: 2 }),
			button: Type.Optional(Type.String()),
			hold_keys: Type.Optional(Type.Array(Type.String())),
		},
		{ additionalProperties: false },
	),
	wait: Type.Object(
		{
			type: Type.Literal("wait"),
			ms: Type.Optional(Type.Number()),
		},
		{ additionalProperties: false },
	),
	screenshot: Type.Object({ type: Type.Literal("screenshot") }, { additionalProperties: false }),
	zoom: Type.Object(
		{
			type: Type.Literal("zoom"),
			// Not Type.Tuple: tuples emit draft-07 `items: [...]`, which Anthropic's
			// draft 2020-12 schema validation rejects.
			region: Type.Array(Type.Number(), {
				minItems: 4,
				maxItems: 4,
				description: "[x0, y0, x1, y1] crop region in OS screenshot pixels.",
			}),
		},
		{ additionalProperties: false },
	),
	goto: Type.Object(
		{
			type: Type.Literal("goto"),
			url: Type.String(),
		},
		{ additionalProperties: false },
	),
	back: Type.Object({ type: Type.Literal("back") }, { additionalProperties: false }),
	forward: Type.Object({ type: Type.Literal("forward") }, { additionalProperties: false }),
	url: Type.Object({ type: Type.Literal("url") }, { additionalProperties: false }),
	cursor_position: Type.Object({ type: Type.Literal("cursor_position") }, { additionalProperties: false }),
} satisfies Record<CuaComputerActionType, TSchema>;

export type CuaZoomRegion = CuaActionZoom["region"];
