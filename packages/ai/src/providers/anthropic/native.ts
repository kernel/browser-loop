import { Type, type Api, type Model, type StreamOptions, type Tool } from "@earendil-works/pi-ai";
import type { CuaAction, CuaMouseButton } from "../../actions/index";
import type { ResolvedCuaNativeTool } from "../../native-tools";
import type { CuaPayloadContext, CuaPayloadHook, CuaToolExecutorSpec } from "../common";

/**
 * pi-ai api ids CUA routes Anthropic models to when a native tool is
 * configured. The registered provider dispatches these to pi's builtin
 * `anthropic-messages` transport with the tool's `anthropic-beta` header
 * merged in (see `createCuaModels`).
 */
export const ANTHROPIC_NATIVE_COMPUTER_MESSAGES_API = "anthropic-cua-native-computer-messages";
export const ANTHROPIC_NATIVE_BROWSER_MESSAGES_API = "anthropic-cua-native-browser-messages";

export const ANTHROPIC_NATIVE_API_BETA_HEADERS: Record<string, string> = {
	[ANTHROPIC_NATIVE_COMPUTER_MESSAGES_API]: "computer-use-2026-07-01",
	[ANTHROPIC_NATIVE_BROWSER_MESSAGES_API]: "browser-use-2026-07-01",
};

export function nativeApiForToolType(type: ResolvedCuaNativeTool["spec"]["type"]): string {
	return type === "computer_20260701" ? ANTHROPIC_NATIVE_COMPUTER_MESSAGES_API : ANTHROPIC_NATIVE_BROWSER_MESSAGES_API;
}

/** Merge a native tool's `anthropic-beta` header into stream options. */
export function withAnthropicBetaHeader<T extends StreamOptions>(options: T | undefined, beta: string): T {
	const headers = { ...(options?.headers ?? {}) };
	headers["anthropic-beta"] = headers["anthropic-beta"] ? `${headers["anthropic-beta"]},${beta}` : beta;
	return { ...(options ?? {}), headers } as T;
}

// The native tool's input schema is Anthropic-defined and validated
// server-side; the local placeholder schema stays permissive and the
// executor validates during mapping.
const NativeActionSchema = Type.Object({ action: Type.String() }, { additionalProperties: true });

/**
 * Build the single execution adapter for a native Anthropic tool: tool calls
 * arrive under the native tool's name with an `action`-discriminated input,
 * and map onto the same canonical actions the tool's mode uses.
 */
export function nativeToolExecutors(resolved: ResolvedCuaNativeTool): CuaToolExecutorSpec[] {
	const definition: Tool = {
		name: resolved.name,
		description: `Anthropic native ${resolved.spec.type} tool.`,
		parameters: NativeActionSchema,
	};
	const toActions =
		resolved.spec.type === "computer_20260701"
			? (args: unknown) => mapNativeComputerInput(asNativeInput(args))
			: (args: unknown) => mapNativeBrowserInput(asNativeInput(args));
	return [{ definition, toActions }];
}

/**
 * Payload hook for native tool requests: replaces the local placeholder
 * function tool (matched by name) with the Anthropic-defined declaration.
 * Other tools in the payload (e.g. `playwright_execute`, caller extras) are
 * left in place.
 */
export function createNativeToolOnPayload(resolved: ResolvedCuaNativeTool): CuaPayloadHook {
	return (payload: unknown, _model: Model<Api>, _context?: CuaPayloadContext) => {
		if (!payload || typeof payload !== "object") return undefined;
		const current = payload as { tools?: unknown };
		if (!Array.isArray(current.tools)) return undefined;
		const tools = current.tools.map((tool) =>
			tool && typeof tool === "object" && (tool as { name?: unknown }).name === resolved.name ? resolved.declaration : tool,
		);
		return { ...(payload as Record<string, unknown>), tools };
	};
}

interface NativeInput {
	action: string;
	[key: string]: unknown;
}

function asNativeInput(args: unknown): NativeInput {
	if (args && typeof args === "object" && typeof (args as { action?: unknown }).action === "string") {
		return args as NativeInput;
	}
	throw new Error("invalid native tool parameters: expected an object with an \"action\" field");
}

const MAX_KEY_REPEAT = 100;

/** Map one `computer_20260701` tool input onto canonical computer-plane actions. */
export function mapNativeComputerInput(input: NativeInput): CuaAction[] {
	switch (input.action) {
		case "screenshot":
			return [{ type: "screenshot" }];
		case "left_click":
			return [click(input, "left")];
		case "right_click":
			return [click(input, "right")];
		case "middle_click":
			return [click(input, "middle")];
		case "double_click":
			return [{ ...click(input, "left"), num_clicks: 2 }];
		case "triple_click":
			return [{ ...click(input, "left"), num_clicks: 3 }];
		case "left_click_drag": {
			const start = coordinate(input.start_coordinate, "start_coordinate");
			const end = coordinate(input.coordinate, "coordinate");
			return [{ type: "drag", path: [start, end], ...holdKeys(input.text) }];
		}
		case "mouse_move":
			return [{ type: "move", ...coordinate(input.coordinate, "coordinate") }];
		case "left_mouse_down":
			return [{ type: "mouse_down" }];
		case "left_mouse_up":
			return [{ type: "mouse_up" }];
		case "scroll": {
			const point = input.coordinate === undefined ? {} : coordinate(input.coordinate, "coordinate");
			return [{ type: "scroll", ...point, ...scrollDeltas(input.scroll_direction, input.scroll_amount), ...holdKeys(input.text) }];
		}
		case "type":
			return [{ type: "type", text: text(input) }];
		case "key": {
			const repeat = clampRepeat(input.repeat);
			return Array.from({ length: repeat }, () => ({ type: "keypress" as const, keys: [text(input)] }));
		}
		case "hold_key":
			return [{ type: "keypress", keys: [text(input)], duration: durationSeconds(input) }];
		case "wait":
			return [{ type: "wait", ms: durationSeconds(input) * 1000 }];
		case "cursor_position":
			return [{ type: "cursor_position" }];
		case "zoom":
			return [{ type: "zoom", region: region(input.region) }];
		default:
			throw new Error(`unsupported computer_20260701 action "${input.action}"`);
	}
}

/** Map one `browser_20260701` tool input onto canonical browser-plane actions. */
export function mapNativeBrowserInput(input: NativeInput): CuaAction[] {
	const tab = tabId(input);
	switch (input.action) {
		case "navigate":
			return [{ type: "browser_navigate", url: requireString(input.url, "url"), ...tab }];
		case "list_tabs":
			return [{ type: "browser_list_tabs" }];
		case "new_tab":
			return [{ type: "browser_new_tab" }];
		case "read_page":
			return [
				{
					type: "browser_snapshot",
					...(input.filter === "interactive" || input.filter === "all" ? { filter: input.filter } : {}),
					...(typeof input.depth === "number" ? { depth: input.depth } : {}),
					...(typeof input.ref === "string" ? { ref: input.ref } : {}),
					...tab,
				},
			];
		case "get_page_text":
			return [{ type: "browser_text", ...tab }];
		case "find":
			return [{ type: "browser_find", query: requireString(input.query, "query"), ...tab }];
		case "form_input":
			return [{ type: "browser_fill", ref: refTarget(input.target), value: fillValue(input.value), ...tab }];
		case "scroll_to":
			return [{ type: "browser_scroll_to", ref: refTarget(input.target), ...tab }];
		case "screenshot":
			return [{ type: "browser_screenshot", ...tab }];
		case "zoom":
			return [{ type: "browser_screenshot", region: region(input.region), ...tab }];
		case "left_click":
			return [{ type: "browser_click", ...pageTarget(input.target), ...modifiers(input.modifiers), ...tab }];
		case "right_click":
			return [{ type: "browser_click", ...pageTarget(input.target), button: "right", ...modifiers(input.modifiers), ...tab }];
		case "double_click":
			return [{ type: "browser_click", ...pageTarget(input.target), num_clicks: 2, ...modifiers(input.modifiers), ...tab }];
		case "triple_click":
			return [{ type: "browser_click", ...pageTarget(input.target), num_clicks: 3, ...modifiers(input.modifiers), ...tab }];
		case "hover":
			return [{ type: "browser_hover", ...pageTarget(input.target), ...tab }];
		case "left_click_drag":
			return [{ type: "browser_drag", from: coordinateTarget(input.from, "from"), to: coordinateTarget(input.target, "target"), ...tab }];
		case "scroll":
			return [
				{
					type: "browser_scroll",
					...coordinateTarget(input.target, "target"),
					direction: scrollDirection(input.scroll_direction),
					...(typeof input.scroll_amount === "number" ? { amount: input.scroll_amount } : {}),
					...tab,
				},
			];
		case "type":
			return [{ type: "browser_type", text: text(input), ...tab }];
		case "key": {
			const repeat = clampRepeat(input.repeat);
			return Array.from({ length: repeat }, () => ({ type: "browser_key" as const, text: text(input), ...tab }));
		}
		case "wait":
			return [{ type: "wait", ms: durationSeconds(input) * 1000 }];
		case "javascript_exec":
			return [{ type: "browser_evaluate", code: text(input), ...tab }];
		default:
			throw new Error(`unsupported browser_20260701 action "${input.action}"`);
	}
}

function click(input: NativeInput, button: CuaMouseButton): CuaAction & { type: "click" } {
	const point = input.coordinate === undefined ? {} : coordinate(input.coordinate, "coordinate");
	return { type: "click", ...point, button, ...holdKeys(input.text) };
}

function coordinate(value: unknown, field: string): { x: number; y: number } {
	if (Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number") {
		return { x: value[0], y: value[1] };
	}
	throw new Error(`invalid ${field}: expected [x, y]`);
}

function region(value: unknown): [number, number, number, number] {
	if (Array.isArray(value) && value.length === 4 && value.every((entry) => typeof entry === "number")) {
		return value as [number, number, number, number];
	}
	throw new Error("invalid region: expected [x0, y0, x1, y1]");
}

function holdKeys(value: unknown): { hold_keys?: string[] } {
	return typeof value === "string" && value.trim() ? { hold_keys: value.split("+").map((key) => key.trim()) } : {};
}

function modifiers(value: unknown): { modifiers?: string[] } {
	return typeof value === "string" && value.trim() ? { modifiers: value.split("+").map((key) => key.trim()) } : {};
}

function scrollDeltas(direction: unknown, amount: unknown): { scroll_x?: number; scroll_y?: number } {
	const notches = typeof amount === "number" && Number.isFinite(amount) ? amount : 3;
	const delta = Math.trunc(notches) * 120;
	switch (direction) {
		case "up":
			return { scroll_y: -delta };
		case "down":
			return { scroll_y: delta };
		case "left":
			return { scroll_x: -delta };
		case "right":
			return { scroll_x: delta };
		default:
			throw new Error(`invalid scroll_direction "${String(direction)}"`);
	}
}

function scrollDirection(value: unknown): "up" | "down" | "left" | "right" {
	if (value === "up" || value === "down" || value === "left" || value === "right") return value;
	throw new Error(`invalid scroll_direction "${String(value)}"`);
}

function text(input: NativeInput): string {
	return requireString(input.text, "text");
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`invalid ${field}: expected a string`);
	return value;
}

function durationSeconds(input: NativeInput): number {
	const value = input.duration;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("invalid duration: expected a non-negative number");
	return Math.min(value, 100);
}

function clampRepeat(value: unknown): number {
	if (value === undefined) return 1;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error("invalid repeat: expected an integer ≥ 1");
	return Math.min(value, MAX_KEY_REPEAT);
}

interface RefOrCoordinateTarget {
	ref?: string;
	x?: number;
	y?: number;
}

function pageTarget(value: unknown): RefOrCoordinateTarget {
	const target = value as { type?: unknown; ref?: unknown; x?: unknown; y?: unknown } | undefined;
	if (target && typeof target === "object") {
		if (target.type === "ref" && typeof target.ref === "string") return { ref: target.ref };
		if (target.type === "coordinate" && typeof target.x === "number" && typeof target.y === "number") {
			return { x: target.x, y: target.y };
		}
	}
	throw new Error("invalid target: expected {type: \"ref\", ref} or {type: \"coordinate\", x, y}");
}

function refTarget(value: unknown): string {
	const target = pageTarget(value);
	if (target.ref === undefined) throw new Error("invalid target: this action requires a ref target");
	return target.ref;
}

function coordinateTarget(value: unknown, field: string): { x: number; y: number } {
	const target = pageTarget(value);
	if (target.x === undefined || target.y === undefined) throw new Error(`invalid ${field}: expected a coordinate target`);
	return { x: target.x, y: target.y };
}

function fillValue(value: unknown): string | number | boolean {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	throw new Error("invalid value: expected string, number, or boolean");
}

function tabId(input: NativeInput): { tab_id?: string } {
	return typeof input.tab_id === "string" ? { tab_id: input.tab_id } : {};
}
