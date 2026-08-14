import { describe, expect, it, vi } from "vitest";
import { type BrowserAction, type KernelBrowser, loop, LoopExecutionResources } from "../src/index";
import type Kernel from "@onkernel/sdk";
import type { BrowserExecutor } from "../src/core/translator/browser";
import type { BatchReadResult } from "../src/core/translator/types";

const browser = {
	session_id: "browser_123",
	cdp_ws_url: "wss://example.test/cdp",
	viewport: { width: 1440, height: 900 },
} as KernelBrowser;

function setup(options: { failBatch?: boolean; failPlaywright?: boolean; successfulAct?: boolean } = {}) {
	const batches: unknown[][] = [];
	const batch = vi.fn(async (_sessionId: string, input: { actions: unknown[] }) => {
		batches.push(input.actions);
		if (options.failBatch) throw new Error("kernel batch failed");
	});
	let captures = 0;
	const captureScreenshot = vi.fn(async () => new Response(Buffer.from(`os-${++captures}`)));
	const client = {
		browsers: {
			computer: {
				batch,
				captureScreenshot,
				getMousePosition: async () => ({ x: 0, y: 0 }),
				readClipboard: async () => ({ text: "https://example.test" }),
			},
			playwright: { execute: async () => options.failPlaywright
				? { success: false, error: "page evaluation failed", stderr: "trace" }
				: { success: true, result: "ok" } },
		},
	} as unknown as Kernel;
	const executed: BrowserAction[] = [];
	const browserScreenshot = vi.fn(async () => ({ data: Buffer.from("viewport"), mimeType: "image/png" }));
	const browserExecutor = {
		async execute(action: BrowserAction): Promise<BatchReadResult[]> {
			executed.push(action);
			if (action.type === "browser_snapshot") return [{ type: "browser_text", label: "snapshot", text: "button Save [e1]" }];
			if (action.type === "browser_text") return [{ type: "browser_text", label: "text", text: "Saved" }];
			if (action.type === "browser_navigate") return [{ type: "browser_text", label: "navigate", text: "Navigated" }];
			if (action.type === "browser_screenshot") return [{ type: "screenshot", data: Buffer.from("browser"), mimeType: "image/png" }];
			if (action.type === "browser_wait_for") return [{
				type: "browser_wait_for",
				result: {
					status: "timed_out",
					evidence: "failed",
					initial: { truth: false, details: [] },
					final: { truth: false, details: [] },
					elapsed_ms: 20,
					details: [],
				},
			}];
			if (action.type === "browser_act") return [{
				type: "browser_act",
				result: options.successfulAct ? {
					outcome: "worked",
					steps: [],
					stop_reason: "navigation",
					successor: { status: "unavailable", error: "page navigated" },
				} : {
					outcome: "didnt",
					steps: [],
					stopped_at: 0,
					stop_reason: "expectation_failed",
					successor: { status: "unavailable", error: "expectation failed" },
				},
			}];
			return [];
		},
		screenshot: browserScreenshot,
		close() {},
	} as unknown as BrowserExecutor;
	const createBrowserExecutor = vi.fn(() => browserExecutor);
	const resources = new LoopExecutionResources({ browser, client, createBrowserExecutor });
	return { resources, batches, executed, createBrowserExecutor, captureScreenshot, browserScreenshot };
}

describe("LoopExecutionResources results and batch boundaries", () => {
	it("flushes computer writes around ordered reads without adding actions", async () => {
		const { resources, batches } = setup();
		const spec = loop.tools.computer.batch({ actions: ["click", "screenshot", "keypress"] });
		const tool = resources.materialize(spec);
		const result = await tool.execute("batch", { actions: [
			{ action: "click", x: 10, y: 20 },
			{ action: "screenshot" },
			{ action: "keypress", keys: ["Enter"] },
		] });
		expect(batches).toHaveLength(2);
		expect(result.content).toEqual([{ type: "image", data: Buffer.from("os-1").toString("base64"), mimeType: "image/png" }]);
		expect(result.details).toMatchObject({
			statusText: "Actions executed successfully.",
			readResults: [{ type: "screenshot", bytes: 4 }],
		});
	});

	it("retains completed textual reads, replaces error images, and records skipped actions", async () => {
		const { resources } = setup({ failBatch: true });
		const spec = loop.tools.computer.batch({ actions: ["screenshot", "click", "url", "cursor_position"] });
		const tool = resources.materialize(spec);
		const result = await tool.execute("batch", { actions: [
			{ action: "screenshot" },
			{ action: "click", x: 10, y: 20 },
			{ action: "url" },
			{ action: "cursor_position" },
		] });
		expect(result.content).toEqual([
			{ type: "text", text: "[screenshot captured: 4 bytes]" },
			expect.objectContaining({ type: "text", text: expect.stringContaining("kernel batch failed") }),
		]);
		expect(result.details).toMatchObject({ isError: true, failedActionIndex: 2, skippedActions: 1 });
	});

	it("keeps browser_batch mechanical and returns ordered reads without a fallback image", async () => {
		const { resources, executed } = setup();
		const spec = loop.tools.browser.batch({ actions: ["snapshot", "click", "text"] });
		const tool = resources.materialize(spec);
		const result = await tool.execute("browser-batch", { actions: [
			{ action: "snapshot" },
			{ action: "click", ref: "e1" },
			{ action: "text" },
		] });
		expect(executed.map((action) => action.type)).toEqual(["browser_snapshot", "browser_click", "browser_text"]);
		expect(result.content).toEqual([
			{ type: "text", text: "button Save [e1]" },
			{ type: "text", text: "Saved" },
		]);
	});

	it("replaces prior screenshots when a semantic browser batch condition fails", async () => {
		const { resources } = setup();
		const spec = loop.tools.browser.batch({ actions: ["screenshot", "wait_for"] });
		const result = await resources.materialize(spec).execute("browser-batch", { actions: [
			{ action: "screenshot" },
			{ action: "wait_for", expect: { type: "text", text: "Ready" } },
		] });
		expect(result.content).toEqual([
			{ type: "text", text: "[screenshot captured: 7 bytes]" },
			{ type: "text", text: "wait_for: timed_out/failed after 20ms" },
			{ type: "text", text: "Action 1 stopped at an unsatisfied semantic browser condition." },
		]);
		expect(result.details).toMatchObject({ isError: true, failedActionIndex: 1 });
	});

	it.each([
		["browser_wait_for", loop.tools.browser.waitFor(), { expect: { type: "text", text: "Ready" } }],
		["browser_act", loop.tools.browser.act(), { steps: [{ type: "wait" }] }],
	] as const)("marks a failed standalone %s result as an error", async (_name, spec, input) => {
		const { resources } = setup();
		const result = await resources.materialize(spec).execute("standalone", input);
		expect(result.details).toMatchObject({
			statusText: "Actions stopped before completion.",
			isError: true,
			failedActionIndex: 0,
		});
		expect(result.content).toContainEqual({
			type: "text",
			text: "Action 0 stopped at an unsatisfied semantic browser condition.",
		});
	});

	it("keeps a worked browser_act navigation boundary successful", async () => {
		const { resources } = setup({ successfulAct: true });
		const result = await resources.materialize(loop.tools.browser.act()).execute("act", {
			steps: [{ type: "click", x: 10, y: 20 }],
		});
		expect(result.details).toMatchObject({ statusText: "Actions executed successfully." });
		expect(result.details).not.toHaveProperty("isError");
		expect(result.content).not.toContainEqual(expect.objectContaining({ text: expect.stringContaining("unsatisfied") }));
	});

	it("shares one lazy browser executor across independently materialized tools", async () => {
		const { resources, createBrowserExecutor } = setup();
		await resources.materialize(loop.tools.browser.snapshot()).execute("snapshot", {});
		await resources.materialize(loop.tools.browser.click()).execute("click", { ref: "e1" });
		expect(createBrowserExecutor).toHaveBeenCalledTimes(1);
	});

	it("returns status text for writes without capturing screenshots", async () => {
		const { resources, captureScreenshot, browserScreenshot } = setup();
		const click = await resources.materialize(loop.tools.browser.click()).execute("click", { ref: "e1" });
		expect(click.content).toEqual([{ type: "text", text: "Actions executed successfully." }]);

		const navigate = await resources.materialize(loop.tools.browser.navigate()).execute("navigate", { url: "https://example.test" });
		expect(navigate.content).toEqual([{ type: "text", text: "Navigated" }]);
		expect(captureScreenshot).not.toHaveBeenCalled();
		expect(browserScreenshot).not.toHaveBeenCalled();
	});

	it("keeps Playwright execution failures as model-readable content", async () => {
		const { resources } = setup({ failPlaywright: true });
		const result = await resources.materialize(loop.tools.playwright()).execute("playwright", { code: "throw new Error('boom')" });
		expect(result.content).toEqual([
			{ type: "text", text: "stderr:\ntrace" },
			{ type: "text", text: "error: page evaluation failed" },
		]);
		expect(result.details).toMatchObject({
			statusText: "Playwright execution failed: page evaluation failed",
			error: "page evaluation failed",
			stderr: "trace",
		});
		expect(result.details).not.toHaveProperty("isError");
	});

	it("returns status text for provider-native writes without capturing a screenshot", async () => {
		const { resources, captureScreenshot } = setup();
		const spec = loop.providers.google.toolsets.browser().find((tool) => tool.name === "click")!;
		const result = await resources.materialize(spec).execute("click", { x: 100, y: 200 });
		expect(result.content).toEqual([{ type: "text", text: "Actions executed successfully." }]);
		expect(captureScreenshot).not.toHaveBeenCalled();
	});

	it("materializes each spec exactly once per resource pool", () => {
		const { resources } = setup();
		const spec = loop.tools.browser.snapshot();
		const first = resources.materialize(spec);
		expect(resources.materialize(spec)).toBe(first);
		// A freshly created spec object is conservatively a different implementation.
		expect(resources.materialize(loop.tools.browser.snapshot())).not.toBe(first);
	});
});
