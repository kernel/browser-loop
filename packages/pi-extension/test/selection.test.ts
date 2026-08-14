import { getCuaModel } from "@onkernel/cua-ai";
import { describe, expect, it } from "vitest";
import {
	BROWSER_BATCH_ACTIONS,
	compileSpecs,
	COMPUTER_BATCH_ACTIONS,
	CUA_SELECTORS,
	CUA_TOOL_NAMES,
	expandSelection,
	parseSelection,
	selectorAvailability,
} from "../src/selection";

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
	it("compiles Anthropic native computer use only for supported Anthropic models", () => {
		const specs = expandSelection(parseSelection("anthropic-computer", "pixels"));
		const catalog = compileSpecs(getCuaModel("anthropic:claude-fable-5"), specs);
		expect(specs.map((tool) => tool.name)).toEqual(["computer"]);
		expect(catalog.entries.map((entry) => entry.transport)).toEqual(["native"]);
		expect(catalog.headers.requirements).toContainEqual(expect.objectContaining({ value: "computer-use-2026-07-01" }));
		expect(() => compileSpecs(getCuaModel("openai:gpt-5.6-sol"), specs)).toThrow("requires a anthropic model");
	});

	it("offers every provider-native surface as its own selector", () => {
		for (const selector of ["anthropic-computer", "anthropic-browser", "openai-computer", "google-browser"]) {
			expect(CUA_SELECTORS).toContain(selector);
			expect(expandSelection(parseSelection(selector, "pixels")).length).toBeGreaterThan(0);
		}
	});

	it("reports selector availability per model with the compiler's own reason", () => {
		const empty = parseSelection(undefined, "pixels");
		const anthropic = selectorAvailability(getCuaModel("anthropic:claude-opus-5"), empty);
		const byName = new Map(anthropic.map((entry) => [entry.selector, entry]));

		expect(byName.get("browser")?.available).toBe(true);
		expect(byName.get("anthropic-computer")?.available).toBe(true);
		// A different provider's native surface cannot compile for this model, and the
		// reason shown is the compiler's, not a restatement of its rules.
		expect(byName.get("openai-computer")?.available).toBe(false);
		expect(byName.get("openai-computer")?.reason).toMatch(/requires a openai model/);
	});

	it("accepts an empty selection and rejects ambiguity", () => {
		expect(expandSelection(parseSelection(undefined, undefined))).toEqual([]);
		expect(() => parseSelection("browser,browser", "pixels")).toThrow("duplicate");
		expect(() => parseSelection("native-openai", "pixels")).toThrow("unknown");
		expect(() => parseSelection("browser", "screen")).toThrow("coordinates");
		expect(() => expandSelection(parseSelection("browser,browser_snapshot", "pixels"))).toThrow("duplicate tool identity");
	});
});
