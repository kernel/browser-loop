import { describe, expect, it } from "vitest";
import { BROWSER_BATCH_ACTIONS, COMPUTER_BATCH_ACTIONS, CUA_TOOL_NAMES, expandSelection, parseSelection } from "../src/catalog";

describe("CUA pi selectors", () => {
	it("has stable exact browser and computer preset membership", () => {
		expect(expandSelection(parseSelection("browser", "pixels")).map((tool) => tool.name)).toEqual([
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
			"browser_wait_for",
		]);
		expect(expandSelection(parseSelection("computer", "normalized-1000")).map((tool) => tool.name)).toEqual([
			"computer_click",
			"computer_double_click",
			"computer_mouse_down",
			"computer_mouse_up",
			"computer_type",
			"computer_keypress",
			"computer_scroll",
			"computer_move",
			"computer_drag",
			"computer_wait",
			"computer_screenshot",
			"computer_goto",
			"computer_back",
			"computer_forward",
			"computer_url",
			"computer_cursor_position",
		]);
	});
	it("expands special selectors without native provider tools", () => {
		expect(
			expandSelection(parseSelection("browser-act,browser-batch,computer-batch,playwright", "pixels")).map((tool) => tool.name),
		).toEqual(["browser_act", "browser_batch", "computer_batch", "playwright_execute"]);
		expect(BROWSER_BATCH_ACTIONS).toHaveLength(17);
		expect(COMPUTER_BATCH_ACTIONS).toHaveLength(17);
		expect(CUA_TOOL_NAMES).not.toContain("computer");
	});
	it("accepts an empty selection and rejects ambiguity", () => {
		expect(expandSelection(parseSelection(undefined, undefined))).toEqual([]);
		expect(() => parseSelection("browser,browser", "pixels")).toThrow("duplicate");
		expect(() => parseSelection("native-openai", "pixels")).toThrow("unknown");
		expect(() => parseSelection("browser", "screen")).toThrow("coordinates");
		expect(() => expandSelection(parseSelection("browser,browser_snapshot", "pixels"))).toThrow("duplicate tool identity");
	});
});
