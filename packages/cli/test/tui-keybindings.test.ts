import { describe, expect, it } from "vitest";
import { getKeybindings } from "@earendil-works/pi-tui";
import { cuaKeyText, installCuaKeybindings } from "../src/tui/keybindings";
import { fitMaxVisible, PICKER_MAX_VISIBLE } from "../src/tui/model-picker";

describe("installCuaKeybindings", () => {
	it("registers cua.tools.* ids so the pickers can match them", () => {
		installCuaKeybindings();
		const kb = getKeybindings();
		// Without registration these resolve to [] and the bulk actions silently
		// do nothing.
		expect(kb.getKeys("cua.tools.enableAll")).toEqual(["ctrl+a"]);
		expect(kb.getKeys("cua.tools.clearAll")).toEqual(["ctrl+x"]);
		expect(kb.getKeys("cua.tools.reset")).toEqual(["ctrl+r"]);
		expect(kb.getKeys("cua.tools.apply")).toEqual(["ctrl+s"]);
		expect(kb.matches("\x01", "cua.tools.enableAll")).toBe(true);
		expect(kb.matches("\x13", "cua.tools.apply")).toBe(true);
	});

	it("keeps pi's base bindings intact", () => {
		installCuaKeybindings();
		const kb = getKeybindings();
		expect(kb.getKeys("tui.select.confirm")).toEqual(["enter"]);
		expect(kb.getKeys("tui.select.cancel")).toEqual(["escape", "ctrl+c"]);
	});
});

describe("cuaKeyText", () => {
	it("renders hint text for cua and pi ids alike", () => {
		installCuaKeybindings();
		expect(cuaKeyText("cua.tools.apply")).toBe("ctrl+s");
		expect(cuaKeyText("cua.tools.enableAll")).toBe("ctrl+a");
		expect(cuaKeyText("tui.select.confirm")).toBe("enter");
		expect(cuaKeyText("tui.select.cancel")).toBe("escape/ctrl+c");
	});
});

describe("fitMaxVisible", () => {
	it("uses the full height cap on a roomy terminal", () => {
		expect(fitMaxVisible(50, 22)).toBe(PICKER_MAX_VISIBLE);
	});

	it("shrinks the list rather than overflowing a short terminal", () => {
		expect(fitMaxVisible(30, 22)).toBe(8);
		expect(fitMaxVisible(24, 22)).toBe(3);
		expect(fitMaxVisible(10, 22)).toBe(3);
	});
});
