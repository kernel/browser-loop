import { describe, expect, it } from "vitest";
import {
	anthropic,
	betaHeaderForNativeTool,
	modeForNativeTool,
	resolveCuaRuntimeSpec,
	type CuaAction,
} from "../src/index";
import {
	ANTHROPIC_NATIVE_BROWSER_MESSAGES_API,
	ANTHROPIC_NATIVE_COMPUTER_MESSAGES_API,
	mapNativeBrowserInput,
	mapNativeComputerInput,
} from "../src/providers/anthropic/native";

describe("native tool validation", () => {
	it("infers mode from the native tool", () => {
		expect(modeForNativeTool({ type: "computer_20260701" })).toBe("computer");
		expect(modeForNativeTool({ type: "browser_20260701" })).toBe("browser");
	});

	it("carries the beta header per tool", () => {
		expect(betaHeaderForNativeTool({ type: "computer_20260701" })).toBe("computer-use-2026-07-01");
		expect(betaHeaderForNativeTool({ type: "browser_20260701" })).toBe("browser-use-2026-07-01");
	});

	it("rejects a native tool with a conflicting mode", () => {
		expect(() => resolveCuaRuntimeSpec("anthropic:claude-opus-4-5", { mode: "browser", nativeTool: { type: "computer_20260701" } })).toThrow(
			/requires mode "computer"/,
		);
		expect(() =>
			resolveCuaRuntimeSpec("anthropic:claude-opus-4-5", { mode: "hybrid", nativeTool: { type: "browser_20260701" } }),
		).toThrow(/requires mode "browser"/);
	});

	it("rejects native tools on non-anthropic models", () => {
		expect(() => resolveCuaRuntimeSpec("openai:gpt-5.5", { nativeTool: { type: "computer_20260701" } })).toThrow(
			/requires an anthropic model/,
		);
	});
});

describe("native runtime specs", () => {
	it("routes computer_20260701 to the native api with a single placeholder tool", () => {
		const spec = resolveCuaRuntimeSpec("anthropic:claude-opus-4-5", { nativeTool: { type: "computer_20260701", enable_zoom: true } });
		expect(spec.mode).toBe("computer");
		expect(spec.model.api).toBe(ANTHROPIC_NATIVE_COMPUTER_MESSAGES_API);
		expect(spec.nativeTool?.betaHeader).toBe("computer-use-2026-07-01");
		expect(spec.toolDefinitions.map((tool) => tool.name)).toEqual(["computer"]);
	});

	it("routes browser_20260701 to the native api under the default name", () => {
		const spec = resolveCuaRuntimeSpec("anthropic:claude-opus-4-5", { nativeTool: { type: "browser_20260701" } });
		expect(spec.mode).toBe("browser");
		expect(spec.model.api).toBe(ANTHROPIC_NATIVE_BROWSER_MESSAGES_API);
		expect(spec.toolDefinitions.map((tool) => tool.name)).toEqual(["browser"]);
	});

	it("folds javascriptExec into the native browser declaration unless the spec is explicit", () => {
		const folded = resolveCuaRuntimeSpec("anthropic:claude-opus-4-5", {
			nativeTool: { type: "browser_20260701" },
			javascriptExec: true,
		});
		expect(folded.nativeTool?.declaration.enable_javascript_exec).toBe(true);

		const explicit = resolveCuaRuntimeSpec("anthropic:claude-opus-4-5", {
			nativeTool: { type: "browser_20260701", enable_javascript_exec: false },
			javascriptExec: true,
		});
		expect(explicit.nativeTool?.declaration.enable_javascript_exec).toBe(false);
	});

	it("swaps the placeholder tool for the native declaration in the payload", async () => {
		const spec = resolveCuaRuntimeSpec("anthropic:claude-opus-4-5", { nativeTool: { type: "computer_20260701", enable_zoom: true } });
		const payload = {
			tools: [
				{ name: "computer", description: "placeholder", input_schema: {} },
				{ name: "playwright_execute", description: "keep me", input_schema: {} },
			],
		};
		const next = (await spec.onPayload?.(payload, spec.model)) as { tools: Array<Record<string, unknown>> };
		expect(next.tools[0]).toEqual({ type: "computer_20260701", name: "computer", enable_zoom: true });
		expect(next.tools[1]!.name).toBe("playwright_execute");
	});
});

describe("computer_20260701 action mapping", () => {
	it("maps clicks with coordinates, buttons, and modifier chords", () => {
		expect(mapNativeComputerInput({ action: "left_click", coordinate: [10, 20], text: "ctrl+shift" })).toEqual([
			{ type: "click", x: 10, y: 20, button: "left", hold_keys: ["ctrl", "shift"] },
		]);
		expect(mapNativeComputerInput({ action: "triple_click", coordinate: [1, 2] })).toEqual([
			{ type: "click", x: 1, y: 2, button: "left", num_clicks: 3 },
		]);
	});

	it("maps clicks without coordinates to the current cursor position", () => {
		expect(mapNativeComputerInput({ action: "left_click" })).toEqual([{ type: "click", button: "left" }]);
	});

	it("expands key repeat into repeated keypresses", () => {
		expect(mapNativeComputerInput({ action: "key", text: "Down", repeat: 3 })).toEqual([
			{ type: "keypress", keys: ["Down"] },
			{ type: "keypress", keys: ["Down"] },
			{ type: "keypress", keys: ["Down"] },
		]);
	});

	it("maps scroll direction and wheel notches to deltas", () => {
		expect(mapNativeComputerInput({ action: "scroll", coordinate: [5, 6], scroll_direction: "down", scroll_amount: 2 })).toEqual([
			{ type: "scroll", x: 5, y: 6, scroll_y: 240 },
		]);
	});

	it("maps drag, wait, and zoom", () => {
		expect(mapNativeComputerInput({ action: "left_click_drag", start_coordinate: [1, 2], coordinate: [3, 4] })).toEqual([
			{ type: "drag", path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
		]);
		expect(mapNativeComputerInput({ action: "wait", duration: 2 })).toEqual([{ type: "wait", ms: 2000 }]);
		expect(mapNativeComputerInput({ action: "zoom", region: [0, 0, 10, 10] })).toEqual([{ type: "zoom", region: [0, 0, 10, 10] }]);
	});

	it("rejects unknown actions", () => {
		expect(() => mapNativeComputerInput({ action: "warp" })).toThrow(/unsupported computer_20260701 action/);
	});
});

describe("browser_20260701 action mapping", () => {
	it("maps DOM reads", () => {
		expect(mapNativeBrowserInput({ action: "read_page", filter: "interactive", depth: 5 })).toEqual([
			{ type: "browser_snapshot", filter: "interactive", depth: 5 },
		]);
		expect(mapNativeBrowserInput({ action: "find", query: "search bar" })).toEqual([{ type: "browser_find", query: "search bar" }]);
		expect(mapNativeBrowserInput({ action: "get_page_text", tab_id: "T1" })).toEqual([{ type: "browser_text", tab_id: "T1" }]);
	});

	it("maps ref and coordinate click targets", () => {
		expect(mapNativeBrowserInput({ action: "left_click", target: { type: "ref", ref: "e7" } })).toEqual([
			{ type: "browser_click", ref: "e7" },
		]);
		expect(mapNativeBrowserInput({ action: "left_click", target: { type: "coordinate", x: 4, y: 5 }, modifiers: "shift" })).toEqual([
			{ type: "browser_click", x: 4, y: 5, modifiers: ["shift"] },
		]);
	});

	it("requires ref targets on form_input and scroll_to", () => {
		expect(mapNativeBrowserInput({ action: "form_input", target: { type: "ref", ref: "e7" }, value: "hi" })).toEqual([
			{ type: "browser_fill", ref: "e7", value: "hi" },
		]);
		expect(() => mapNativeBrowserInput({ action: "scroll_to", target: { type: "coordinate", x: 1, y: 2 } })).toThrow(/requires a ref/);
	});

	it("maps navigation, tabs, zoom, and javascript_exec", () => {
		expect(mapNativeBrowserInput({ action: "navigate", url: "back" })).toEqual([{ type: "browser_navigate", url: "back" }]);
		expect(mapNativeBrowserInput({ action: "list_tabs" })).toEqual([{ type: "browser_list_tabs" }]);
		expect(mapNativeBrowserInput({ action: "zoom", region: [1, 2, 3, 4] })).toEqual([
			{ type: "browser_screenshot", region: [1, 2, 3, 4] },
		]);
		expect(mapNativeBrowserInput({ action: "javascript_exec", text: "document.title" })).toEqual([
			{ type: "browser_evaluate", code: "document.title" },
		]);
	});
});

describe("native tool executors", () => {
	it("translate native tool calls through the runtime spec executors", () => {
		const spec = resolveCuaRuntimeSpec("anthropic:claude-opus-4-5", { nativeTool: { type: "browser_20260701" } });
		const executor = spec.toolExecutors[0]!;
		const actions: CuaAction[] = executor.toActions({ action: "left_click", target: { type: "ref", ref: "e3" } });
		expect(actions).toEqual([{ type: "browser_click", ref: "e3" }]);
	});

	it("exports the anthropic namespace surface", () => {
		expect(anthropic.mapNativeComputerInput).toBeTypeOf("function");
		expect(anthropic.ANTHROPIC_NATIVE_COMPUTER_MESSAGES_API).toBe(ANTHROPIC_NATIVE_COMPUTER_MESSAGES_API);
	});
});
