import { describe, expect, it } from "vitest";
import {
	normalizeKernelKey,
	normalizeKernelKeyCombo,
	normalizeKernelKeySequence,
} from "../src/core/translator/keys";

describe("Kernel key normalization", () => {
	it("normalizes common provider key names to X11 keysyms", () => {
		expect(normalizeKernelKey("ctrl")).toBe("Control_L");
		expect(normalizeKernelKey("command")).toBe("Super_L");
		expect(normalizeKernelKey("Backspace")).toBe("BackSpace");
		expect(normalizeKernelKey("ArrowLeft")).toBe("Left");
		expect(normalizeKernelKey("enter")).toBe("Return");
		expect(normalizeKernelKey("f12")).toBe("F12");
	});

	it("absorbs word-form punctuation and sequential key syntax models emit", () => {
		expect(normalizeKernelKeyCombo("ctrl+plus")).toEqual(["Control_L", "plus"]);
		expect(normalizeKernelKeyCombo("command+backquote")).toEqual(["Super_L", "grave"]);
		expect(normalizeKernelKeyCombo("option+tab")).toEqual(["Alt_L", "Tab"]);
		expect(normalizeKernelKey("kp_enter")).toBe("Return");
		expect(normalizeKernelKey("-")).toBe("minus");
		expect(normalizeKernelKeySequence("down down enter")).toEqual([["Down"], ["Down"], ["Return"]]);
		expect(normalizeKernelKeySequence("tab ctrl+a")).toEqual([["Tab"], ["Control_L", "a"]]);
	});
});
