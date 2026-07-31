import { describe, expect, it } from "vitest";
import type Kernel from "@onkernel/sdk";
import type { CuaBrowserAction } from "@onkernel/cua-ai";
import type { BrowserExecutor } from "../src/translator/browser";
import { InternalComputerTranslator, type KernelBrowser } from "../src/translator/translator";

const browser = { session_id: "browser_123" } as KernelBrowser;

function createClient() {
	const batches: unknown[] = [];
	const client = {
		browsers: {
			computer: {
				batch: async (_id: string, body: { actions: unknown[] }) => {
					batches.push(body.actions);
				},
				readClipboard: async () => ({ text: "https://example.com/" }),
			},
		},
	} as unknown as Kernel;
	return { batches, client };
}

describe("InternalComputerTranslator", () => {
	it("holds modifiers instead of typing shortcut keys", async () => {
		const { batches, client } = createClient();
		const translator = new InternalComputerTranslator({ browser, client });

		await translator.executeBatch([
			{ type: "goto", url: "https://example.com" },
			{ type: "url" },
			{ type: "keypress", keys: ["ctrl", "shift", "Tab"] },
		]);

		expect(batches).toEqual([
			[
				{ type: "press_key", press_key: { keys: ["l"], hold_keys: ["Control_L"] } },
				{ type: "type_text", type_text: { text: "https://example.com" } },
				{ type: "press_key", press_key: { keys: ["Return"] } },
			],
			[
				{ type: "press_key", press_key: { keys: ["l"], hold_keys: ["Control_L"] } },
				{ type: "press_key", press_key: { keys: ["c"], hold_keys: ["Control_L"] } },
			],
			[
				{ type: "press_key", press_key: { keys: ["Tab"], hold_keys: ["Control_L", "Shift_L"] } },
			],
		]);
	});

	it("accepts shortcut strings from provider adapters", async () => {
		const { batches, client } = createClient();
		const translator = new InternalComputerTranslator({ browser, client });

		await translator.executeBatch([{ type: "keypress", keys: ["Ctrl+L"] }]);

		expect(batches).toEqual([
			[{ type: "press_key", press_key: { keys: ["l"], hold_keys: ["Control_L"] } }],
		]);
	});

	it("normalizes bare goto URLs before browser navigation", async () => {
		const { batches, client } = createClient();
		const translator = new InternalComputerTranslator({ browser, client });

		await translator.executeBatch([{ type: "goto", url: "example.com" }]);

		expect(batches).toEqual([
			[
				{ type: "press_key", press_key: { keys: ["l"], hold_keys: ["Control_L"] } },
				{ type: "type_text", type_text: { text: "https://example.com" } },
				{ type: "press_key", press_key: { keys: ["Return"] } },
			],
		]);
	});

	it("passes canonical modifier and key duration fields through to Kernel actions", async () => {
		const { batches, client } = createClient();
		const translator = new InternalComputerTranslator({ browser, client });

		await translator.executeBatch([
			{ type: "click", x: 10, y: 20, hold_keys: ["Control_L"] },
			{ type: "scroll", x: 10, y: 20, scroll_y: 120, hold_keys: ["Shift_L"] },
			{ type: "keypress", keys: ["Shift_L"], duration: 1500 },
		]);

		expect(batches).toEqual([
			[
				{ type: "click_mouse", click_mouse: { x: 10, y: 20, button: "left", hold_keys: ["Control_L"] } },
				{ type: "scroll", scroll: { x: 10, y: 20, delta_x: 0, delta_y: 120, hold_keys: ["Shift_L"] } },
				{ type: "press_key", press_key: { keys: ["Shift_L"], duration: 1500 } },
			],
		]);
	});

	it("stops a batch when a semantic browser wait does not satisfy", async () => {
		const { client } = createClient();
		const calls: CuaBrowserAction[] = [];
		const browserExecutor = {
			execute: async (action: CuaBrowserAction) => {
				calls.push(action);
				if (action.type !== "browser_wait_for") return [];
				return [{
					type: "browser_wait_for" as const,
					result: {
						status: "timed_out" as const,
						evidence: "failed" as const,
						initial: { truth: false, details: [] },
						final: { truth: false, details: [] },
						elapsed_ms: 10,
						details: [],
					},
				}];
			},
			close: () => {},
		} as unknown as BrowserExecutor;
		const translator = new InternalComputerTranslator({
			browser: { ...browser, cdp_ws_url: "ws://test" },
			client,
			createBrowserExecutor: () => browserExecutor,
		});

		const result = await translator.executeBatch([
			{ type: "browser_wait_for", expect: { type: "text", text: "Ready" } },
			{ type: "browser_click", x: 10, y: 20 },
		]);

		expect(calls.map((action) => action.type)).toEqual(["browser_wait_for"]);
		expect(result).toMatchObject({
			skippedActions: 1,
			readResults: [{ type: "browser_wait_for", result: { status: "timed_out" } }],
		});
	});

	it("denormalizes provider coordinates to the Kernel browser viewport", async () => {
		const { batches, client } = createClient();
		const translator = new InternalComputerTranslator({
			browser: { ...browser, viewport: { width: 1920, height: 1080 } },
			client,
		});

		await translator.executeBatch([
			{ type: "click", x: 500, y: 250 },
			{ type: "drag", path: [{ x: 0, y: 0 }, { x: 1000, y: 1000 }] },
		], { type: "normalized", range: [0, 1000] });

		expect(batches).toEqual([
			[
				{ type: "click_mouse", click_mouse: { x: 960, y: 270, button: "left" } },
				{ type: "drag_mouse", drag_mouse: { path: [[0, 0], [1919, 1079]], button: "left" } },
			],
		]);
	});
});
