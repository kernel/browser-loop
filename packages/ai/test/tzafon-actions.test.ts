import { describe, expect, it } from "vitest";
import * as tzafon from "../src/providers/tzafon/provider";

describe("Tzafon native action normalization", () => {
	it("normalizes click variants", () => {
		expect(tzafon.toCanonicalActions({ type: "click", x: 10, y: 20 })).toEqual([{ type: "click", x: 10, y: 20 }]);
		expect(tzafon.toCanonicalActions({ type: "left_click", x: 10, y: 20 })).toEqual([{ type: "click", x: 10, y: 20 }]);
		expect(tzafon.toCanonicalActions({ type: "right_click", x: 10, y: 20 })).toEqual([
			{ type: "click", x: 10, y: 20, button: "right" },
		]);
		expect(tzafon.toCanonicalActions({ type: "double_click", x: 10, y: 20 })).toEqual([
			{ type: "double_click", x: 10, y: 20 },
		]);
		expect(tzafon.toCanonicalActions({ type: "triple_click", x: 10, y: 20 })).toEqual([
			{ type: "double_click", x: 10, y: 20 },
			{ type: "click", x: 10, y: 20 },
		]);
	});

	it("coerces string coordinates to numbers", () => {
		expect(tzafon.toCanonicalActions({ type: "click", x: "10", y: "20" })).toEqual([{ type: "click", x: 10, y: 20 }]);
	});

	it("drops pointer actions without usable coordinates", () => {
		expect(tzafon.toCanonicalActions({ type: "click" })).toEqual([]);
		expect(tzafon.toCanonicalActions({ type: "hover", x: 5 })).toEqual([]);
		expect(tzafon.toCanonicalActions(undefined)).toEqual([]);
		expect(tzafon.toCanonicalActions({ type: "unknown_action" })).toEqual([]);
	});

	it("normalizes move, hover, and drag", () => {
		expect(tzafon.toCanonicalActions({ type: "move", x: 1, y: 2 })).toEqual([{ type: "move", x: 1, y: 2 }]);
		expect(tzafon.toCanonicalActions({ type: "hover", x: 1, y: 2 })).toEqual([{ type: "move", x: 1, y: 2 }]);
		expect(tzafon.toCanonicalActions({ type: "drag", path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] })).toEqual([
			{ type: "drag", path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
		]);
		expect(tzafon.toCanonicalActions({ type: "drag", x: 1, y: 2, end_x: 3, end_y: 4 })).toEqual([
			{ type: "drag", path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
		]);
		expect(tzafon.toCanonicalActions({ type: "drag", x: 1, y: 2, x2: 3, y2: 4 })).toEqual([
			{ type: "drag", path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
		]);
	});

	it("normalizes typing and keyboard actions", () => {
		expect(tzafon.toCanonicalActions({ type: "type", text: "hello" })).toEqual([{ type: "type", text: "hello" }]);
		expect(tzafon.toCanonicalActions({ type: "key", key: "enter" })).toEqual([{ type: "keypress", keys: ["enter"] }]);
		expect(tzafon.toCanonicalActions({ type: "key", text: "esc" })).toEqual([{ type: "keypress", keys: ["esc"] }]);
		expect(tzafon.toCanonicalActions({ type: "keypress", keys: ["ctrl", "a"] })).toEqual([
			{ type: "keypress", keys: ["ctrl", "a"] },
		]);
		expect(tzafon.toCanonicalActions({ type: "keypress" })).toEqual([]);
	});

	it("normalizes scroll variants", () => {
		expect(tzafon.toCanonicalActions({ type: "scroll", x: 5, y: 6, scroll_y: 120 })).toEqual([
			{ type: "scroll", x: 5, y: 6, scroll_y: 120 },
		]);
		expect(tzafon.toCanonicalActions({ type: "scroll", amount: 240 })).toEqual([{ type: "scroll", scroll_y: 240 }]);
		expect(tzafon.toCanonicalActions({ type: "hscroll", amount: 120 })).toEqual([{ type: "scroll", scroll_x: 120 }]);
		expect(tzafon.toCanonicalActions({ type: "hscroll" })).toEqual([{ type: "scroll", scroll_x: 0 }]);
	});

	it("normalizes navigation, waits, and screenshots", () => {
		expect(tzafon.toCanonicalActions({ type: "navigate", url: "https://example.com" })).toEqual([
			{ type: "goto", url: "https://example.com" },
		]);
		expect(tzafon.toCanonicalActions({ type: "wait", ms: 500 })).toEqual([{ type: "wait", ms: 500 }]);
		expect(tzafon.toCanonicalActions({ type: "wait", seconds: 2 })).toEqual([{ type: "wait", ms: 2000 }]);
		expect(tzafon.toCanonicalActions({ type: "screenshot" })).toEqual([{ type: "screenshot" }]);
	});

	it("maps terminal actions to answer text", () => {
		expect(tzafon.toCanonicalActions({ type: "answer", text: "done!" })).toEqual([{ type: "answer", text: "done!" }]);
		expect(tzafon.toCanonicalActions({ type: "done", result: "ok" })).toEqual([{ type: "answer", text: "ok" }]);
		expect(tzafon.toCanonicalActions({ type: "terminate", status: "success" })).toEqual([
			{ type: "answer", text: "success" },
		]);
	});
});
