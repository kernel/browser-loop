import type Kernel from "@onkernel/sdk";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { CuaBrowserAction } from "@onkernel/cua-ai";
import type { BrowserExecutor } from "../src/translator/browser";
import { InternalComputerTranslator, type KernelBrowser } from "../src/translator/translator";
import type { BatchReadResult } from "../src/translator/types";

const browser = { session_id: "browser_123", cdp_ws_url: "wss://example.test/cdp" } as KernelBrowser;

function createClient() {
	const batches: unknown[] = [];
	const client = {
		browsers: {
			computer: {
				batch: async (_id: string, body: { actions: unknown[] }) => {
					batches.push(body.actions);
				},
				captureScreenshot: async () => new Response(new Uint8Array(await sharp({ create: { width: 100, height: 80, channels: 3, background: "#fff" } }).png().toBuffer())),
				getMousePosition: async () => ({ x: 42, y: 24 }),
			},
		},
	} as unknown as Kernel;
	return { batches, client };
}

function createFakeDom() {
	const executed: CuaBrowserAction[] = [];
	const dom = {
		execute: async (action: CuaBrowserAction): Promise<BatchReadResult[]> => {
			executed.push(action);
			if (action.type === "browser_text") return [{ type: "browser_text", label: "text", text: "hello" }];
			return [];
		},
		screenshot: async () => ({ data: Buffer.from("png"), mimeType: "image/png" }),
	} as unknown as BrowserExecutor;
	return { executed, dom };
}

describe("InternalComputerTranslator DOM plane", () => {
	it("dispatches DOM actions to the DOM executor, flushing pending OS input first", async () => {
		const { batches, client } = createClient();
		const { executed, dom } = createFakeDom();
		const translator = new InternalComputerTranslator({ browser, client, createBrowserExecutor: () => dom });

		const result = await translator.executeBatch([
			{ type: "click", x: 1, y: 2 },
			{ type: "browser_text" },
			{ type: "browser_click", ref: "e3" },
		]);

		expect(batches).toHaveLength(1);
		expect(executed.map((action) => action.type)).toEqual(["browser_text", "browser_click"]);
		expect(result.readResults).toEqual([{ type: "browser_text", label: "text", text: "hello" }]);
	});

	it("errors on DOM actions when the browser has no cdp_ws_url", async () => {
		const { client } = createClient();
		const translator = new InternalComputerTranslator({ browser: { session_id: "b" } as KernelBrowser, client });
		await expect(translator.executeBatch([{ type: "browser_text" }])).rejects.toThrow(/cdp_ws_url/);
	});
});

describe("InternalComputerTranslator OS additions", () => {
	it("crops the OS screenshot for zoom, staying in the screenshot frame", async () => {
		const { client } = createClient();
		const translator = new InternalComputerTranslator({ browser, client });
		const result = await translator.executeBatch([{ type: "zoom", region: [10, 10, 60, 40] }]);
		const read = result.readResults[0]!;
		if (read.type !== "screenshot") throw new Error("expected screenshot read result");
		const metadata = await sharp(read.data).metadata();
		expect(metadata.width).toBe(50);
		expect(metadata.height).toBe(30);
	});

	it("passes num_clicks through and resolves missing click coordinates from the cursor", async () => {
		const { batches, client } = createClient();
		const translator = new InternalComputerTranslator({ browser, client });
		await translator.executeBatch([
			{ type: "click", x: 1, y: 2, num_clicks: 3 },
			{ type: "click" },
		]);
		expect(batches.flat()).toEqual([
			{ type: "click_mouse", click_mouse: { x: 1, y: 2, button: "left", num_clicks: 3 } },
			{ type: "click_mouse", click_mouse: { x: 42, y: 24, button: "left" } },
		]);
	});
});
