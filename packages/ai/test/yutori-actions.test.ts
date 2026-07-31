import { describe, expect, it } from "vitest";
import type { CuaAction } from "../src/index";
import * as yutori from "../src/providers/yutori/actions";

const n15CoreActionArgs = {
	left_click: { coordinates: [500, 250] },
	double_click: { coordinates: [500, 250] },
	triple_click: { coordinates: [500, 250] },
	middle_click: { coordinates: [500, 250] },
	right_click: { coordinates: [500, 250] },
	mouse_move: { coordinates: [100, 200] },
	mouse_down: { coordinates: [100, 200] },
	mouse_up: { coordinates: [100, 200] },
	drag: { start_coordinates: [100, 200], coordinates: [300, 400] },
	scroll: { coordinates: [500, 500], direction: "down", amount: 3 },
	type: { text: "hello" },
	key_press: { key: "ctrl+c" },
	hold_key: { key: "shift", duration: 1.5 },
	goto_url: { url: "https://example.com" },
	go_back: {},
	go_forward: {},
	refresh: {},
	wait: { duration: 1 },
} satisfies Record<(typeof yutori.YUTORI_N15_CORE_ACTION_TYPES)[number], Record<string, unknown>>;

describe("Yutori native action normalization", () => {
	it("has canonical mappings for every n1.5 core action", () => {
		for (const action of yutori.YUTORI_N15_CORE_ACTION_TYPES) {
			const canonical = yutori.toCanonicalActions(action, n15CoreActionArgs[action]);
			expect(canonical, `${action} did not map to canonical CUA actions`).toBeDefined();
			expect(canonical!.length, `${action} mapped to an empty action list`).toBeGreaterThan(0);
			for (const item of canonical as CuaAction[]) {
				expect(typeof item.type).toBe("string");
			}
		}
	});

	it("normalizes n1/n1.5 click actions to canonical individual actions", () => {
		expect(yutori.toCanonicalActions("left_click", { coordinates: [500, 250] })).toEqual([
			{ type: "click", x: 500, y: 250 },
		]);
		expect(yutori.toCanonicalActions("double_click", { coordinates: [500, 250] })).toEqual([
			{ type: "double_click", x: 500, y: 250 },
		]);
		expect(yutori.toCanonicalActions("triple_click", { coordinates: [500, 250] })).toEqual([
			{ type: "double_click", x: 500, y: 250 },
			{ type: "click", x: 500, y: 250 },
		]);
		expect(yutori.toCanonicalActions("middle_click", { coordinates: [500, 250] })).toEqual([
			{ type: "click", x: 500, y: 250, button: "middle" },
		]);
	});

	it("normalizes mouse, drag, type, and keyboard actions", () => {
		expect(yutori.toCanonicalActions("mouse_move", { coordinates: [100, 200] })).toEqual([
			{ type: "move", x: 100, y: 200 },
		]);
		expect(yutori.toCanonicalActions("drag", { start_coordinates: [100, 200], coordinates: [300, 400] })).toEqual([
			{ type: "drag", path: [{ x: 100, y: 200 }, { x: 300, y: 400 }], button: "left" },
		]);
		expect(yutori.toCanonicalActions("type", { text: "hello", clear_before_typing: true, press_enter_after: true })).toEqual([
			{ type: "keypress", keys: ["ctrl", "a"] },
			{ type: "keypress", keys: ["backspace"] },
			{ type: "type", text: "hello" },
			{ type: "keypress", keys: ["enter"] },
		]);
		expect(yutori.toCanonicalActions("hold_key", { key: "shift", duration: 1.5 })).toEqual([
			{ type: "keypress", keys: ["shift"], duration: 1500 },
		]);
		expect(yutori.toCanonicalActions("key_press", { key: "ctrl+c" })).toEqual([
			{ type: "keypress", keys: ["ctrl", "c"] },
		]);
		expect(yutori.toCanonicalActions("key_press", { key: "down down enter" })).toEqual([
			{ type: "keypress", keys: ["down"] },
			{ type: "keypress", keys: ["down"] },
			{ type: "keypress", keys: ["enter"] },
		]);
	});

	it("normalizes scroll and navigation actions", () => {
		expect(yutori.toCanonicalActions("scroll", { coordinates: [500, 500], direction: "down", amount: 3 })).toEqual([
			{ type: "scroll", x: 500, y: 500, scroll_x: 0, scroll_y: 360 },
		]);
		expect(yutori.toCanonicalActions("goto_url", { url: "https://example.com" })).toEqual([
			{ type: "goto", url: "https://example.com" },
			{ type: "wait", ms: 2000 },
		]);
		expect(yutori.toCanonicalActions("goto_url", { url: "example.com" })).toEqual([
			{ type: "goto", url: "https://example.com" },
			{ type: "wait", ms: 2000 },
		]);
		expect(yutori.toCanonicalActions("refresh", {})).toEqual([
			{ type: "keypress", keys: ["f5"] },
			{ type: "wait", ms: 2000 },
		]);
	});
});
