import type Kernel from "@onkernel/sdk";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { CuaBrowserAction } from "@onkernel/cua-ai";
import { BrowserExecutor } from "../src/translator/browser";
import type { CdpConnection } from "../src/translator/cdp";
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

interface FakeCdpEvent {
	method: string;
	params: Record<string, unknown>;
	sessionId?: string;
}

interface SentCommand {
	method: string;
	params: Record<string, unknown>;
	sessionId?: string;
}

function createFakeCdp(nodes: unknown[] = []) {
	const sent: SentCommand[] = [];
	const listeners: Array<(event: FakeCdpEvent) => void> = [];
	const fake = {
		onEvent: (listener: (event: FakeCdpEvent) => void) => {
			listeners.push(listener);
		},
		send: async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
			sent.push({ method, params, sessionId });
			switch (method) {
				case "Accessibility.getFullAXTree":
					return { nodes };
				case "DOM.getBoxModel":
					return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
				case "Runtime.evaluate":
					return { result: { value: "hello" } };
				default:
					return {};
			}
		},
		pageTargets: async () => [{ targetId: "TARGET-1", type: "page", title: "Page", url: "https://a.test/" }],
		attachToTarget: async () => "session-1",
		createTarget: async () => "TARGET-2",
		close: () => {},
	};
	const emit = (event: FakeCdpEvent) => {
		for (const listener of listeners) listener(event);
	};
	return { sent, emit, cdp: fake as unknown as CdpConnection };
}

interface AXNodeSpec {
	nodeId: string;
	role?: string;
	name?: string;
	backendDOMNodeId?: number;
	parentId?: string;
	childIds?: string[];
}

function ax(spec: AXNodeSpec) {
	return {
		nodeId: spec.nodeId,
		parentId: spec.parentId,
		childIds: spec.childIds,
		backendDOMNodeId: spec.backendDOMNodeId,
		role: spec.role !== undefined ? { value: spec.role } : undefined,
		name: spec.name !== undefined ? { value: spec.name } : undefined,
	};
}

function refsOf(executor: BrowserExecutor): Map<string, unknown> {
	return (executor as unknown as { refs: Map<string, unknown> }).refs;
}

async function snapshotText(executor: BrowserExecutor, action: Record<string, unknown> = {}): Promise<string> {
	const results = await executor.execute({ type: "browser_snapshot", ...action } as CuaBrowserAction);
	const read = results[0]!;
	if (read.type !== "browser_text") throw new Error("expected browser_text read result");
	return read.text;
}

const BUTTON_TREE = [
	ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
	ax({ nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 42, parentId: "1" }),
];

describe("BrowserExecutor ref lifecycle", () => {
	it("prunes stale refs when a navigation bumps the generation", async () => {
		const { cdp } = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);
		expect(refsOf(executor).size).toBe(1);
		await executor.execute({ type: "browser_navigate", url: "https://b.test" } as CuaBrowserAction);
		expect(refsOf(executor).size).toBe(0);
	});

	it("invalidates refs on main-frame frameNavigated but not on subframe navigation", async () => {
		const { cdp, emit, sent } = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(cdp);
		const text = await snapshotText(executor);
		expect(text).toContain('button "Save" [e1]');

		emit({ method: "Page.frameNavigated", params: { frame: { id: "F2", parentId: "F1" } }, sessionId: "session-1" });
		await executor.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction);
		expect(sent.some((cmd) => cmd.method === "Input.dispatchMouseEvent")).toBe(true);

		emit({ method: "Page.frameNavigated", params: { frame: { id: "F1" } }, sessionId: "session-1" });
		await expect(executor.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction)).rejects.toThrow(/stale/);
		expect(refsOf(executor).size).toBe(0);
	});

	it("does not double-bump the generation for its own navigate", async () => {
		const { cdp, emit } = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(cdp);
		await executor.execute({ type: "browser_navigate", url: "https://b.test" } as CuaBrowserAction);
		const text = await snapshotText(executor);
		expect(text).toContain('button "Save" [e1]');

		emit({ method: "Page.frameNavigated", params: { frame: { id: "F1" } }, sessionId: "session-1" });
		await expect(executor.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction)).resolves.toEqual([]);
	});
});

describe("BrowserExecutor snapshot rendering", () => {
	it("indents by rendered depth so skipped wrappers neither indent nor consume the depth budget", async () => {
		const tree = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "generic", parentId: "1", childIds: ["3"] }),
			ax({ nodeId: "3", role: "generic", parentId: "2", childIds: ["4"] }),
			ax({ nodeId: "4", role: "button", name: "Save", backendDOMNodeId: 42, parentId: "3" }),
		];
		const { cdp } = createFakeCdp(tree);
		const executor = new BrowserExecutor(cdp);
		expect(await snapshotText(executor)).toBe('RootWebArea "Page"\n  button "Save" [e1]');
		expect(await snapshotText(executor, { depth: 1 })).toBe('RootWebArea "Page"\n  button "Save" [e2]');
	});

	it("treats treeitem as interactive and the bogus textarea role as non-interactive", async () => {
		const tree = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
			ax({ nodeId: "2", role: "treeitem", name: "Reports", backendDOMNodeId: 10, parentId: "1" }),
			ax({ nodeId: "3", role: "textarea", name: "Notes", backendDOMNodeId: 11, parentId: "1" }),
		];
		const { cdp } = createFakeCdp(tree);
		const executor = new BrowserExecutor(cdp);
		const text = await snapshotText(executor);
		expect(text).toContain('treeitem "Reports" [e1]');
		expect(text).toContain('textarea "Notes"');
		expect(text).not.toContain('textarea "Notes" [');
	});
});

describe("BrowserExecutor dialog guard", () => {
	it("auto-dismisses JavaScript dialogs and surfaces the message on the next action", async () => {
		const { cdp, emit, sent } = createFakeCdp();
		const executor = new BrowserExecutor(cdp);
		await executor.execute({ type: "browser_text" } as CuaBrowserAction);

		emit({ method: "Page.javascriptDialogOpening", params: { type: "confirm", message: "Leave page?" }, sessionId: "session-1" });
		const handled = sent.find((cmd) => cmd.method === "Page.handleJavaScriptDialog");
		expect(handled).toEqual({ method: "Page.handleJavaScriptDialog", params: { accept: false }, sessionId: "session-1" });

		const results = await executor.execute({ type: "browser_text" } as CuaBrowserAction);
		expect(results).toEqual([
			{ type: "browser_text", label: "text", text: "hello" },
			{ type: "browser_text", label: "dialog", text: 'Auto-dismissed a JavaScript confirm dialog: "Leave page?"' },
		]);
	});
});
