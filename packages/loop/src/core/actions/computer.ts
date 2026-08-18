import { Type, type TSchema } from "typebox";

/**
 * Computer-plane canonical actions.
 *
 * These execute as real OS-level input against the Kernel browser VM (mouse,
 * keyboard, display capture) — never CDP. All coordinates are pixels in the
 * OS screenshot frame. The browser-plane vocabulary lives in `./browser` and is
 * executed over CDP; the two planes never share a coordinate frame.
 */
export const COMPUTER_ACTION_TYPES = [
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

export type ComputerActionType = (typeof COMPUTER_ACTION_TYPES)[number];

/**
 * Mouse buttons accepted by click, mouse_down, and mouse_up actions. The
 * executor coerces anything outside this set to "left".
 */
export type MouseButton = "left" | "right" | "middle" | "back" | "forward";

/**
 * Mouse buttons accepted by drag actions. The executor coerces anything
 * outside this set to "left".
 */
export type DragMouseButton = "left" | "right" | "middle";

export interface ComputerActionClick {
	type: "click";
	/** OS screenshot pixels. Omitted (native mappings only) means the current cursor position. */
	x?: number;
	y?: number;
	button?: MouseButton;
	hold_keys?: string[];
	num_clicks?: number;
}

export interface ComputerActionDoubleClick {
	type: "double_click";
	x: number;
	y: number;
	hold_keys?: string[];
}

export interface ComputerActionMouseDown {
	type: "mouse_down";
	x?: number;
	y?: number;
	button?: MouseButton;
	hold_keys?: string[];
}

export interface ComputerActionMouseUp {
	type: "mouse_up";
	x?: number;
	y?: number;
	button?: MouseButton;
	hold_keys?: string[];
}

export interface ComputerActionTypeText {
	type: "type";
	text: string;
}

export interface ComputerActionKeypress {
	type: "keypress";
	keys: string[];
	duration?: number;
}

export interface ComputerActionScroll {
	type: "scroll";
	x?: number;
	y?: number;
	scroll_x?: number;
	scroll_y?: number;
	hold_keys?: string[];
}

export interface ComputerActionMove {
	type: "move";
	x: number;
	y: number;
}

export interface ComputerActionDrag {
	type: "drag";
	path: Array<{ x: number; y: number }>;
	button?: DragMouseButton;
	hold_keys?: string[];
}

export interface ComputerActionWait {
	type: "wait";
	ms?: number;
}

export interface ComputerActionScreenshot {
	type: "screenshot";
}

/** Crop of the most recent OS screenshot; region is [x0, y0, x1, y1] in OS screenshot pixels. */
export interface ComputerActionZoom {
	type: "zoom";
	region: [number, number, number, number];
}

export interface ComputerActionGoto {
	type: "goto";
	url: string;
}

export interface ComputerActionBack {
	type: "back";
}

export interface ComputerActionForward {
	type: "forward";
}

export interface ComputerActionUrl {
	type: "url";
}

export interface ComputerActionCursorPosition {
	type: "cursor_position";
}

export type ComputerAction =
	| ComputerActionClick
	| ComputerActionDoubleClick
	| ComputerActionMouseDown
	| ComputerActionMouseUp
	| ComputerActionTypeText
	| ComputerActionKeypress
	| ComputerActionScroll
	| ComputerActionMove
	| ComputerActionDrag
	| ComputerActionWait
	| ComputerActionScreenshot
	| ComputerActionZoom
	| ComputerActionGoto
	| ComputerActionBack
	| ComputerActionForward
	| ComputerActionUrl
	| ComputerActionCursorPosition;

const PointSchema = Type.Object(
	{
		x: Type.Number(),
		y: Type.Number(),
	},
	{ additionalProperties: false },
);

export const COMPUTER_ACTION_SCHEMA_BY_TYPE = {
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
} satisfies Record<ComputerActionType, TSchema>;
