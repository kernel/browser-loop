import type Kernel from "@onkernel/sdk";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { computerToolExecutors, type CuaBrowserAction } from "@onkernel/cua-ai";
import { BrowserExecutor } from "../src/translator/browser";
import type { CdpConnection } from "../src/translator/cdp";
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
			if (action.type === "browser_act") {
				const stopped = action.steps[0]?.type === "click" && action.steps[0].ref === "stale";
				return [{
					type: "browser_act",
					result: {
						outcome: stopped ? "didnt" : "unknown",
						steps: [{ index: 0, type: "click", outcome: stopped ? "didnt" : "unknown", evidence: ["input delivered"] }],
						...(stopped ? { stopped_at: 0, stop_reason: "stale_ref" as const } : {}),
						final_expectation: { status: "preexisting", before: true, after: true, details: ["after: title=\"Page\""] },
						successor: {
							status: "observed",
							text: 'button "Save" [e2]',
							url: "https://a.test/",
							title: "Page",
							diff: {
								changed: true,
								added: [],
								removed: [],
								url: { before: "https://a.test/old", after: "https://a.test/" },
								title: { before: "Old", after: "Page" },
							},
						},
					},
				}];
			}
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

	it("surfaces browser_act as readable content and structured tool details without a fallback screenshot", async () => {
		const { client } = createClient();
		const { executor } = createFakeBrowserExecutor();
		const translator = new InternalComputerTranslator({ browser, client, createBrowserExecutor: () => executor });
		const actExecutor = computerToolExecutors({ mode: "browser" }).find((candidate) => candidate.definition.name === "act")!;
		const tool = buildCuaComputerTools({ toolExecutors: [actExecutor], mode: "browser" }, translator).find((candidate) => candidate.name === "act")!;

		const result = await tool.execute("call_1", { steps: [{ type: "click", ref: "e1" }] });

		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({ type: "text" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("browser_act outcome: unknown");
		expect(text).toContain('after: title="Page"');
		expect(text).toContain("successor url: https://a.test/");
		expect(text).toContain("url: https://a.test/old -> https://a.test/");
		expect(text).toContain("title: Old -> Page");
		expect(result.details.statusText).toBe("Browser action outcome is unknown.");
		expect(result.details.readResults[0]).toMatchObject({ type: "browser_act", result: { outcome: "unknown" } });
	});

	it("stops a mixed batch after browser_act reaches a stop boundary", async () => {
		const { client } = createClient();
		const { executor, executed } = createFakeBrowserExecutor();
		const translator = new InternalComputerTranslator({ browser, client, createBrowserExecutor: () => executor });

		await translator.executeBatch([
			{ type: "browser_act", steps: [{ type: "click", ref: "stale" }] },
			{ type: "browser_type", text: "must not run" },
		]);

		expect(executed.map((action) => action.type)).toEqual(["browser_act"]);
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
	let targets = [{ targetId: "TARGET-1", type: "page", title: "Page", url: "https://a.test/" }];
	const sessionTrees = new Map<string, Array<{ backendDOMNodeId?: number }>>();
	const frameTrees = new Map<string, Array<{ backendDOMNodeId?: number }>>();
	const iframeFrameIds = new Map<number, string>();
	const autoAttachFrames: Array<{ targetId: string; sessionId: string }> = [];
	const failMethods = new Set<string>();
	const emit = (event: FakeCdpEvent) => {
		for (const listener of listeners) listener(event);
	};
	const treeFor = (sessionId?: string, frameId?: unknown) => {
		if (typeof frameId === "string" && frameTrees.has(frameId)) return frameTrees.get(frameId)!;
		if (sessionId && sessionTrees.has(sessionId)) return sessionTrees.get(sessionId)!;
		return nodes;
	};
	const requireBackendId = (id: unknown, sessionId?: string) => {
		const candidates = sessionId && sessionTrees.has(sessionId)
			? [sessionTrees.get(sessionId)!, ...frameTrees.values()]
			: [nodes, ...frameTrees.values()];
		if (!candidates.some((tree) => tree.some((node) => node.backendDOMNodeId === id))) throw new Error("No node with given id found");
	};
	const fake = {
		onEvent: (listener: (event: FakeCdpEvent) => void) => {
			listeners.push(listener);
		},
		send: async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
			sent.push({ method, params, sessionId });
			if (failMethods.has(method)) throw new Error(`${method} rejected`);
			switch (method) {
				case "Accessibility.getFullAXTree":
					return { nodes: treeFor(sessionId, params.frameId) };
				case "Target.setAutoAttach":
					for (const frame of autoAttachFrames.splice(0)) {
						emit({
							method: "Target.attachedToTarget",
							params: { sessionId: frame.sessionId, targetInfo: { targetId: frame.targetId, type: "iframe" } },
							sessionId,
						});
					}
					return {};
				case "DOM.scrollIntoViewIfNeeded":
					requireBackendId(params.backendNodeId, sessionId);
					return {};
				case "DOM.getBoxModel":
					requireBackendId(params.backendNodeId, sessionId);
					return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
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
		pageTargets: async () => targets,
		attachToTarget: async () => "session-1",
		createTarget: async () => "TARGET-2",
		close: () => {},
	};
	const setNodes = (next: unknown[]) => {
		nodes = next as Array<{ backendDOMNodeId?: number }>;
	};
	const setTargets = (next: typeof targets) => {
		targets = next;
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
	const addAutoAttachFrame = (frame: { targetId: string; sessionId: string }) => {
		autoAttachFrames.push(frame);
	};
	const failOn = (method: string) => {
		failMethods.add(method);
	};
	return {
		sent,
		emit,
		setNodes,
		setTargets,
		setCursorBackendIds,
		setSessionTree,
		setFrameTree,
		setIframeFrame,
		addAutoAttachFrame,
		failOn,
		cdp: fake as unknown as CdpConnection,
	};
}

interface AXNodeSpec {
	nodeId: string;
	ignored?: boolean;
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
		ignored: spec.ignored,
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

	it("preserves incomplete frame state while bounding stale metadata", async () => {
		const fake = createFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
			ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
			ax({ nodeId: "3", role: "Iframe", backendDOMNodeId: 51, parentId: "1" }),
		]);
		const executor = new BrowserExecutor(fake.cdp);
		for (let index = 0; index < 5; index += 1) {
			const frameId = `FRAME-${index}`;
			fake.setIframeFrame(50, frameId);
			fake.setFrameTree(frameId, [ax({ nodeId: `f${index}`, role: "RootWebArea", name: `Frame ${index}` })]);
			await snapshotText(executor);
			if (index < 4) {
				fake.emit({ method: "Page.frameNavigated", params: { frame: { id: frameId, parentId: "TARGET-1" } }, sessionId: "session-1" });
			}
		}

		const internal = executor as unknown as {
			generations: Map<string, number>;
			frameParents: Map<string, string>;
			boundFrameState: (observed: ReadonlySet<string>) => void;
		};
		expect([...internal.generations.keys()].filter((key) => key.startsWith("FRAME-"))).toEqual([
			"FRAME-0",
			"FRAME-1",
			"FRAME-2",
			"FRAME-3",
			"FRAME-4",
		]);
		for (let index = 0; index < 1100; index += 1) {
			internal.frameParents.set(`STALE-${index}`, "TARGET-1");
			internal.generations.set(`STALE-${index}`, 0);
		}
		internal.boundFrameState(new Set(["TARGET-1", "FRAME-4"]));
		expect(internal.frameParents.size).toBeLessThanOrEqual(1000);
		expect(internal.generations.size).toBeLessThanOrEqual(1000);
		expect(internal.frameParents.has("FRAME-4")).toBe(true);
	});

	it("drops generation state when a target detaches", async () => {
		const { cdp, emit } = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);

		emit({ method: "Target.detachedFromTarget", params: { sessionId: "session-1", targetId: "TARGET-1" } });

		expect((executor as unknown as { generations: Map<string, number> }).generations.has("TARGET-1")).toBe(false);
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

	it("retries when an earlier iframe navigates while later frames are collected", async () => {
		const fake = createFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
			ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
			ax({ nodeId: "3", role: "Iframe", backendDOMNodeId: 51, parentId: "1" }),
		]);
		fake.setIframeFrame(50, "FRAME-1");
		fake.setFrameTree("FRAME-1", [ax({ nodeId: "f1", role: "RootWebArea", name: "Old frame" })]);
		fake.setIframeFrame(51, "FRAME-2");
		fake.setFrameTree("FRAME-2", [ax({ nodeId: "g1", role: "RootWebArea", name: "Other frame" })]);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		let changed = false;
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Accessibility.getFullAXTree" && params?.frameId === "FRAME-2" && !changed) {
					changed = true;
					fake.setFrameTree("FRAME-1", [ax({ nodeId: "f1", role: "RootWebArea", name: "Updated frame" })]);
					fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "FRAME-1", parentId: "TARGET-1" } }, sessionId: "session-1" });
				}
				return result;
			},
		} as unknown as CdpConnection;

		const text = await snapshotText(new BrowserExecutor(wrapped));
		expect(text).toContain('RootWebArea "Updated frame"');
		expect(text).not.toContain('RootWebArea "Old frame"');
	});

	it("generation-fences browser_find before minting refs", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		let changed = false;
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Accessibility.getFullAXTree" && !changed) {
					changed = true;
					fake.setNodes([
						ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
						ax({ nodeId: "2", role: "button", name: "Delete", backendDOMNodeId: 43, parentId: "1" }),
					]);
					fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "TARGET-1" } }, sessionId: "session-1" });
				}
				return result;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);

		const results = await executor.execute({ type: "browser_find", query: "delete button" } as CuaBrowserAction);
		const read = results[0];
		if (!read || read.type !== "browser_text") throw new Error("expected find result");
		expect(read.text).toContain('button "Delete"');
		expect(read.text).not.toContain('button "Save"');
	});

	it("retries when navigation changes the document during observation", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		let changed = false;
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Accessibility.getFullAXTree" && !changed) {
					changed = true;
					fake.setNodes([
						ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
						ax({ nodeId: "2", role: "button", name: "Delete", backendDOMNodeId: 43, parentId: "1" }),
					]);
					fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "TARGET-1" } }, sessionId: "session-1" });
				}
				return result;
			},
		} as unknown as CdpConnection;

		const text = await snapshotText(new BrowserExecutor(wrapped));
		expect(text).toContain('button "Delete"');
		expect(text).not.toContain('button "Save"');
	});
});

describe("BrowserExecutor browser_act", () => {
	const actResult = async (executor: BrowserExecutor, action: Omit<Extract<CuaBrowserAction, { type: "browser_act" }>, "type">) => {
		const reads = await executor.execute({ type: "browser_act", ...action });
		const read = reads.find((item) => item.type === "browser_act");
		if (!read || read.type !== "browser_act") throw new Error("expected browser_act result");
		return read.result;
	};
	const observedSuccessor = (result: Awaited<ReturnType<typeof actResult>>) => {
		if (result.successor.status !== "observed") throw new Error("expected observed successor");
		return result.successor;
	};

	it("reports a newly verified expectation and a structured successor diff", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
					fake.setNodes([
						ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
						ax({ nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 42, parentId: "1" }),
						ax({ nodeId: "3", role: "StaticText", name: "Saved", parentId: "1" }),
					]);
				}
				return result;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);

		const result = await actResult(executor, {
			steps: [
				{
					type: "click",
					ref: "e1",
					expect: {
						any: [
							{ type: "role_name", role: "StaticText", name: "Saved" },
							{ type: "text", text: "missing" },
						],
					},
				},
			],
		});

		expect(result.outcome).toBe("worked");
		expect(result.steps[0]?.expectation).toMatchObject({ status: "newly_verified", before: false, after: true });
		expect(observedSuccessor(result).diff).toMatchObject({ changed: true, added: ['  StaticText "Saved"'] });
		expect(observedSuccessor(result).text).toContain('StaticText "Saved"');
		expect(await snapshotText(executor)).toBe("Page unchanged since the last snapshot; previous element refs are still valid.");
	});

	it("reports a failed postcondition and does not execute later steps", async () => {
		const { cdp, sent } = createFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
			ax({ nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 42, parentId: "1" }),
			ax({ nodeId: "3", role: "button", name: "Next", backendDOMNodeId: 43, parentId: "1" }),
		]);
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);

		const result = await actResult(executor, {
			steps: [
				{ type: "click", ref: "e1", expect: { type: "text", text: "Saved" } },
				{ type: "click", ref: "e2" },
			],
		});

		expect(result).toMatchObject({ outcome: "didnt", stopped_at: 0, stop_reason: "expectation_failed" });
		expect(result.steps[0]?.expectation?.status).toBe("failed");
		expect(sent.filter((command) => command.method === "Input.dispatchMouseEvent" && command.params.type === "mousePressed")).toHaveLength(1);
	});

	it("labels an already-satisfied expectation as preexisting instead of success", async () => {
		const { cdp } = createFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
			ax({ nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 42, parentId: "1" }),
			ax({ nodeId: "3", role: "StaticText", name: "Saved", parentId: "1" }),
		]);
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);
		const result = await actResult(executor, {
			steps: [{ type: "click", ref: "e1", expect: { type: "text", text: "Saved" } }],
		});
		expect(result.outcome).toBe("unknown");
		expect(result.steps[0]?.expectation?.status).toBe("preexisting");
	});

	it("requires a supplied final expectation to be newly verified", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
					fake.setNodes([...BUTTON_TREE, ax({ nodeId: "3", role: "StaticText", name: "Saved", parentId: "1" })]);
				}
				return result;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);

		const result = await actResult(executor, {
			steps: [{ type: "click", ref: "e1", expect: { type: "text", text: "Saved" } }],
			expect: { type: "title", equals: "Page" },
		});

		expect(result.steps[0]?.expectation?.status).toBe("newly_verified");
		expect(result.final_expectation?.status).toBe("preexisting");
		expect(result.outcome).toBe("unknown");
	});

	it("stops a dependent list when navigation invalidates its refs", async () => {
		const fake = createFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
			ax({ nodeId: "2", role: "button", name: "Go", backendDOMNodeId: 42, parentId: "1" }),
			ax({ nodeId: "3", role: "button", name: "Later", backendDOMNodeId: 43, parentId: "1" }),
		]);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
					fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "TARGET-1" } }, sessionId: "session-1" });
				}
				return result;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);
		const result = await actResult(executor, { steps: [{ type: "click", ref: "e1" }, { type: "click", ref: "e2" }] });
		expect(result).toMatchObject({ outcome: "unknown", stopped_at: 0, stop_reason: "navigation" });
		expect(result.steps).toHaveLength(1);
	});

	it("keeps a navigation expectation verified while stopping later dispatch", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
					fake.setTargets([{ targetId: "TARGET-1", type: "page", title: "Next", url: "https://a.test/next" }]);
					fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "TARGET-1" } }, sessionId: "session-1" });
				}
				return result;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);

		const result = await actResult(executor, {
			steps: [{ type: "click", ref: "e1", expect: { type: "url", contains: "/next", changed: true } }],
			expect: { type: "url", contains: "/next", changed: true },
		});

		expect(result).toMatchObject({ outcome: "worked", stopped_at: 0, stop_reason: "navigation" });
		expect(result.steps[0]).toMatchObject({ outcome: "worked", expectation: { status: "newly_verified" } });
		expect(result.final_expectation?.status).toBe("newly_verified");
	});

	it("does not treat a final step skipped by navigation as completed", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const inner = fake.cdp as unknown as {
			send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>;
			pageTargets: () => Promise<Array<{ targetId: string; type: string; title: string; url: string }>>;
		};
		let released = false;
		let targetReadsAfterRelease = 0;
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") released = true;
				return result;
			},
			pageTargets: async () => {
				const targets = await inner.pageTargets();
				if (released && ++targetReadsAfterRelease === 8) {
					fake.setTargets([{ targetId: "TARGET-1", type: "page", title: "Next", url: "https://a.test/next" }]);
					fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "TARGET-1" } }, sessionId: "session-1" });
				}
				return targets;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);

		const result = await actResult(executor, {
			steps: [{ type: "click", ref: "e1" }, { type: "type", text: "must not run" }],
			expect: { type: "url", contains: "/next", changed: true },
		});

		expect(result).toMatchObject({ outcome: "unknown", stopped_at: 1, stop_reason: "navigation" });
		expect(result.steps[1]).toMatchObject({ outcome: "unknown", evidence: ["navigation detected before input delivery"] });
		expect(fake.sent.some((command) => command.method === "Input.insertText")).toBe(false);
	});

	it("stops after a dialog changes control flow", async () => {
		const fake = createFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
			ax({ nodeId: "2", role: "button", name: "Delete", backendDOMNodeId: 42, parentId: "1" }),
			ax({ nodeId: "3", role: "button", name: "Later", backendDOMNodeId: 43, parentId: "1" }),
		]);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
					fake.emit({ method: "Page.javascriptDialogOpening", params: { type: "confirm", message: "Delete?" }, sessionId: "session-1" });
				}
				return result;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);
		const result = await actResult(executor, { steps: [{ type: "click", ref: "e1" }, { type: "click", ref: "e2" }] });
		expect(result).toMatchObject({ stopped_at: 0, stop_reason: "dialog" });
		expect(result.steps).toHaveLength(1);
	});

	it("polls delayed postconditions and uses a fresh observation before each action", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		let released = false;
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased" && !released) {
					released = true;
					setTimeout(() => fake.setNodes([
						...BUTTON_TREE,
						ax({ nodeId: "3", role: "StaticText", name: "Saved", parentId: "1" }),
					]), 30);
				}
				return result;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);
		const result = await actResult(executor, {
			steps: [
				{ type: "click", ref: "e1", expect: { type: "text", text: "Saved" } },
				{ type: "wait", ms: 0, expect: { type: "text", text: "Saved" } },
			],
		});
		expect(result.outcome).toBe("unknown");
		expect(result.steps.map((step) => step.expectation?.status)).toEqual(["newly_verified", "preexisting"]);
	});

	it("does not satisfy accessible expectations from ignored nodes", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
					fake.setNodes([...BUTTON_TREE, ax({ nodeId: "3", ignored: true, role: "StaticText", name: "Saved", parentId: "1" })]);
				}
				return result;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);
		const textResult = await actResult(executor, {
			steps: [{ type: "click", ref: "e1", expect: { type: "text", text: "Saved" } }],
		});
		expect(textResult.steps[0]?.expectation?.status).toBe("failed");

		const roleResult = await actResult(executor, {
			steps: [{ type: "click", ref: "e1", expect: { type: "role_name", role: "StaticText", name: "Saved" } }],
		});
		expect(roleResult.steps[0]?.expectation?.status).toBe("failed");
	});

	it("stops when a post-action observation is unavailable", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		let failObservation = false;
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				if (method === "Accessibility.getFullAXTree" && failObservation) throw new Error("document replaced");
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") failObservation = true;
				return result;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);
		const result = await actResult(executor, {
			steps: [{ type: "click", ref: "e1", expect: { type: "text", text: "Saved" } }, { type: "type", text: "later" }],
		});
		expect(result).toMatchObject({ outcome: "unknown", stopped_at: 0, stop_reason: "control_flow" });
		expect(result.steps[0]?.expectation?.status).toBe("unverifiable");
		expect(result.successor.status).toBe("unavailable");
		expect(fake.sent.some((command) => command.method === "Input.insertText")).toBe(false);
	});

	it("returns an observed successor when dispatch fails after changing the page", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
					fake.setNodes([
						ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
						ax({ nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 42, parentId: "1" }),
						ax({ nodeId: "3", role: "StaticText", name: "Partially saved", parentId: "1" }),
					]);
					throw new Error("mouse release acknowledgement lost");
				}
				return result;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);

		const result = await actResult(executor, {
			steps: [{ type: "click", ref: "e1", expect: { type: "text", text: "Partially saved" } }],
		});

		expect(result).toMatchObject({ outcome: "unknown", stopped_at: 0, stop_reason: "action_failed" });
		expect(result.steps[0]).toMatchObject({ outcome: "unknown", expectation: { status: "newly_verified" } });
		expect(observedSuccessor(result).text).toContain("Partially saved");
		expect(observedSuccessor(result).diff.added).toContain('  StaticText "Partially saved"');
	});

	it("detects delayed navigation while polling a final expectation", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		let released = false;
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased" && !released) {
					released = true;
					setTimeout(() => fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "TARGET-1" } }, sessionId: "session-1" }), 20);
				}
				return result;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);

		const result = await actResult(executor, {
			steps: [{ type: "click", ref: "e1" }],
			expect: { type: "text", text: "Never appears" },
		});

		expect(result).toMatchObject({ outcome: "unknown", stopped_at: 1, stop_reason: "navigation" });
	});

	it("recollects the successor when navigation lands during the final boundary check", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const inner = fake.cdp as unknown as {
			send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>;
			pageTargets: () => Promise<Array<{ targetId: string; type: string; title: string; url: string }>>;
		};
		let released = false;
		let targetReadsAfterRelease = 0;
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") released = true;
				return result;
			},
			pageTargets: async () => {
				const targets = await inner.pageTargets();
				if (released && ++targetReadsAfterRelease === 8) {
					fake.setNodes([
						ax({ nodeId: "1", role: "RootWebArea", name: "New page", childIds: ["2"] }),
						ax({ nodeId: "2", role: "button", name: "Continue", backendDOMNodeId: 84, parentId: "1" }),
					]);
					fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "TARGET-1" } }, sessionId: "session-1" });
				}
				return targets;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);

		const result = await actResult(executor, { steps: [{ type: "click", ref: "e1" }] });

		expect(result).toMatchObject({ outcome: "unknown", stopped_at: 1, stop_reason: "navigation" });
		expect(observedSuccessor(result).text).toContain('button "Continue"');
	});

	it("detects delayed navigation and ignores unrelated target generations", async () => {
		const fake = createFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
			ax({ nodeId: "2", role: "button", name: "Go", backendDOMNodeId: 42, parentId: "1" }),
			ax({ nodeId: "3", role: "button", name: "Later", backendDOMNodeId: 43, parentId: "1" }),
		]);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		let released = false;
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased" && !released) {
					released = true;
					setTimeout(() => fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "TARGET-1" } }, sessionId: "session-1" }), 0);
				}
				return result;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);
		(executor as unknown as { generations: Map<string, number> }).generations.set("OTHER-TARGET", 1);
		const result = await actResult(executor, { steps: [{ type: "click", ref: "e1" }, { type: "click", ref: "e2" }] });
		expect(result).toMatchObject({ outcome: "unknown", stopped_at: 0, stop_reason: "navigation" });
		expect(result.steps).toHaveLength(1);
	});

	it("continues when a lazy iframe appears without invalidating existing refs", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
					fake.setNodes([
						ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
						ax({ nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 42, parentId: "1" }),
						ax({ nodeId: "3", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
					]);
					fake.setIframeFrame(50, "FRAME-LAZY");
					fake.setFrameTree("FRAME-LAZY", [ax({ nodeId: "f1", role: "RootWebArea", name: "Lazy frame" })]);
				}
				return result;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);

		const result = await actResult(executor, {
			steps: [{ type: "click", ref: "e1" }, { type: "type", text: "continued" }],
		});

		expect(result.stop_reason).toBeUndefined();
		expect(result.steps).toHaveLength(2);
		expect(fake.sent).toContainEqual(expect.objectContaining({ method: "Input.insertText", params: { text: "continued" } }));
	});

	it("stops when an action opens a new page target", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
					fake.setTargets([
						{ targetId: "TARGET-1", type: "page", title: "Page", url: "https://a.test/" },
						{ targetId: "TARGET-2", type: "page", title: "Popup", url: "https://b.test/" },
					]);
				}
				return result;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);
		const result = await actResult(executor, { steps: [{ type: "click", ref: "e1" }, { type: "type", text: "later" }] });
		expect(result).toMatchObject({ stopped_at: 0, stop_reason: "control_flow" });
		expect(result.steps).toHaveLength(1);
	});

	it("keeps the successor diff complete when text presentation is filtered", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
					fake.setNodes([
						ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
						ax({ nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 42, parentId: "1" }),
						ax({ nodeId: "3", role: "StaticText", name: "Saved", parentId: "1" }),
					]);
				}
				return result;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);
		const result = await actResult(executor, { steps: [{ type: "click", ref: "e1" }], successor: { filter: "interactive" } });
		expect(observedSuccessor(result).text).not.toContain("Saved");
		expect(observedSuccessor(result).diff.added).toContain('  StaticText "Saved"');
	});

	it("conservatively heals ref expectations after an unambiguous rerender", async () => {
		const fake = createFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "checkbox", name: "Ready", properties: [{ name: "checked", value: false }], backendDOMNodeId: 42, parentId: "1" }),
		]);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
					fake.setNodes([
						ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["9"] }),
						ax({ nodeId: "9", role: "checkbox", name: "Ready", properties: [{ name: "checked", value: true }], backendDOMNodeId: 99, parentId: "1" }),
					]);
				}
				return result;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);
		const result = await actResult(executor, {
			steps: [{ type: "click", ref: "e1", expect: { type: "ref", ref: "e1", checked: true } }],
		});
		expect(result.outcome).toBe("worked");
		expect(result.steps[0]?.expectation?.status).toBe("newly_verified");
	});

	it("evaluates ref value/state and final URL, title, and disappearance expectations", async () => {
		const fake = createFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
			ax({
				nodeId: "2",
				role: "option",
				name: "Choice",
				value: "old",
				properties: [{ name: "selected", value: false }, { name: "expanded", value: false }],
				backendDOMNodeId: 42,
				parentId: "1",
			}),
			ax({ nodeId: "3", role: "StaticText", name: "Loading", parentId: "1" }),
		]);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
					fake.setNodes([
						ax({ nodeId: "1", role: "RootWebArea", name: "Done", childIds: ["2"] }),
						ax({
							nodeId: "2",
							role: "option",
							name: "Choice",
							value: "new",
							properties: [{ name: "selected", value: true }, { name: "expanded", value: true }],
							backendDOMNodeId: 42,
							parentId: "1",
						}),
					]);
					fake.setTargets([{ targetId: "TARGET-1", type: "page", title: "Done", url: "https://a.test/saved" }]);
				}
				return result;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);
		const result = await actResult(executor, {
			steps: [{
				type: "click",
				ref: "e1",
				expect: { all: [
					{ type: "ref", ref: "e1", value: "new", selected: true, expanded: true },
					{ type: "text", text: "Loading", exists: false },
				] },
			}],
			expect: { all: [
				{ type: "url", contains: "/saved", changed: true },
				{ type: "title", equals: "Done", changed: true },
			] },
		});
		expect(result.outcome).toBe("worked");
		expect(result.steps[0]?.expectation?.status).toBe("newly_verified");
		expect(result.final_expectation?.status).toBe("newly_verified");
		expect(observedSuccessor(result).diff.url?.after).toBe("https://a.test/saved");
	});

	it("does not mark a page-target iframe stub as incomplete", async () => {
		const fake = createFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
			ax({ nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 42, parentId: "1" }),
			ax({ nodeId: "3", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		]);
		fake.setIframeFrame(50, "TARGET-1");
		const executor = new BrowserExecutor(fake.cdp);
		await snapshotText(executor);

		const result = await actResult(executor, {
			steps: [{ type: "click", ref: "e1", expect: { type: "text", text: "Missing", exists: false } }],
		});

		expect(result.stop_reason).toBeUndefined();
		expect(result.steps[0]?.expectation?.status).toBe("preexisting");
	});

	it("does not verify absence against an incomplete nested iframe observation", async () => {
		const fake = createFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
			ax({ nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 42, parentId: "1" }),
			ax({ nodeId: "3", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		]);
		fake.setIframeFrame(50, "FRAME-1");
		fake.setFrameTree("FRAME-1", [
			ax({ nodeId: "f1", role: "RootWebArea", name: "First frame", childIds: ["f2"] }),
			ax({ nodeId: "f2", role: "Iframe", backendDOMNodeId: 60, parentId: "f1" }),
		]);
		const executor = new BrowserExecutor(fake.cdp);
		await snapshotText(executor);

		const result = await actResult(executor, {
			steps: [{ type: "click", ref: "e1", expect: { type: "text", text: "Missing", exists: false } }],
		});

		expect(result).toMatchObject({ outcome: "unknown", stopped_at: 0, stop_reason: "control_flow" });
		expect(result.steps[0]?.expectation?.status).toBe("unverifiable");
	});

	it("keeps ambiguous ref replacement unverifiable and stops", async () => {
		const fake = createFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "checkbox", name: "Ready", backendDOMNodeId: 42, parentId: "1" }),
		]);
		const inner = fake.cdp as unknown as { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> };
		const wrapped = {
			...fake.cdp,
			send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
				const result = await inner.send(method, params, sessionId);
				if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
					fake.setNodes([
						ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["8", "9"] }),
						ax({ nodeId: "8", role: "checkbox", name: "Ready", backendDOMNodeId: 98, parentId: "1" }),
						ax({ nodeId: "9", role: "checkbox", name: "Ready", properties: [{ name: "checked", value: true }], backendDOMNodeId: 99, parentId: "1" }),
					]);
				}
				return result;
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(wrapped);
		await snapshotText(executor);
		const result = await actResult(executor, {
			steps: [{ type: "click", ref: "e1", expect: { type: "ref", ref: "e1", checked: true } }, { type: "type", text: "later" }],
		});
		expect(result).toMatchObject({ outcome: "unknown", stopped_at: 0, stop_reason: "control_flow" });
		expect(result.steps[0]?.expectation?.status).toBe("unverifiable");
	});

	it("sets the final expectation stop boundary after all actions", async () => {
		const executor = new BrowserExecutor(createFakeCdp(BUTTON_TREE).cdp);
		await snapshotText(executor);
		const result = await actResult(executor, {
			steps: [{ type: "click", ref: "e1" }],
			expect: { type: "title", equals: "Missing" },
		});
		expect(result).toMatchObject({ outcome: "didnt", stopped_at: 1, stop_reason: "expectation_failed" });
		expect(result.final_expectation?.status).toBe("failed");
	});

	it("returns a stale-ref outcome instead of dispatching later actions", async () => {
		const { cdp, emit, sent } = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);
		emit({ method: "Page.frameNavigated", params: { frame: { id: "TARGET-1" } }, sessionId: "session-1" });
		const result = await actResult(executor, { steps: [{ type: "click", ref: "e1" }, { type: "type", text: "later" }] });
		expect(result).toMatchObject({ outcome: "didnt", stopped_at: 0, stop_reason: "stale_ref" });
		expect(sent.some((command) => command.method === "Input.insertText")).toBe(false);
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

	it("recursively stitches nested iframe subtrees and invalidates descendants with their parent", async () => {
		const fake = createFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		]);
		fake.setIframeFrame(50, "FRAME-1");
		fake.setFrameTree("FRAME-1", [
			ax({ nodeId: "f1", role: "RootWebArea", name: "First", childIds: ["f2"] }),
			ax({ nodeId: "f2", role: "Iframe", backendDOMNodeId: 60, parentId: "f1" }),
		]);
		fake.setIframeFrame(60, "FRAME-2");
		fake.setFrameTree("FRAME-2", [
			ax({ nodeId: "g1", role: "RootWebArea", name: "Second", childIds: ["g2"] }),
			ax({ nodeId: "g2", role: "button", name: "Deep", backendDOMNodeId: 70, parentId: "g1" }),
		]);
		const executor = new BrowserExecutor(fake.cdp);

		const text = await snapshotText(executor);

		expect(text).toContain('button "Deep" [e3]');
		await executor.execute({ type: "browser_click", ref: "e3" } as CuaBrowserAction);
		expect(fake.sent).toContainEqual(expect.objectContaining({ method: "DOM.getBoxModel", params: { backendNodeId: 70 } }));

		fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "FRAME-1", parentId: "TARGET-1" } }, sessionId: "session-1" });
		await expect(executor.execute({ type: "browser_click", ref: "e3" } as CuaBrowserAction)).rejects.toThrow(/stale/);
		await executor.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction);

		fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "TARGET-1" } }, sessionId: "session-1" });
		expect((executor as unknown as { frameParents: Map<string, string> }).frameParents.size).toBe(0);
		expect((executor as unknown as { generations: Map<string, number> }).generations.has("FRAME-1")).toBe(false);
	});

	it("invalidates nested same-process refs when their OOPIF session navigates", async () => {
		const fake = createFakeCdp(OOPIF_PAGE);
		fake.setIframeFrame(50, "FRAME-OOP");
		fake.addAutoAttachFrame({ targetId: "FRAME-OOP", sessionId: "session-oop" });
		fake.setSessionTree("session-oop", [
			ax({ nodeId: "f1", role: "RootWebArea", name: "Widget", childIds: ["f2"] }),
			ax({ nodeId: "f2", role: "Iframe", backendDOMNodeId: 60, parentId: "f1" }),
		]);
		fake.setIframeFrame(60, "FRAME-INNER");
		fake.setFrameTree("FRAME-INNER", [
			ax({ nodeId: "g1", role: "RootWebArea", name: "Inner", childIds: ["g2"] }),
			ax({ nodeId: "g2", role: "button", name: "Deep", backendDOMNodeId: 80, parentId: "g1" }),
		]);
		const executor = new BrowserExecutor(fake.cdp);
		const text = await snapshotText(executor);
		expect(text).toContain('button "Deep" [e4]');

		fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "FRAME-INNER", parentId: "FRAME-OOP" } }, sessionId: "session-oop" });

		await expect(executor.execute({ type: "browser_click", ref: "e4" } as CuaBrowserAction)).rejects.toThrow(/stale/);
		await executor.execute({ type: "browser_click", ref: "e3" } as CuaBrowserAction);
		await executor.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction);
	});

	it("rebinds imported nested OOPIF refs only through the owning OOPIF session", async () => {
		const fake = createFakeCdp(OOPIF_PAGE);
		const configureAutoAttach = () => fake.addAutoAttachFrame({ targetId: "FRAME-OOP", sessionId: "session-oop" });
		fake.setIframeFrame(50, "FRAME-OOP");
		configureAutoAttach();
		fake.setSessionTree("session-oop", [
			ax({ nodeId: "f1", role: "RootWebArea", name: "Widget", childIds: ["f2"] }),
			ax({ nodeId: "f2", role: "Iframe", backendDOMNodeId: 60, parentId: "f1" }),
		]);
		fake.setIframeFrame(60, "FRAME-INNER");
		fake.setFrameTree("FRAME-INNER", [
			ax({ nodeId: "g1", role: "RootWebArea", name: "Inner", childIds: ["g2"] }),
			ax({ nodeId: "g2", role: "button", name: "Deep", backendDOMNodeId: 80, parentId: "g1" }),
		]);
		const first = new BrowserExecutor(fake.cdp);
		const text = await snapshotText(first);
		expect(text).toContain('button "Deep" [e4]');
		const state = first.exportRefState();
		first.close();

		configureAutoAttach();
		const resumed = new BrowserExecutor(fake.cdp);
		resumed.importRefState(state);
		await resumed.execute({ type: "browser_click", ref: "e4" } as CuaBrowserAction);

		const resolved = fake.sent.filter((command) => command.method === "DOM.getBoxModel" && command.params.backendNodeId === 80).at(-1);
		expect(resolved?.sessionId).toBe("session-oop");

		const resolvedCount = fake.sent.filter((command) => command.method === "DOM.getBoxModel" && command.params.backendNodeId === 80).length;
		const unavailable = new BrowserExecutor(fake.cdp);
		unavailable.importRefState(state);
		await expect(unavailable.execute({ type: "browser_click", ref: "e4" } as CuaBrowserAction)).rejects.toThrow(/owning frame session/);
		expect(fake.sent.filter((command) => command.method === "DOM.getBoxModel" && command.params.backendNodeId === 80)).toHaveLength(resolvedCount);

		configureAutoAttach();
		const scrolling = new BrowserExecutor(fake.cdp);
		scrolling.importRefState(state);
		await scrolling.execute({ type: "browser_scroll_to", ref: "e4" } as CuaBrowserAction);
		const scrolled = fake.sent.filter((command) => command.method === "DOM.scrollIntoViewIfNeeded" && command.params.backendNodeId === 80).at(-1);
		expect(scrolled?.sessionId).toBe("session-oop");

		configureAutoAttach();
		const ancestry = new BrowserExecutor(fake.cdp);
		ancestry.importRefState(state);
		await ancestry.execute({ type: "browser_click", ref: "e1" } as CuaBrowserAction);
		fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "FRAME-OOP", parentId: "TARGET-1" } }, sessionId: "session-1" });
		await expect(ancestry.execute({ type: "browser_click", ref: "e4" } as CuaBrowserAction)).rejects.toThrow(/stale/);
	});

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

	it("keeps an OOPIF root ref valid when an unrelated nested frame navigates", async () => {
		const { cdp, emit } = setupOopif();
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);

		emit({ method: "Page.frameNavigated", params: { frame: { id: "FRAME-INNER", parentId: "FRAME-OOP" } }, sessionId: "session-oop" });
		await expect(executor.execute({ type: "browser_click", ref: "e3" } as CuaBrowserAction)).resolves.toEqual([]);
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

	it("rebinds legacy same-process iframe refs to the page session", async () => {
		const firstFake = createFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		]);
		firstFake.setIframeFrame(50, "FRAME-SP");
		firstFake.setFrameTree("FRAME-SP", [
			ax({ nodeId: "f1", role: "RootWebArea", name: "Frame", childIds: ["f2"] }),
			ax({ nodeId: "f2", role: "button", name: "Inside", backendDOMNodeId: 60, parentId: "f1" }),
		]);
		const first = new BrowserExecutor(firstFake.cdp);
		await snapshotText(first);
		const state = first.exportRefState();
		for (const [, entry] of state.refs) delete entry.sessionTargetId;
		delete state.frameParents;

		const secondFake = createFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		]);
		secondFake.setIframeFrame(50, "FRAME-SP");
		secondFake.setFrameTree("FRAME-SP", [
			ax({ nodeId: "f1", role: "RootWebArea", name: "Frame", childIds: ["f2"] }),
			ax({ nodeId: "f2", role: "button", name: "Inside", backendDOMNodeId: 60, parentId: "f1" }),
		]);
		const second = new BrowserExecutor(secondFake.cdp);
		second.importRefState(state);
		await second.execute({ type: "browser_click", ref: "e2" } as CuaBrowserAction);

		const resolved = secondFake.sent.find((command) => command.method === "DOM.getBoxModel" && command.params.backendNodeId === 60);
		expect(resolved?.sessionId).toBe("session-1");
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
