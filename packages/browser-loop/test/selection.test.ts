import { getLoopModel } from "../src/pi/index";
import { describe, expect, it } from "vitest";
import {
	compileSpecs,
	expandSelection,
	LOOP_SELECTORS,
	parseSelection,
	selectorAvailability,
} from "../src/pi-extension/selection";
import { DEFAULT_BROWSER_TIMEOUT_SECONDS } from "../src/pi-extension/browser-runtime";
import { parseBrowserOptions } from "../src/pi-extension/index";

describe("Loop pi selectors", () => {
	it("has stable exact browser and computer entry membership, batch included", () => {
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
			"browser_batch",
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
			"computer_batch",
		]);
	});
	it("offers exactly the eight menu entries", () => {
		expect([...LOOP_SELECTORS]).toEqual([
			"browser",
			"computer",
			"browser-act",
			"playwright",
			"anthropic-computer",
			"anthropic-browser",
			"openai-computer",
			"google-browser",
		]);
		// Packaging variants are gone: the batch tool ships inside its generic entry,
		// and the 37 individual tool names are no longer selectable on their own.
		for (const retired of ["mixed", "browser-batch", "computer-batch", "browser_snapshot", "computer_click"]) {
			expect(() => parseSelection(retired, "pixels")).toThrow(/unknown browser tool selector/);
		}
		expect(expandSelection(parseSelection("browser-act,playwright", "pixels")).map((tool) => tool.name)).toEqual([
			"browser_act",
			"playwright_execute",
		]);
	});
	it("compiles Anthropic native computer use only for supported Anthropic models", () => {
		const specs = expandSelection(parseSelection("anthropic-computer", "pixels"));
		const catalog = compileSpecs(getLoopModel("anthropic:claude-fable-5"), specs);
		expect(specs.map((tool) => tool.name)).toEqual(["computer"]);
		expect(catalog.entries.map((entry) => entry.transport)).toEqual(["native"]);
		expect(catalog.headers.requirements).toEqual([]);
		expect(catalog.incoming.anthropicToolsets).toEqual(["computer"]);
		expect(() => compileSpecs(getLoopModel("openai:gpt-5.6-sol"), specs)).toThrow("requires a anthropic model");
	});

	it("offers every provider-native surface as its own selector", () => {
		for (const selector of ["anthropic-computer", "anthropic-browser", "openai-computer", "google-browser"]) {
			expect(LOOP_SELECTORS).toContain(selector);
			expect(expandSelection(parseSelection(selector, "pixels")).length).toBeGreaterThan(0);
		}
	});

	it("derives a native surface's transport onto the compiled model", () => {
		// This api is what the extension must put on the wire; pi's registry model
		// carries the builtin transport instead.
		const openai = expandSelection(parseSelection("openai-computer", "pixels"));
		expect(compileSpecs(getLoopModel("openai:gpt-5.6-sol"), openai).model.api).toBe("openai-computer-use");

		const google = expandSelection(parseSelection("google-browser", "pixels"));
		expect(compileSpecs(getLoopModel("google:gemini-3.6-flash"), google).model.api).toBe("google-interactions");

		// And the incoming plan is what normalizes the calls that come back.
		expect(compileSpecs(getLoopModel("openai:gpt-5.6-sol"), openai).incoming.openaiComputerName).toBe("computer");
		expect(compileSpecs(getLoopModel("anthropic:claude-opus-5"), expandSelection(parseSelection("anthropic-browser", "pixels"))).incoming
			.anthropicToolsets).toEqual(["browser"]);
	});

	it("reports selector availability per model with the compiler's own reason", () => {
		const empty = parseSelection(undefined, "pixels");
		const byName = new Map(selectorAvailability(getLoopModel("openai:gpt-5.6-sol"), empty).map((entry) => [entry.selector, entry]));

		expect(byName.get("browser")?.available).toBe(true);
		expect(byName.get("playwright")?.available).toBe(true);
		// The reason shown is the compiler's, not a restatement of its rules.
		expect(byName.get("anthropic-computer")?.available).toBe(false);
		expect(byName.get("anthropic-computer")?.reason).toMatch(/requires a anthropic model/);
	});

	it("accepts an empty selection and rejects ambiguity", () => {
		expect(expandSelection(parseSelection(undefined, undefined))).toEqual([]);
		expect(() => parseSelection("browser,browser", "pixels")).toThrow("duplicate");
		expect(() => parseSelection("native-openai", "pixels")).toThrow("unknown");
		expect(() => parseSelection("browser", "screen")).toThrow("coordinates");
	});

	it("combines Anthropic's computer and browser toolsets", () => {
		const both = expandSelection(parseSelection("anthropic-computer,anthropic-browser", "pixels"));
		const catalog = compileSpecs(getLoopModel("anthropic:claude-opus-5"), both);
		expect(catalog.incoming.anthropicToolsets).toEqual(["computer", "browser"]);
	});

	it("reports no conflict between Anthropic's toolsets", () => {
		const byName = new Map(
			selectorAvailability(getLoopModel("anthropic:claude-opus-5"), parseSelection(undefined, "pixels")).map((e) => [e.selector, e]),
		);
		expect(byName.get("anthropic-computer")?.available).toBe(true);
		expect(byName.get("anthropic-computer")?.conflictsWith).not.toContain("anthropic-browser");
		expect(byName.get("anthropic-browser")?.conflictsWith).not.toContain("anthropic-computer");
		expect(byName.get("playwright")?.conflictsWith).toEqual([]);
	});

	it("does not mark every row unavailable when the current selection fails to compile", () => {
		const model = getLoopModel("anthropic:claude-opus-5");
		const failing = parseSelection("anthropic-computer,openai-computer", "pixels");
		expect(() => compileSpecs(model, expandSelection(failing))).toThrow();

		const byName = new Map(selectorAvailability(model, failing).map((e) => [e.selector, e]));
		expect(byName.get("playwright")?.available).toBe(true);
		expect(byName.get("browser")?.available).toBe(true);
		expect(byName.get("playwright")?.reason).toBeUndefined();
	});
});

describe("browser options", () => {
	it("takes one JSON object and defaults only the timeout", () => {
		expect(parseBrowserOptions(undefined, undefined)).toEqual({ create: {} });
		expect(parseBrowserOptions(undefined, '{"stealth":true,"proxy_id":"p1"}')).toEqual({
			create: { stealth: true, proxy_id: "p1" },
		});
		// Forwarded verbatim, so a field the SDK adds needs no flag here.
		expect(parseBrowserOptions(undefined, '{"invented_future_field":42}').create).toMatchObject({ invented_future_field: 42 });
		expect(DEFAULT_BROWSER_TIMEOUT_SECONDS).toBe(600);
	});

	it("rejects input that would silently do nothing", () => {
		expect(() => parseBrowserOptions(undefined, "not json")).toThrow(/must be valid JSON/);
		expect(() => parseBrowserOptions(undefined, "[1,2]")).toThrow(/must be a JSON object/);
		// Attaching an existing browser and configuring a new one are contradictory.
		expect(() => parseBrowserOptions("sess_1", '{"stealth":true}')).toThrow(/attaches an existing browser/);
		expect(parseBrowserOptions("sess_1", undefined)).toEqual({ sessionId: "sess_1", create: {} });
	});
});
