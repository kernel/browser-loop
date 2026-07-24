import type Kernel from "@onkernel/sdk";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { CuaBrowserAction } from "@onkernel/cua-ai";
import { BrowserExecutor } from "../src/translator/browser";
import type { BrowserRefState } from "../src/translator/browser-ref-lifecycle";
import { CdpProtocolError, type CdpConnection } from "../src/translator/cdp";
import { buildCuaComputerTools } from "../src/tools";
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

function createFakeBrowserExecutor() {
	const executed: CuaBrowserAction[] = [];
	const executor = {
		execute: async (action: CuaBrowserAction): Promise<BatchReadResult[]> => {
			executed.push(action);
			if (action.type === "browser_text") return [{ type: "browser_text", label: "text", text: "hello" }];
			return [];
		},
		screenshot: async () => ({ data: Buffer.from("png"), mimeType: "image/png" }),
	} as unknown as BrowserExecutor;
	return { executed, executor };
}

describe("InternalComputerTranslator browser plane", () => {
	it("dispatches browser actions to the browser executor, flushing pending OS input first", async () => {
		const { batches, client } = createClient();
		const { executed, executor } = createFakeBrowserExecutor();
		const translator = new InternalComputerTranslator({ browser, client, createBrowserExecutor: () => executor });

		const result = await translator.executeBatch([
			{ type: "click", x: 1, y: 2 },
			{ type: "browser_text" },
			{ type: "browser_click", ref: "e3" },
		]);

		expect(batches).toHaveLength(1);
		expect(executed.map((action) => action.type)).toEqual(["browser_text", "browser_click"]);
		expect(result.readResults).toEqual([{ type: "browser_text", label: "text", text: "hello" }]);
	});

	it("errors on browser actions when the browser has no cdp_ws_url", async () => {
		const { client } = createClient();
		const translator = new InternalComputerTranslator({ browser: { session_id: "b" } as KernelBrowser, client });
		await expect(translator.executeBatch([{ type: "browser_text" }])).rejects.toThrow(/cdp_ws_url/);
	});
});

describe("InternalComputerTranslator computer additions", () => {
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

function createFakeCdp(initialNodes: unknown[] = []) {
	const sent: SentCommand[] = [];
	const listeners: Array<(event: FakeCdpEvent) => void> = [];
	let nodes = initialNodes as Array<{ backendDOMNodeId?: number }>;
	let cursorBackendIds: number[] = [];
	let loaderId: string | undefined = "L0";
	const sessionTrees = new Map<string, Array<{ backendDOMNodeId?: number }>>();
	const frameTrees = new Map<string, Array<{ backendDOMNodeId?: number }>>();
	const iframeFrameIds = new Map<number, string>();
	const boxModels = new Map<number, number[]>();
	const frameLoaderIds = new Map<string, string>();
	const oopifFrameKeys = new Set<string>();
	const oopifSessionFrames = new Map<string, string>();
	const autoAttachFrames: Array<{ targetId: string; sessionId: string; delayMs?: number }> = [];
	// A same-process child frame's document loaderId defaults to a stable value so
	// it verifies unchanged across processes; setFrameLoaderId overrides it.
	const loaderFor = (frameKey: string) => frameLoaderIds.get(frameKey) ?? (frameKey === "TARGET-1" ? loaderId : "L0");
	const sameProcessChildFrames = () => {
		const ids = new Set<string>();
		for (const frameId of iframeFrameIds.values()) if (!oopifFrameKeys.has(frameId)) ids.add(frameId);
		return [...ids];
	};
	const methodFailures = new Map<string, Error>();
	let failureProvider: ((method: string, params: Record<string, unknown>, sessionId?: string) => Error | undefined) | undefined;
	let axRead = 0;
	let targetRead = 0;
	let onAxRead: ((read: number, params: Record<string, unknown>, sessionId?: string) => void) | undefined;
	let targetProvider: ((read: number) => Array<{ targetId: string; type: string; title: string; url: string }>) | undefined;
	const emit = (event: FakeCdpEvent) => {
		for (const listener of listeners) listener(event);
	};
	const treeFor = (sessionId?: string, frameId?: unknown) => {
		if (typeof frameId === "string" && frameTrees.has(frameId)) return frameTrees.get(frameId)!;
		if (sessionId && sessionTrees.has(sessionId)) return sessionTrees.get(sessionId)!;
		return nodes;
	};
	const requireBackendId = (id: unknown, sessionId?: string) => {
		const candidates = sessionId && sessionTrees.has(sessionId) ? [sessionTrees.get(sessionId)!] : [nodes, ...frameTrees.values()];
		if (!candidates.some((tree) => tree.some((node) => node.backendDOMNodeId === id))) throw new Error("No node with given id found");
	};
	const fake = {
		onEvent: (listener: (event: FakeCdpEvent) => void) => {
			listeners.push(listener);
		},
		send: async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
			sent.push({ method, params, sessionId });
			const failure = methodFailures.get(method) ?? failureProvider?.(method, params, sessionId);
			if (failure) throw failure;
			switch (method) {
				case "Accessibility.getFullAXTree": {
					const tree = treeFor(sessionId, params.frameId);
					onAxRead?.(++axRead, params, sessionId);
					return { nodes: tree };
				}
				case "Target.setAutoAttach":
					for (const frame of autoAttachFrames.splice(0)) {
						const attach = () =>
							emit({
								method: "Target.attachedToTarget",
								params: { sessionId: frame.sessionId, targetInfo: { targetId: frame.targetId, type: "iframe" } },
								sessionId,
							});
						// A delayed attach models an OOPIF whose session surfaces only after
						// setAutoAttach returns, exercising the reconcile's bounded wait.
						if (frame.delayMs) setTimeout(attach, frame.delayMs);
						else attach();
					}
					return {};
				case "DOM.scrollIntoViewIfNeeded":
					requireBackendId(params.backendNodeId, sessionId);
					return {};
				case "DOM.getBoxModel":
					requireBackendId(params.backendNodeId, sessionId);
					return { model: { content: boxModels.get(params.backendNodeId as number) ?? [0, 0, 10, 0, 10, 10, 0, 10] } };
				case "DOM.getFrameOwner": {
					for (const [backendNodeId, frameId] of iframeFrameIds) {
						if (frameId === params.frameId) return { backendNodeId };
					}
					throw new Error("Frame with the given id was not found.");
				}
				case "Page.getFrameTree": {
					// An OOPIF's own session reports itself as the root frame with its own loaderId.
					const oopifFrame = sessionId ? oopifSessionFrames.get(sessionId) : undefined;
					if (oopifFrame) {
						const oopifLoader = loaderFor(oopifFrame);
						return { frameTree: { frame: { id: oopifFrame, ...(oopifLoader !== undefined ? { loaderId: oopifLoader } : {}) } } };
					}
					// The page session reports the main frame plus its same-process children.
					const childFrames = sameProcessChildFrames().map((id) => {
						const childLoader = loaderFor(id);
						return { frame: { id, ...(childLoader !== undefined ? { loaderId: childLoader } : {}) } };
					});
					return {
						frameTree: {
							frame: { id: "TARGET-1", ...(loaderId !== undefined ? { loaderId } : {}) },
							...(childFrames.length ? { childFrames } : {}),
						},
					};
				}
				case "DOM.resolveNode":
					requireBackendId(params.backendNodeId, sessionId);
					return { object: { objectId: "node-obj" } };
				case "Runtime.evaluate":
					if (params.returnByValue === false) return { result: { objectId: "cursor-scan" } };
					return { result: { value: "hello" } };
				case "Runtime.getProperties":
					return {
						result: [
							...cursorBackendIds.map((id, index) => ({ name: String(index), value: { objectId: `el-${id}` } })),
							{ name: "length", value: {} },
						],
					};
				case "DOM.describeNode":
					if (typeof params.backendNodeId === "number") {
						return { node: { backendNodeId: params.backendNodeId, frameId: iframeFrameIds.get(params.backendNodeId) } };
					}
					return { node: { backendNodeId: Number(String(params.objectId).slice(3)) } };
				default:
					return {};
			}
		},
		pageTargets: async () =>
			targetProvider?.(++targetRead) ?? [{ targetId: "TARGET-1", type: "page", title: "Page", url: "https://a.test/" }],
		attachToTarget: async () => "session-1",
		createTarget: async () => "TARGET-2",
		close: () => {},
	};
	const setNodes = (next: unknown[]) => {
		nodes = next as Array<{ backendDOMNodeId?: number }>;
	};
	const setCursorBackendIds = (ids: number[]) => {
		cursorBackendIds = ids;
	};
	const setSessionTree = (sessionId: string, tree: unknown[]) => {
		sessionTrees.set(sessionId, tree as Array<{ backendDOMNodeId?: number }>);
	};
	const setFrameTree = (frameId: string, tree: unknown[]) => {
		frameTrees.set(frameId, tree as Array<{ backendDOMNodeId?: number }>);
	};
	const setIframeFrame = (backendNodeId: number, frameId: string) => {
		iframeFrameIds.set(backendNodeId, frameId);
	};
	const setBoxModel = (backendNodeId: number, content: number[]) => {
		boxModels.set(backendNodeId, content);
	};
	const setLoaderId = (id: string | undefined) => {
		loaderId = id;
	};
	const setFrameLoaderId = (frameKey: string, id: string) => {
		frameLoaderIds.set(frameKey, id);
	};
	const addAutoAttachFrame = (frame: { targetId: string; sessionId: string; delayMs?: number }) => {
		// Registering an OOPIF: its session is authoritative for its own document,
		// and it is excluded from the page session's same-process child frames.
		oopifFrameKeys.add(frame.targetId);
		oopifSessionFrames.set(frame.sessionId, frame.targetId);
		autoAttachFrames.push(frame);
	};
	const failOn = (method: string, error = new Error(`${method} rejected`)) => {
		methodFailures.set(method, error);
	};
	const setFailureProvider = (provider: typeof failureProvider) => {
		failureProvider = provider;
	};
	const setAxReadHook = (hook: typeof onAxRead) => {
		onAxRead = hook;
	};
	const setTargetProvider = (provider: typeof targetProvider) => {
		targetProvider = provider;
	};
	return {
		sent,
		emit,
		setNodes,
		setCursorBackendIds,
		setSessionTree,
		setFrameTree,
		setIframeFrame,
		setBoxModel,
		setLoaderId,
		setFrameLoaderId,
		addAutoAttachFrame,
		failOn,
		setFailureProvider,
		setAxReadHook,
		setTargetProvider,
		cdp: fake as unknown as CdpConnection,
	};
}

interface AXNodeSpec {
	nodeId: string;
	role?: string;
	name?: string;
	value?: unknown;
	properties?: Array<{ name: string; value?: unknown }>;
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
		value: spec.value !== undefined ? { value: spec.value } : undefined,
		properties: spec.properties?.map((property) => ({ name: property.name, value: { value: property.value } })),
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

function refFor(text: string, label: string): string {
	const match = new RegExp(`"${label}" \\[(e\\d+)\\]`).exec(text);
	if (!match) throw new Error(`no ref for ${label} in:\n${text}`);
	return match[1]!;
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

	it("does not let a rejected navigate suppress the next real navigation's invalidation", async () => {
		const { cdp, emit, failOn } = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);
		expect(refsOf(executor).size).toBe(1);

		failOn("Page.navigate");
		await expect(executor.execute({ type: "browser_navigate", url: "https://b.test" } as CuaBrowserAction)).rejects.toThrow(/rejected/);

		// A page-initiated navigation right after the failed command must still invalidate.
		emit({ method: "Page.frameNavigated", params: { frame: { id: "F0" } }, sessionId: "session-1" });
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

	it("does not let a same-document navigation suppress the next real navigation's invalidation", async () => {
		const { cdp, emit } = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(cdp);
		await executor.execute({ type: "browser_navigate", url: "https://a.test/#section" } as CuaBrowserAction);
		emit({ method: "Page.navigatedWithinDocument", params: { frameId: "TARGET-1", url: "https://a.test/#section" }, sessionId: "session-1" });
		await snapshotText(executor);

		emit({ method: "Page.frameNavigated", params: { frame: { id: "TARGET-1" } }, sessionId: "session-1" });
		await expect(executor.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction)).rejects.toThrow(/stale/);
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

	it("renders node states in a compact bracket after the ref", async () => {
		const tree = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3", "4", "5"] }),
			ax({
				nodeId: "2",
				role: "checkbox",
				name: "Terms",
				backendDOMNodeId: 10,
				parentId: "1",
				properties: [{ name: "checked", value: "true" }, { name: "required", value: true }],
			}),
			ax({ nodeId: "3", role: "checkbox", name: "Maybe", backendDOMNodeId: 11, parentId: "1", properties: [{ name: "checked", value: "mixed" }] }),
			ax({
				nodeId: "4",
				role: "button",
				name: "Save",
				backendDOMNodeId: 12,
				parentId: "1",
				properties: [{ name: "disabled", value: true }, { name: "expanded", value: false }],
			}),
			ax({ nodeId: "5", role: "textbox", name: "Email", backendDOMNodeId: 13, parentId: "1", value: "a@b.c" }),
		];
		const { cdp } = createFakeCdp(tree);
		const executor = new BrowserExecutor(cdp);
		const text = await snapshotText(executor);
		expect(text).toContain('checkbox "Terms" [e1] [checked, required]');
		expect(text).toContain('checkbox "Maybe" [e2] [checked=mixed]');
		expect(text).toContain('button "Save" [e3] [disabled, expanded=false]');
		expect(text).toContain('textbox "Email" [e4] [value="a@b.c"]');
	});

	it("renders false checked state, expanded, pressed, selected, and heading level", async () => {
		const tree = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3", "4", "5"] }),
			ax({ nodeId: "2", role: "radio", name: "Solo", backendDOMNodeId: 10, parentId: "1", properties: [{ name: "checked", value: "false" }] }),
			ax({ nodeId: "3", role: "button", name: "Bold", backendDOMNodeId: 11, parentId: "1", properties: [{ name: "pressed", value: "true" }] }),
			ax({
				nodeId: "4",
				role: "tab",
				name: "Overview",
				backendDOMNodeId: 12,
				parentId: "1",
				properties: [{ name: "selected", value: true }, { name: "expanded", value: true }],
			}),
			ax({ nodeId: "5", role: "heading", name: "Pricing", backendDOMNodeId: 13, parentId: "1", properties: [{ name: "level", value: 2 }] }),
		];
		const { cdp } = createFakeCdp(tree);
		const executor = new BrowserExecutor(cdp);
		const text = await snapshotText(executor);
		expect(text).toContain('radio "Solo" [e1] [checked=false]');
		expect(text).toContain('button "Bold" [e2] [pressed]');
		expect(text).toContain('tab "Overview" [e3] [selected, expanded]');
		expect(text).toContain('heading "Pricing" [e4] [level=2]');
	});

	it("merges consecutive StaticText siblings into one line", async () => {
		const tree = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3", "4"] }),
			ax({ nodeId: "2", role: "StaticText", name: "Fast", parentId: "1" }),
			ax({ nodeId: "3", role: "StaticText", name: "browsers", parentId: "1" }),
			ax({ nodeId: "4", role: "button", name: "Go", backendDOMNodeId: 42, parentId: "1" }),
		];
		const { cdp } = createFakeCdp(tree);
		const executor = new BrowserExecutor(cdp);
		expect(await snapshotText(executor)).toBe('RootWebArea "Page"\n  StaticText "Fast browsers"\n  button "Go" [e1]');
	});

	it("scopes a snapshot to a named content role's ref", async () => {
		const tree = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "4"] }),
			ax({ nodeId: "2", role: "navigation", name: "Menu", backendDOMNodeId: 30, parentId: "1", childIds: ["3"] }),
			ax({ nodeId: "3", role: "link", name: "Home", backendDOMNodeId: 31, parentId: "2" }),
			ax({ nodeId: "4", role: "button", name: "Save", backendDOMNodeId: 32, parentId: "1" }),
		];
		const { cdp } = createFakeCdp(tree);
		const executor = new BrowserExecutor(cdp);
		const full = await snapshotText(executor);
		expect(full).toContain('navigation "Menu" [e1]');
		const scoped = await snapshotText(executor, { ref: "e1" });
		expect(scoped).toContain('navigation "Menu"');
		expect(scoped).toContain('link "Home"');
		expect(scoped).not.toContain('button "Save"');
	});

	it("skips StaticText duplicating the parent name and collapses wrappers without losing text", async () => {
		const tree = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "4", "7"] }),
			ax({ nodeId: "2", role: "heading", name: "Title", parentId: "1", childIds: ["3"] }),
			ax({ nodeId: "3", role: "StaticText", name: "Title", parentId: "2" }),
			ax({ nodeId: "4", role: "link", name: "Docs", backendDOMNodeId: 20, parentId: "1", childIds: ["5"] }),
			ax({ nodeId: "5", role: "generic", parentId: "4", childIds: ["6"] }),
			ax({ nodeId: "6", role: "StaticText", name: "Docs", parentId: "5" }),
			ax({ nodeId: "7", role: "StaticText", name: "Standalone", parentId: "1" }),
		];
		const { cdp } = createFakeCdp(tree);
		const executor = new BrowserExecutor(cdp);
		const text = await snapshotText(executor);
		expect(text).toBe(['RootWebArea "Page"', '  heading "Title"', '  link "Docs" [e1]', '  StaticText "Standalone"'].join("\n"));
		expect(text.split("\n")).toHaveLength(4);
	});
});

describe("BrowserExecutor stale-ref self-healing", () => {
	it("heals a ref whose backend node moved when exactly one node matches the role/name triple", async () => {
		const { cdp, sent, setNodes } = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);
		setNodes([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 99, parentId: "1" }),
		]);
		await executor.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction);
		expect(sent.some((cmd) => cmd.method === "DOM.scrollIntoViewIfNeeded" && cmd.params.backendNodeId === 99)).toBe(true);
		expect(sent.some((cmd) => cmd.method === "Input.dispatchMouseEvent")).toBe(true);
	});

	it("heals a duplicate ref by position when the cohort size is unchanged", async () => {
		const { cdp, sent, setNodes } = createFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
			ax({ nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 42, parentId: "1" }),
			ax({ nodeId: "3", role: "button", name: "Save", backendDOMNodeId: 43, parentId: "1" }),
		]);
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);
		setNodes([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
			ax({ nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 99, parentId: "1" }),
			ax({ nodeId: "3", role: "button", name: "Save", backendDOMNodeId: 100, parentId: "1" }),
		]);
		await executor.execute({ type: "browser_click", ref: "e2" } as CuaBrowserAction);
		expect(sent.some((cmd) => cmd.method === "DOM.scrollIntoViewIfNeeded" && cmd.params.backendNodeId === 100)).toBe(true);
	});

	it("heals a stale ref on browser_fill and retries the resolve", async () => {
		const { cdp, sent, setNodes } = createFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "textbox", name: "Email", backendDOMNodeId: 42, parentId: "1" }),
		]);
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);
		setNodes([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "textbox", name: "Email", backendDOMNodeId: 99, parentId: "1" }),
		]);
		await executor.execute({ type: "browser_fill", ref: "e1", value: "a@b.c" } as CuaBrowserAction);
		expect(sent.some((cmd) => cmd.method === "DOM.resolveNode" && cmd.params.backendNodeId === 99)).toBe(true);
		expect(sent.some((cmd) => cmd.method === "Runtime.callFunctionOn")).toBe(true);
	});

	it("refuses to heal when multiple nodes match the stored role and name", async () => {
		const { cdp, setNodes } = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);
		setNodes([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
			ax({ nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 99, parentId: "1" }),
			ax({ nodeId: "3", role: "button", name: "Save", backendDOMNodeId: 100, parentId: "1" }),
		]);
		await expect(executor.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction)).rejects.toThrow(/stale/);
	});

	it("refuses to heal a duplicate ref when the cohort shrank", async () => {
		const { cdp, setNodes } = createFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
			ax({ nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 42, parentId: "1" }),
			ax({ nodeId: "3", role: "button", name: "Save", backendDOMNodeId: 43, parentId: "1" }),
		]);
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);
		setNodes([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 99, parentId: "1" }),
		]);
		await expect(executor.execute({ type: "browser_click", ref: "e2" } as CuaBrowserAction)).rejects.toThrow(/stale/);
	});
});

describe("BrowserExecutor fill", () => {
	const FILL_TREE = [
		ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
		ax({ nodeId: "2", role: "textbox", name: "Email", backendDOMNodeId: 42, parentId: "1" }),
	];

	it("focuses the element it fills before dispatching input events", async () => {
		const { cdp, sent } = createFakeCdp(FILL_TREE);
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);
		await executor.execute({ type: "browser_fill", ref: "e1", value: "a@b.c" } as CuaBrowserAction);
		const call = sent.find((cmd) => cmd.method === "Runtime.callFunctionOn");
		const declaration = call?.params.functionDeclaration as string;
		const fillFn = new Function(`return (${declaration})`)() as (value: unknown) => void;
		const events: string[] = [];
		const el = {
			tagName: "INPUT",
			type: "text",
			value: "",
			isContentEditable: false,
			focus: () => events.push("focus"),
			dispatchEvent: (event: Event) => events.push(event.type),
		};
		fillFn.call(el, "hello");
		expect(el.value).toBe("hello");
		expect(events).toEqual(["focus", "input", "change"]);
	});

	it.each([
		["Error: element is not a form control"],
		["TypeError: element is not a form control"],
	])("trims fill exception %j to a single line without the prefix or stack", async (firstLine) => {
		const { cdp } = createFakeCdp(FILL_TREE);
		const inner = cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		const wrapped = {
			...cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				if (method === "Runtime.callFunctionOn") {
					return {
						exceptionDetails: {
							exception: { description: `${firstLine}\n    at HTMLAnchorElement.<anonymous> (<anonymous>:20:9)` },
						},
					};
				}
				return inner.send(method, params, sessionId);
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);
		await expect(executor.execute({ type: "browser_fill", ref: "e1", value: "x" } as CuaBrowserAction)).rejects.toThrow(
			/^browser_fill failed: element is not a form control$/,
		);
	});
});

describe("BrowserExecutor cursor-pointer hints", () => {
	const POINTER_TREE = [
		ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
		ax({ nodeId: "2", role: "generic", name: "Buy now", backendDOMNodeId: 77, parentId: "1" }),
	];

	it("marks cursor:pointer elements as clickable hints in every snapshot", async () => {
		const { cdp, sent, setCursorBackendIds } = createFakeCdp(POINTER_TREE);
		setCursorBackendIds([77]);
		const executor = new BrowserExecutor(cdp);
		const text = await snapshotText(executor);
		expect(text).toContain('generic "Buy now" [e1] [cursor:pointer]');
		expect(sent.some((cmd) => cmd.method === "DOM.describeNode")).toBe(true);
		expect(sent.some((cmd) => cmd.method === "Runtime.releaseObjectGroup")).toBe(true);
	});

	it("does not scan cursor metadata for find", async () => {
		const { cdp, failOn, sent } = createFakeCdp(BUTTON_TREE);
		failOn("Runtime.evaluate");
		const executor = new BrowserExecutor(cdp);
		const results = await executor.execute({ type: "browser_find", query: "save button" } as CuaBrowserAction);
		expect((results[0] as { text: string }).text).toContain('button "Save" [e1]');
		expect(sent.some((command) => command.method === "Runtime.evaluate")).toBe(false);
	});
});

describe("BrowserExecutor dialog guard", () => {
	it("dismisses confirm/prompt dialogs and surfaces the message on the next action", async () => {
		const { cdp, emit, sent } = createFakeCdp();
		const executor = new BrowserExecutor(cdp);
		await executor.execute({ type: "browser_text" } as CuaBrowserAction);

		emit({ method: "Page.javascriptDialogOpening", params: { type: "confirm", message: "Delete item?" }, sessionId: "session-1" });
		const handled = sent.find((cmd) => cmd.method === "Page.handleJavaScriptDialog");
		expect(handled).toEqual({ method: "Page.handleJavaScriptDialog", params: { accept: false }, sessionId: "session-1" });

		const results = await executor.execute({ type: "browser_text" } as CuaBrowserAction);
		expect(results).toEqual([
			{ type: "browser_text", label: "text", text: "hello" },
			{ type: "browser_text", label: "dialog", text: 'Dismissed a JavaScript confirm dialog (answered No/cancel): "Delete item?"' },
		]);
	});

	it("accepts alert and beforeunload dialogs so navigation can proceed", async () => {
		const { cdp, emit, sent } = createFakeCdp();
		const executor = new BrowserExecutor(cdp);
		await executor.execute({ type: "browser_text" } as CuaBrowserAction);

		emit({ method: "Page.javascriptDialogOpening", params: { type: "beforeunload", message: "" }, sessionId: "session-1" });
		emit({ method: "Page.javascriptDialogOpening", params: { type: "alert", message: "Saved!" }, sessionId: "session-1" });
		const handled = sent.filter((cmd) => cmd.method === "Page.handleJavaScriptDialog");
		expect(handled.map((cmd) => cmd.params)).toEqual([{ accept: true }, { accept: true }]);

		const results = await executor.execute({ type: "browser_text" } as CuaBrowserAction);
		expect(results[1]).toEqual({
			type: "browser_text",
			label: "dialog",
			text: 'Accepted a beforeunload dialog so navigation could proceed: ""\nAcknowledged a JavaScript alert dialog: "Saved!"',
		});
	});
});

describe("BrowserExecutor snapshot diffing", () => {
	const UNCHANGED = "Page unchanged since the last snapshot; previous element refs are still valid.";

	it("returns a short unchanged notice for an identical re-snapshot and the full tree after a change", async () => {
		const { cdp, setNodes } = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(cdp);
		expect(await snapshotText(executor)).toContain('button "Save" [e1]');
		expect(await snapshotText(executor)).toBe(UNCHANGED);
		await executor.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction);
		setNodes([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "button", name: "Delete", backendDOMNodeId: 43, parentId: "1" }),
		]);
		expect(await snapshotText(executor)).toContain('button "Delete" [e2]');
	});

	it("returns the full tree when the params differ from the previous snapshot", async () => {
		const { cdp } = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);
		expect(await snapshotText(executor, { filter: "interactive" })).toContain('button "Save" [e2]');
	});
});

describe("BrowserExecutor iframe stitching", () => {
	it("stitches a same-process iframe subtree indented under its iframe node", async () => {
		const tree = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		];
		const { cdp, emit, setFrameTree, setIframeFrame } = createFakeCdp(tree);
		setIframeFrame(50, "FRAME-SP");
		setFrameTree("FRAME-SP", [
			ax({ nodeId: "f1", role: "RootWebArea", name: "Embed", childIds: ["f2"] }),
			ax({ nodeId: "f2", role: "button", name: "Inside", backendDOMNodeId: 60, parentId: "f1" }),
		]);
		const executor = new BrowserExecutor(cdp);
		const text = await snapshotText(executor);
		expect(text).toBe(['RootWebArea "Page"', "  Iframe [e1]", '    RootWebArea "Embed"', '      button "Inside" [e2]'].join("\n"));
		await executor.execute({ type: "browser_click", ref: "e2" } as CuaBrowserAction);

		emit({ method: "Page.frameNavigated", params: { frame: { id: "FRAME-SP", parentId: "F0" } }, sessionId: "session-1" });
		await expect(executor.execute({ type: "browser_click", ref: "e2" } as CuaBrowserAction)).rejects.toThrow(/stale/);
	});

	const OOPIF_PAGE = [
		ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
		ax({ nodeId: "2", role: "button", name: "Top", backendDOMNodeId: 40, parentId: "1" }),
		ax({ nodeId: "3", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
	];
	const OOPIF_CHILD = [
		ax({ nodeId: "f1", role: "RootWebArea", name: "Widget", childIds: ["f2"] }),
		ax({ nodeId: "f2", role: "button", name: "Pay", backendDOMNodeId: 70, parentId: "f1" }),
	];
	const setupOopif = () => {
		const fake = createFakeCdp(OOPIF_PAGE);
		fake.setIframeFrame(50, "FRAME-OOP");
		fake.addAutoAttachFrame({ targetId: "FRAME-OOP", sessionId: "session-oop" });
		fake.setSessionTree("session-oop", OOPIF_CHILD);
		return fake;
	};

	it("resolves an OOPIF ref's node through the child session but dispatches input on the page session", async () => {
		const { cdp, sent } = setupOopif();
		const executor = new BrowserExecutor(cdp);
		const text = await snapshotText(executor);
		expect(text).toContain('button "Top" [e1]');
		expect(text).toContain('      button "Pay" [e3]');

		await executor.execute({ type: "browser_click", ref: "e3" } as CuaBrowserAction);
		const scrolled = sent.find((cmd) => cmd.method === "DOM.scrollIntoViewIfNeeded" && cmd.params.backendNodeId === 70);
		expect(scrolled?.sessionId).toBe("session-oop");
		const pressed = sent.find((cmd) => cmd.method === "Input.dispatchMouseEvent" && cmd.params.type === "mousePressed");
		expect(pressed?.sessionId).toBe("session-1");
	});

	it("shifts an OOPIF ref click by the frame owner's offset so it lands on the intended element", async () => {
		const fake = setupOopif();
		// The iframe (owner backend node 50) sits at (100, 200) in the page; the
		// child's own renderer reports the Pay button centered at frame-local (5, 5).
		fake.setBoxModel(50, [100, 200, 110, 200, 110, 210, 100, 210]);
		const executor = new BrowserExecutor(fake.cdp);
		const text = await snapshotText(executor);
		expect(text).toContain('      button "Pay" [e3]');

		await executor.execute({ type: "browser_click", ref: "e3" } as CuaBrowserAction);
		const owner = fake.sent.find((cmd) => cmd.method === "DOM.getFrameOwner" && cmd.params.frameId === "FRAME-OOP");
		expect(owner?.sessionId).toBe("session-1");
		const pressed = fake.sent.find((cmd) => cmd.method === "Input.dispatchMouseEvent" && cmd.params.type === "mousePressed");
		expect(pressed?.sessionId).toBe("session-1");
		expect([pressed?.params.x, pressed?.params.y]).toEqual([105, 205]);
	});

	it("shifts an OOPIF ref hover by the frame owner's offset", async () => {
		const fake = setupOopif();
		fake.setBoxModel(50, [100, 200, 110, 200, 110, 210, 100, 210]);
		const executor = new BrowserExecutor(fake.cdp);
		await snapshotText(executor);

		await executor.execute({ type: "browser_hover", ref: "e3" } as CuaBrowserAction);
		const moved = fake.sent.find((cmd) => cmd.method === "Input.dispatchMouseEvent" && cmd.params.type === "mouseMoved");
		expect(moved?.sessionId).toBe("session-1");
		expect([moved?.params.x, moved?.params.y]).toEqual([105, 205]);
	});

	it("does not offset a main-frame ref click even when an OOPIF owner has an offset", async () => {
		const fake = setupOopif();
		fake.setBoxModel(50, [100, 200, 110, 200, 110, 210, 100, 210]);
		const executor = new BrowserExecutor(fake.cdp);
		await snapshotText(executor);

		// e1 is the top-level "Top" button (backend node 40): read through the page
		// session, so its quads are already top-level and must not be shifted.
		await executor.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction);
		expect(fake.sent.some((cmd) => cmd.method === "DOM.getFrameOwner")).toBe(false);
		const pressed = fake.sent.find((cmd) => cmd.method === "Input.dispatchMouseEvent" && cmd.params.type === "mousePressed");
		expect([pressed?.params.x, pressed?.params.y]).toEqual([5, 5]);
	});

	it("does not offset a same-process iframe ref click", async () => {
		const tree = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		];
		const fake = createFakeCdp(tree);
		fake.setIframeFrame(50, "FRAME-SP");
		fake.setFrameTree("FRAME-SP", [
			ax({ nodeId: "f1", role: "RootWebArea", name: "Embed", childIds: ["f2"] }),
			ax({ nodeId: "f2", role: "button", name: "Inside", backendDOMNodeId: 60, parentId: "f1" }),
		]);
		// Even if the iframe element has an offset, a same-process frame is read
		// through the page session and its quads are already top-level.
		fake.setBoxModel(50, [100, 200, 110, 200, 110, 210, 100, 210]);
		const executor = new BrowserExecutor(fake.cdp);
		await snapshotText(executor);

		await executor.execute({ type: "browser_click", ref: "e2" } as CuaBrowserAction);
		expect(fake.sent.some((cmd) => cmd.method === "DOM.getFrameOwner")).toBe(false);
		const pressed = fake.sent.find((cmd) => cmd.method === "Input.dispatchMouseEvent" && cmd.params.type === "mousePressed");
		expect([pressed?.params.x, pressed?.params.y]).toEqual([5, 5]);
	});

	it("invalidates a frame target's refs when a subframe inside it navigates", async () => {
		const { cdp, emit } = setupOopif();
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);

		emit({ method: "Page.frameNavigated", params: { frame: { id: "FRAME-INNER", parentId: "FRAME-OOP" } }, sessionId: "session-oop" });
		await expect(executor.execute({ type: "browser_click", ref: "e3" } as CuaBrowserAction)).rejects.toThrow(/stale/);
	});

	it("finds elements inside stitched iframes", async () => {
		const { cdp, sent } = setupOopif();
		const executor = new BrowserExecutor(cdp);

		const results = await executor.execute({ type: "browser_find", query: "pay button" } as CuaBrowserAction);
		const text = (results[0] as { text: string }).text;
		expect(text).toContain('button "Pay" [e');

		const ref = /\[(e\d+)\]/.exec(text)![1]!;
		await executor.execute({ type: "browser_click", ref } as CuaBrowserAction);
		const resolved = sent.find((cmd) => cmd.method === "DOM.getBoxModel" && cmd.params.backendNodeId === 70);
		expect(resolved?.sessionId).toBe("session-oop");
	});

	it("invalidates only the child frame's refs when the child frame navigates", async () => {
		const { cdp, emit } = setupOopif();
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);

		emit({ method: "Page.frameNavigated", params: { frame: { id: "FRAME-OOP" } }, sessionId: "session-oop" });
		await expect(executor.execute({ type: "browser_click", ref: "e3" } as CuaBrowserAction)).rejects.toThrow(/stale/);
		await executor.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction);

		const text = await snapshotText(executor);
		expect(text).toContain('button "Pay" [e');
	});

	it("invalidates and releases a same-process frame when it detaches and rotates", async () => {
		const root = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		];
		const fake = createFakeCdp(root);
		fake.setIframeFrame(50, "FRAME-SP");
		fake.setFrameTree("FRAME-SP", [ax({ nodeId: "old", role: "button", name: "Old", backendDOMNodeId: 60 })]);
		const executor = new BrowserExecutor(fake.cdp);
		await snapshotText(executor);

		fake.emit({ method: "Page.frameDetached", params: { frameId: "FRAME-SP", reason: "swap" }, sessionId: "session-1" });
		await expect(executor.execute({ type: "browser_click", ref: "e2" } as CuaBrowserAction)).rejects.toThrow(/stale/);

		fake.setFrameTree("FRAME-SP", [ax({ nodeId: "new", role: "button", name: "New", backendDOMNodeId: 61 })]);
		expect(await snapshotText(executor)).toContain('button "New" [e');
		fake.emit({ method: "Page.frameDetached", params: { frameId: "FRAME-SP", reason: "remove" }, sessionId: "session-1" });
		expect(executor.exportRefState().generations.map(([key]) => key)).toEqual(["TARGET-1"]);
	});

	it("does not retain generation state for rotating unreferenced frames", async () => {
		const root = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		];
		const fake = createFakeCdp(root);
		const executor = new BrowserExecutor(fake.cdp);
		for (let index = 0; index < 25; index += 1) {
			const frameId = `FRAME-${index}`;
			fake.setIframeFrame(50, frameId);
			fake.setFrameTree(frameId, [ax({ nodeId: `root-${index}`, role: "RootWebArea", name: "Embed" })]);
			await snapshotText(executor);
		}
		expect(executor.exportRefState().generations).toEqual([["TARGET-1", 0]]);
	});

	it("does not retain a frame generation when its AX fetch is transiently inaccessible", async () => {
		const root = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		];
		const fake = createFakeCdp(root);
		fake.setIframeFrame(50, "FRAME-SP");
		fake.setFailureProvider((method, params) =>
			method === "Accessibility.getFullAXTree" && params.frameId === "FRAME-SP"
				? new CdpProtocolError(method, -32000, "Frame with the given id was not found.")
				: undefined,
		);
		const executor = new BrowserExecutor(fake.cdp);
		expect(await snapshotText(executor)).toContain("Iframe [e1]");
		expect(executor.exportRefState().generations).toEqual([["TARGET-1", 0]]);
	});

	it("propagates unexpected frame protocol failures with frame diagnostics and no registration leak", async () => {
		const root = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		];
		const fake = createFakeCdp(root);
		fake.setIframeFrame(50, "FRAME-SP");
		fake.setFailureProvider((method, params) =>
			method === "Accessibility.getFullAXTree" && params.frameId === "FRAME-SP" ? new Error("decoder exploded") : undefined,
		);
		const executor = new BrowserExecutor(fake.cdp);
		await expect(snapshotText(executor)).rejects.toThrow(
			/Failed to collect iframe FRAME-SP at backend node 50 during Accessibility\.getFullAXTree: decoder exploded/,
		);
		expect(executor.exportRefState().generations).toEqual([["TARGET-1", 0]]);
	});

	it("propagates malformed frame trees as indexed collection failures", async () => {
		const root = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		];
		const fake = createFakeCdp(root);
		fake.setIframeFrame(50, "FRAME-SP");
		fake.setFrameTree("FRAME-SP", null as unknown as unknown[]);
		const executor = new BrowserExecutor(fake.cdp);
		await expect(snapshotText(executor)).rejects.toThrow(/FRAME-SP.*building the accessibility index/);
		expect(executor.exportRefState().generations).toEqual([["TARGET-1", 0]]);
	});

	it("propagates unexpected iframe description failures instead of treating them as inaccessible", async () => {
		const root = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		];
		const fake = createFakeCdp(root);
		fake.failOn("DOM.describeNode", new CdpProtocolError("DOM.describeNode", -32603, "Internal error"));
		const executor = new BrowserExecutor(fake.cdp);
		await expect(snapshotText(executor)).rejects.toThrow(/backend node 50 during DOM\.describeNode.*Internal error/);
		expect(fake.sent.filter((command) => command.method === "DOM.describeNode")).toHaveLength(1);
	});

	it("retries a transiently omitted owning frame instead of staling its scoped ref", async () => {
		const root = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
			ax({ nodeId: "2", role: "button", name: "Pay", backendDOMNodeId: 40, parentId: "1" }),
			ax({ nodeId: "3", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		];
		const fake = createFakeCdp(root);
		fake.setIframeFrame(50, "FRAME-SP");
		fake.setFrameTree("FRAME-SP", [ax({ nodeId: "f1", role: "button", name: "Pay", backendDOMNodeId: 70 })]);
		const executor = new BrowserExecutor(fake.cdp);
		await snapshotText(executor);

		let omitted = false;
		fake.setFailureProvider((method) => {
			if (method !== "DOM.describeNode" || omitted) return undefined;
			omitted = true;
			return new CdpProtocolError(method, -32000, "Could not find node with given id");
		});
		await expect(snapshotText(executor, { ref: "e3" })).resolves.toContain('button "Pay"');
		expect(fake.sent.filter((command) => command.method === "DOM.describeNode")).toHaveLength(3);
	});

	it("reports a persistently omitted owning frame as unverifiable rather than stale", async () => {
		const root = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		];
		const fake = createFakeCdp(root);
		fake.setIframeFrame(50, "FRAME-SP");
		fake.setFrameTree("FRAME-SP", [ax({ nodeId: "f1", role: "button", name: "Pay", backendDOMNodeId: 70 })]);
		const executor = new BrowserExecutor(fake.cdp);
		await snapshotText(executor);

		fake.failOn("DOM.describeNode", new CdpProtocolError("DOM.describeNode", -32000, "Could not find node with given id"));
		await expect(snapshotText(executor, { ref: "e2" })).rejects.toThrow(/could not verify ref e2/i);
		expect(fake.sent.filter((command) => command.method === "DOM.describeNode")).toHaveLength(4);
	});
});

describe("BrowserExecutor observation fencing", () => {
	const STALE_TREE = [
		ax({ nodeId: "1", role: "RootWebArea", name: "Old", childIds: ["2"] }),
		ax({ nodeId: "2", role: "button", name: "Stale", backendDOMNodeId: 41, parentId: "1" }),
	];
	const STABLE_TREE = [
		ax({ nodeId: "1", role: "RootWebArea", name: "New", childIds: ["2"] }),
		ax({ nodeId: "2", role: "button", name: "Stable", backendDOMNodeId: 42, parentId: "1" }),
	];

	it.each(["browser_snapshot", "browser_find"] as const)("discards a navigated AX collection for %s before minting refs", async (type) => {
		const fake = createFakeCdp(STALE_TREE);
		fake.setAxReadHook((read, params) => {
			if (read !== 1 || params.frameId) return;
			fake.setNodes(STABLE_TREE);
			fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "TARGET-1" } }, sessionId: "session-1" });
		});
		const executor = new BrowserExecutor(fake.cdp);
		const results = await executor.execute(
			(type === "browser_snapshot" ? { type } : { type, query: "stable button" }) as CuaBrowserAction,
		);
		const text = (results[0] as { text: string }).text;
		expect(text).toContain('button "Stable" [e1]');
		expect(text).not.toContain("Stale");
		expect([...refsOf(executor).keys()]).toEqual(["e1"]);
	});

	it.each([
		["url", { title: "Page", url: "https://b.test/" }],
		["title", { title: "Changed", url: "https://a.test/" }],
	] as const)("retries when target %s changes across collection", async (_field, changed) => {
		const fake = createFakeCdp(BUTTON_TREE);
		fake.setTargetProvider((read) => [
			{ targetId: "TARGET-1", type: "page", ...(read < 3 ? { title: "Page", url: "https://a.test/" } : changed) },
		]);
		const executor = new BrowserExecutor(fake.cdp);
		expect(await snapshotText(executor)).toContain('button "Save" [e1]');
		expect(fake.sent.filter((command) => command.method === "Accessibility.getFullAXTree")).toHaveLength(2);
	});

	it("retries when a stitched frame changes during its AX read", async () => {
		const root = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		];
		const oldChild = [ax({ nodeId: "f1", role: "button", name: "Old child", backendDOMNodeId: 60 })];
		const newChild = [ax({ nodeId: "f1", role: "button", name: "New child", backendDOMNodeId: 61 })];
		const fake = createFakeCdp(root);
		fake.setIframeFrame(50, "FRAME-SP");
		fake.setFrameTree("FRAME-SP", oldChild);
		fake.setAxReadHook((_read, params) => {
			if (params.frameId !== "FRAME-SP") return;
			fake.setAxReadHook(undefined);
			fake.setFrameTree("FRAME-SP", newChild);
			fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "FRAME-SP", parentId: "TARGET-1" } }, sessionId: "session-1" });
		});
		const executor = new BrowserExecutor(fake.cdp);
		const text = await snapshotText(executor);
		expect(text).toContain('button "New child"');
		expect(text).not.toContain("Old child");
	});

	it("retries when a generation-zero OOPIF detaches after its AX read", async () => {
		const root = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		];
		const fake = createFakeCdp(root);
		fake.setIframeFrame(50, "FRAME-OOP");
		fake.addAutoAttachFrame({ targetId: "FRAME-OOP", sessionId: "session-oop" });
		fake.setSessionTree("session-oop", [ax({ nodeId: "f1", role: "button", name: "Detached", backendDOMNodeId: 60 })]);
		fake.setFrameTree("FRAME-OOP", [ax({ nodeId: "f1", role: "button", name: "Current", backendDOMNodeId: 61 })]);
		fake.setAxReadHook((_read, _params, sessionId) => {
			if (sessionId !== "session-oop") return;
			fake.setAxReadHook(undefined);
			fake.emit({ method: "Target.detachedFromTarget", params: { sessionId: "session-oop" } });
		});
		const executor = new BrowserExecutor(fake.cdp);
		const text = await snapshotText(executor);
		expect(text).toContain('button "Current"');
		expect(text).not.toContain("Detached");
	});

	it.each(["browser_snapshot", "browser_find"] as const)("fails %s after three changed collections without minting refs", async (type) => {
		const fake = createFakeCdp(BUTTON_TREE);
		fake.setAxReadHook((_read, params) => {
			if (!params.frameId) fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "TARGET-1" } }, sessionId: "session-1" });
		});
		const executor = new BrowserExecutor(fake.cdp);
		await expect(
			executor.execute((type === "browser_snapshot" ? { type } : { type, query: "save" }) as CuaBrowserAction),
		).rejects.toThrow(/observation changed/i);
		expect(fake.sent.filter((command) => command.method === "Accessibility.getFullAXTree")).toHaveLength(3);
		expect(refsOf(executor).size).toBe(0);
	});
});

describe("navigation tool grounding frame", () => {
	const navTool = (mode: "computer" | "browser" | "hybrid") => {
		const { client, batches } = createClient();
		const { executor, executed } = createFakeBrowserExecutor();
		const translator = new InternalComputerTranslator({ browser, client, mode, createBrowserExecutor: () => executor });
		const tool = buildCuaComputerTools({ toolExecutors: [], mode }, translator).find((tool) => tool.name === "computer_use_extra")!;
		return { tool, batches, executed };
	};

	it("captures the viewport in browser mode and the OS display otherwise", async () => {
		const viewportData = Buffer.from("png").toString("base64");

		const browserResult = await navTool("browser").tool.execute("call_1", { action: "back" });
		const viewportImage = browserResult.content.find((block) => block.type === "image");
		expect(viewportImage).toMatchObject({ type: "image", data: viewportData });

		const computerResult = await navTool("computer").tool.execute("call_2", { action: "back" });
		const osImage = computerResult.content.find((block) => block.type === "image");
		expect(osImage?.type).toBe("image");
		expect((osImage as { data: string }).data).not.toBe(viewportData);
	});

	it("navigates on the browser plane in browser and hybrid modes and the OS plane in computer mode", async () => {
		const inBrowser = navTool("browser");
		await inBrowser.tool.execute("call_1", { action: "goto", url: "https://example.com" });
		await inBrowser.tool.execute("call_2", { action: "back" });
		expect(inBrowser.executed).toEqual([
			{ type: "browser_navigate", url: "https://example.com" },
			{ type: "browser_navigate", url: "back" },
		]);
		expect(inBrowser.batches).toEqual([]);

		const inHybrid = navTool("hybrid");
		await inHybrid.tool.execute("call_3", { action: "forward" });
		expect(inHybrid.executed).toEqual([{ type: "browser_navigate", url: "forward" }]);
		expect(inHybrid.batches).toEqual([]);

		const inComputer = navTool("computer");
		await inComputer.tool.execute("call_4", { action: "back" });
		expect(inComputer.executed).toEqual([]);
		expect(inComputer.batches).toHaveLength(1);
	});
});

describe("BrowserExecutor multi-click", () => {
	it("dispatches one press/release cycle per click with incrementing clickCount", async () => {
		const { cdp, sent } = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);
		await executor.execute({ type: "browser_click", ref: "e1", num_clicks: 2 } as CuaBrowserAction);

		const mouse = sent.filter((cmd) => cmd.method === "Input.dispatchMouseEvent").map((cmd) => cmd.params);
		expect(mouse.map((params) => [params.type, params.clickCount])).toEqual([
			["mouseMoved", undefined],
			["mousePressed", 1],
			["mouseReleased", 1],
			["mousePressed", 2],
			["mouseReleased", 2],
		]);
	});
});

describe("BrowserExecutor ref state export/import", () => {
	it("resolves refs imported from a previous executor against the same browser", async () => {
		const first = new BrowserExecutor(createFakeCdp(BUTTON_TREE).cdp);
		await snapshotText(first);
		const state = first.exportRefState();

		const { cdp, sent } = createFakeCdp(BUTTON_TREE);
		const second = new BrowserExecutor(cdp);
		second.importRefState(state);
		await second.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction);
		const pressed = sent.find((cmd) => cmd.method === "Input.dispatchMouseEvent" && cmd.params.type === "mousePressed");
		expect(pressed).toBeDefined();
	});

	it("restores a same-process frame ref with its owning generation", async () => {
		const root = [
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		];
		const firstFake = createFakeCdp(root);
		firstFake.setIframeFrame(50, "FRAME-SP");
		firstFake.setFrameTree("FRAME-SP", [ax({ nodeId: "f1", role: "button", name: "Pay", backendDOMNodeId: 70 })]);
		const first = new BrowserExecutor(firstFake.cdp);
		await snapshotText(first);
		const state = first.exportRefState();

		const secondFake = createFakeCdp(root);
		secondFake.setIframeFrame(50, "FRAME-SP");
		secondFake.setFrameTree("FRAME-SP", [ax({ nodeId: "f1", role: "button", name: "Pay", backendDOMNodeId: 70 })]);
		const second = new BrowserExecutor(secondFake.cdp);
		second.importRefState(state);
		await second.execute({ type: "browser_click", ref: "e2" } as CuaBrowserAction);
		expect(secondFake.sent.some((command) => command.method === "DOM.getBoxModel" && command.params.backendNodeId === 70)).toBe(true);
	});

	it("keeps minting unique refs after import and invalidates imported refs on navigation", async () => {
		const first = new BrowserExecutor(createFakeCdp(BUTTON_TREE).cdp);
		await snapshotText(first);
		const state = first.exportRefState();

		const { cdp, emit } = createFakeCdp(BUTTON_TREE);
		const second = new BrowserExecutor(cdp);
		second.importRefState(state);
		expect(await snapshotText(second)).toContain('button "Save" [e2]');

		emit({ method: "Page.frameNavigated", params: { frame: { id: "F0" } }, sessionId: "session-1" });
		await expect(second.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction)).rejects.toThrow(/stale/);
	});
});

describe("BrowserExecutor cross-process document identity", () => {
	it("records the main-frame document identity in exported ref state", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		fake.setLoaderId("L0");
		const executor = new BrowserExecutor(fake.cdp);
		await snapshotText(executor);
		const state = executor.exportRefState();
		expect(state.generations).toEqual([["TARGET-1", 0]]);
		expect(state.documents).toEqual([["TARGET-1", "L0"]]);
	});

	it("stales an imported ref when the document changed across processes", async () => {
		const firstFake = createFakeCdp(BUTTON_TREE);
		firstFake.setLoaderId("L0");
		const first = new BrowserExecutor(firstFake.cdp);
		await snapshotText(first);
		const state = first.exportRefState();
		expect(state.documents).toEqual([["TARGET-1", "L0"]]);

		// A new process attaches to a browser whose document has since changed
		// (e.g. a click-induced navigation that raced the first process's exit).
		const secondFake = createFakeCdp(BUTTON_TREE);
		secondFake.setLoaderId("L1");
		const second = new BrowserExecutor(secondFake.cdp);
		second.importRefState(state);
		await expect(second.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction)).rejects.toThrow(/stale/);
		expect(refsOf(second).size).toBe(0);
	});

	it("keeps an imported ref usable when the document is unchanged across processes", async () => {
		const firstFake = createFakeCdp(BUTTON_TREE);
		firstFake.setLoaderId("L0");
		const first = new BrowserExecutor(firstFake.cdp);
		await snapshotText(first);
		const state = first.exportRefState();

		const secondFake = createFakeCdp(BUTTON_TREE);
		secondFake.setLoaderId("L0");
		const second = new BrowserExecutor(secondFake.cdp);
		second.importRefState(state);
		await second.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction);
		const pressed = secondFake.sent.find((cmd) => cmd.method === "Input.dispatchMouseEvent" && cmd.params.type === "mousePressed");
		expect(pressed).toBeDefined();
	});

	// browser_fill / browser_scroll_to resolve their ref without first attaching, so the
	// imported-document reconcile (which runs on attach) must be forced ahead of the resolve;
	// otherwise a changed document across the process boundary silently mis-targets a reused
	// backend node id. These cover the two ref-consuming CLI actions that click/hover do not.
	it("stales an imported ref on browser_fill when the document changed across processes", async () => {
		const firstFake = createFakeCdp(BUTTON_TREE);
		firstFake.setLoaderId("L0");
		const first = new BrowserExecutor(firstFake.cdp);
		await snapshotText(first);
		const state = first.exportRefState();

		const secondFake = createFakeCdp(BUTTON_TREE);
		secondFake.setLoaderId("L1");
		const second = new BrowserExecutor(secondFake.cdp);
		second.importRefState(state);
		await expect(second.execute({ type: "browser_fill", ref: "e1", value: "x" } as CuaBrowserAction)).rejects.toThrow(/stale/);
		expect(refsOf(second).size).toBe(0);
		expect(secondFake.sent.some((cmd) => cmd.method === "Runtime.callFunctionOn")).toBe(false);
	});

	it("keeps browser_fill usable when the document is unchanged across processes", async () => {
		const firstFake = createFakeCdp(BUTTON_TREE);
		firstFake.setLoaderId("L0");
		const first = new BrowserExecutor(firstFake.cdp);
		await snapshotText(first);
		const state = first.exportRefState();

		const secondFake = createFakeCdp(BUTTON_TREE);
		secondFake.setLoaderId("L0");
		const second = new BrowserExecutor(secondFake.cdp);
		second.importRefState(state);
		await second.execute({ type: "browser_fill", ref: "e1", value: "x" } as CuaBrowserAction);
		expect(secondFake.sent.some((cmd) => cmd.method === "Runtime.callFunctionOn")).toBe(true);
	});

	it("stales an imported ref on browser_scroll_to when the document changed across processes", async () => {
		const firstFake = createFakeCdp(BUTTON_TREE);
		firstFake.setLoaderId("L0");
		const first = new BrowserExecutor(firstFake.cdp);
		await snapshotText(first);
		const state = first.exportRefState();

		const secondFake = createFakeCdp(BUTTON_TREE);
		secondFake.setLoaderId("L1");
		const second = new BrowserExecutor(secondFake.cdp);
		second.importRefState(state);
		await expect(second.execute({ type: "browser_scroll_to", ref: "e1" } as CuaBrowserAction)).rejects.toThrow(/stale/);
		expect(refsOf(second).size).toBe(0);
		expect(secondFake.sent.some((cmd) => cmd.method === "DOM.scrollIntoViewIfNeeded")).toBe(false);
	});

	it("carries the document identity through an invocation that never re-attaches the target", async () => {
		const firstFake = createFakeCdp(BUTTON_TREE);
		firstFake.setLoaderId("L0");
		const first = new BrowserExecutor(firstFake.cdp);
		await snapshotText(first);
		const state = first.exportRefState();

		// Middle invocation imports and re-exports without ever attaching (e.g. `cua url`).
		const middleFake = createFakeCdp(BUTTON_TREE);
		middleFake.setLoaderId("L0");
		const middle = new BrowserExecutor(middleFake.cdp);
		middle.importRefState(state);
		const relayed = middle.exportRefState();
		expect(relayed.documents).toEqual([["TARGET-1", "L0"]]);

		// The next process still catches the changed document.
		const lastFake = createFakeCdp(BUTTON_TREE);
		lastFake.setLoaderId("L1");
		const last = new BrowserExecutor(lastFake.cdp);
		last.importRefState(relayed);
		await expect(last.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction)).rejects.toThrow(/stale/);
	});

	// Legacy state predates document identity; generation alone is process-local
	// and cannot prove the document is unchanged, so such a ref must fail safe
	// (stale) rather than resolve against a possibly-reused backend node id. This
	// asserts staling even when the live document is unchanged (L0 == L0), because
	// the exporter recorded no identity to verify against.
	it("stales an imported legacy ref that carries no document identity", async () => {
		const firstFake = createFakeCdp(BUTTON_TREE);
		const first = new BrowserExecutor(firstFake.cdp);
		await snapshotText(first);
		const state = first.exportRefState();
		// Strip the identity to model state serialized before this field existed.
		delete (state as { documents?: unknown }).documents;

		const secondFake = createFakeCdp(BUTTON_TREE);
		const second = new BrowserExecutor(secondFake.cdp);
		second.importRefState(state);
		await expect(second.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction)).rejects.toThrow(/stale/);
		expect(refsOf(second).size).toBe(0);
		expect(secondFake.sent.some((cmd) => cmd.method === "Input.dispatchMouseEvent")).toBe(false);

		// A fresh snapshot re-mints refs and records identity, so the next export
		// upgrades naturally — legacy state auto-heals forward through normal use.
		expect(await snapshotText(second)).toContain('button "Save" [e2]');
		expect(second.exportRefState().documents).toEqual([["TARGET-1", "L0"]]);
	});
});

// Per-frame document identity: a ref carries the loaderId of its *owning* frame
// (the page target for main-frame refs, the child frame id for same-process
// iframes and OOPIFs). A later process reconciles each frame against the live
// browser before any ref resolves, so a child-frame or OOPIF navigation stales
// only that frame's refs — even when the main-frame loaderId is unchanged.
describe("BrowserExecutor cross-process frame document identity", () => {
	const OOPIF_PAGE = [
		ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
		ax({ nodeId: "2", role: "button", name: "Top", backendDOMNodeId: 40, parentId: "1" }),
		ax({ nodeId: "3", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
	];
	const OOPIF_CHILD = [
		ax({ nodeId: "f1", role: "RootWebArea", name: "Widget", childIds: ["f2"] }),
		ax({ nodeId: "f2", role: "button", name: "Pay", backendDOMNodeId: 70, parentId: "f1" }),
	];
	// A page embedding one cross-origin iframe. `main`/`oopif` pin each frame's
	// live document loaderId. `attach: false` models an OOPIF that is gone: no
	// session surfaces and it is absent from the page frame tree.
	const oopifProcess = (opts: { main: string; oopif?: string; attach?: boolean; attachDelayMs?: number }) => {
		const fake = createFakeCdp(OOPIF_PAGE);
		fake.setLoaderId(opts.main);
		fake.setSessionTree("session-oop", OOPIF_CHILD);
		if (opts.attach !== false) {
			fake.setIframeFrame(50, "FRAME-OOP");
			if (opts.oopif !== undefined) fake.setFrameLoaderId("FRAME-OOP", opts.oopif);
			fake.addAutoAttachFrame({ targetId: "FRAME-OOP", sessionId: "session-oop", ...(opts.attachDelayMs ? { delayMs: opts.attachDelayMs } : {}) });
		}
		return fake;
	};
	const mintOopifState = () => {
		const fake = oopifProcess({ main: "M0", oopif: "O0" });
		const executor = new BrowserExecutor(fake.cdp);
		return snapshotText(executor).then((text) => {
			expect(text).toContain('button "Top" [e1]');
			expect(text).toContain('Iframe [e2]');
			expect(text).toContain('button "Pay" [e3]');
			return executor.exportRefState();
		});
	};

	it("stales only OOPIF refs on an OOPIF-only navigation with the main loader unchanged", async () => {
		const state = await mintOopifState();
		expect(state.documents).toEqual(
			expect.arrayContaining([
				["TARGET-1", "M0"],
				["FRAME-OOP", "O0"],
			]),
		);

		const importFake = oopifProcess({ main: "M0", oopif: "O1" });
		const second = new BrowserExecutor(importFake.cdp);
		second.importRefState(state);

		await expect(second.execute({ type: "browser_click", ref: "e3" } as CuaBrowserAction)).rejects.toThrow(/stale/);
		// Only the OOPIF's refs were dropped; the main-frame "Top" and parent
		// Iframe refs survive.
		expect([...refsOf(second).keys()].sort()).toEqual(["e1", "e2"]);
		await second.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction);
		expect(importFake.sent.some((cmd) => cmd.method === "Input.dispatchMouseEvent" && cmd.params.type === "mousePressed")).toBe(true);
	});

	it("keeps every ref when no frame's document changed across processes", async () => {
		const state = await mintOopifState();
		const importFake = oopifProcess({ main: "M0", oopif: "O0" });
		const second = new BrowserExecutor(importFake.cdp);
		second.importRefState(state);

		await second.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction);
		await second.execute({ type: "browser_click", ref: "e3" } as CuaBrowserAction);
		const oopifPress = importFake.sent.find(
			(cmd) => cmd.method === "DOM.getBoxModel" && cmd.params.backendNodeId === 70 && cmd.sessionId === "session-oop",
		);
		expect(oopifPress).toBeDefined();
	});

	it("reconciles an OOPIF whose session auto-attaches only after setAutoAttach returns", async () => {
		const state = await mintOopifState();
		// The OOPIF's attachedToTarget is delayed past attach()'s setAutoAttach, so
		// the reconcile must bounded-wait for the session before reading its loader.
		const importFake = oopifProcess({ main: "M0", oopif: "O0", attachDelayMs: 40 });
		const second = new BrowserExecutor(importFake.cdp);
		second.importRefState(state);

		await second.execute({ type: "browser_click", ref: "e3" } as CuaBrowserAction);
		const resolved = importFake.sent.find(
			(cmd) => cmd.method === "DOM.getBoxModel" && cmd.params.backendNodeId === 70 && cmd.sessionId === "session-oop",
		);
		expect(resolved).toBeDefined();
	});

	it("stales an OOPIF ref whose frame is gone (no session, absent from the page tree) but keeps the main frame", async () => {
		const state = await mintOopifState();
		const importFake = oopifProcess({ main: "M0", attach: false });
		const second = new BrowserExecutor(importFake.cdp);
		second.importRefState(state);

		await expect(second.execute({ type: "browser_click", ref: "e3" } as CuaBrowserAction)).rejects.toThrow(/stale/);
		await second.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction);
		expect(importFake.sent.some((cmd) => cmd.method === "Input.dispatchMouseEvent" && cmd.params.type === "mousePressed")).toBe(true);
	});

	it.each(["browser_fill", "browser_scroll_to"] as const)(
		"reconciles the OOPIF document before %s resolves its ref",
		async (type) => {
			const state = await mintOopifState();
			const importFake = oopifProcess({ main: "M0", oopif: "O1" });
			const second = new BrowserExecutor(importFake.cdp);
			second.importRefState(state);

			const action = (type === "browser_fill" ? { type, ref: "e3", value: "x" } : { type, ref: "e3" }) as CuaBrowserAction;
			await expect(second.execute(action)).rejects.toThrow(/stale/);
			// The changed OOPIF document stales the ref before any mutation touches it.
			expect(importFake.sent.some((cmd) => cmd.method === "Runtime.callFunctionOn")).toBe(false);
			expect(importFake.sent.some((cmd) => cmd.method === "DOM.scrollIntoViewIfNeeded")).toBe(false);
		},
	);

	it("carries per-frame identities through an intermediate process that never re-attaches", async () => {
		const state = await mintOopifState();
		// Middle invocation imports and re-exports without ever attaching.
		const middleFake = oopifProcess({ main: "M0", oopif: "O0" });
		const middle = new BrowserExecutor(middleFake.cdp);
		middle.importRefState(state);
		const relayed = middle.exportRefState();
		expect(relayed.documents).toEqual(
			expect.arrayContaining([
				["TARGET-1", "M0"],
				["FRAME-OOP", "O0"],
			]),
		);

		// The final process still catches the OOPIF-only change through the relay.
		const lastFake = oopifProcess({ main: "M0", oopif: "O1" });
		const last = new BrowserExecutor(lastFake.cdp);
		last.importRefState(relayed);
		await expect(last.execute({ type: "browser_click", ref: "e3" } as CuaBrowserAction)).rejects.toThrow(/stale/);
		await last.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction);
		expect(lastFake.sent.some((cmd) => cmd.method === "Input.dispatchMouseEvent" && cmd.params.type === "mousePressed")).toBe(true);
	});

	it("reads the frame tree at most once for the page and once per pending OOPIF", async () => {
		const state = await mintOopifState();
		const importFake = oopifProcess({ main: "M0", oopif: "O0" });
		const second = new BrowserExecutor(importFake.cdp);
		second.importRefState(state);

		await second.execute({ type: "browser_click", ref: "e3" } as CuaBrowserAction);
		const pageTrees = importFake.sent.filter((cmd) => cmd.method === "Page.getFrameTree" && cmd.sessionId === "session-1");
		const oopifTrees = importFake.sent.filter((cmd) => cmd.method === "Page.getFrameTree" && cmd.sessionId === "session-oop");
		expect(pageTrees).toHaveLength(1);
		expect(oopifTrees).toHaveLength(1);
	});

	const TWO_FRAME_PAGE = [
		ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
		ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		ax({ nodeId: "3", role: "Iframe", backendDOMNodeId: 51, parentId: "1" }),
	];
	const FRAME_A_TREE = [
		ax({ nodeId: "a1", role: "RootWebArea", name: "A", childIds: ["a2"] }),
		ax({ nodeId: "a2", role: "button", name: "PayA", backendDOMNodeId: 60, parentId: "a1" }),
	];
	const FRAME_B_TREE = [
		ax({ nodeId: "b1", role: "RootWebArea", name: "B", childIds: ["b2"] }),
		ax({ nodeId: "b2", role: "button", name: "PayB", backendDOMNodeId: 61, parentId: "b1" }),
	];
	const twoFrameProcess = (a: string, b: string) => {
		const fake = createFakeCdp(TWO_FRAME_PAGE);
		fake.setIframeFrame(50, "FRAME-A");
		fake.setIframeFrame(51, "FRAME-B");
		fake.setFrameTree("FRAME-A", FRAME_A_TREE);
		fake.setFrameTree("FRAME-B", FRAME_B_TREE);
		fake.setFrameLoaderId("FRAME-A", a);
		fake.setFrameLoaderId("FRAME-B", b);
		return fake;
	};

	it("stales only the changed same-process child frame, keeping its sibling and the main frame", async () => {
		const mintFake = twoFrameProcess("A0", "B0");
		const mint = new BrowserExecutor(mintFake.cdp);
		const minted = await snapshotText(mint);
		const payA = refFor(minted, "PayA");
		const payB = refFor(minted, "PayB");
		const state = mint.exportRefState();
		expect(state.documents).toEqual(
			expect.arrayContaining([
				["FRAME-A", "A0"],
				["FRAME-B", "B0"],
			]),
		);

		// Only FRAME-A's document changed across the boundary.
		const importFake = twoFrameProcess("A1", "B0");
		const second = new BrowserExecutor(importFake.cdp);
		second.importRefState(state);

		await expect(second.execute({ type: "browser_click", ref: payA } as CuaBrowserAction)).rejects.toThrow(/stale/);
		// The sibling frame's ref still resolves against its unchanged document.
		await second.execute({ type: "browser_click", ref: payB } as CuaBrowserAction);
		expect(importFake.sent.some((cmd) => cmd.method === "DOM.getBoxModel" && cmd.params.backendNodeId === 61)).toBe(true);
	});

	it("fails safe for a partial state missing one frame's identity, even when nothing changed", async () => {
		const state = await mintOopifState();
		// Drop just the OOPIF frame's identity, as an older/partial writer might.
		state.documents = state.documents!.filter(([frameKey]) => frameKey !== "FRAME-OOP");

		const importFake = oopifProcess({ main: "M0", oopif: "O0" });
		const second = new BrowserExecutor(importFake.cdp);
		second.importRefState(state);

		// Unverifiable ⇒ stale, even though the live OOPIF document is unchanged.
		await expect(second.execute({ type: "browser_click", ref: "e3" } as CuaBrowserAction)).rejects.toThrow(/stale/);
		// The frame that *does* carry identity is preserved.
		await second.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction);
		expect(importFake.sent.some((cmd) => cmd.method === "Input.dispatchMouseEvent" && cmd.params.type === "mousePressed")).toBe(true);
	});

	it("rejects ref state serialized by a newer, unknown identity scheme", () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(fake.cdp);
		const future: BrowserRefState = { version: 2, refCounter: 0, generations: [], refs: [] };
		expect(() => executor.importRefState(future)).toThrow(/version 2/);
	});
});
