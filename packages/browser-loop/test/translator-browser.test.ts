import type Kernel from "@onkernel/sdk";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { BrowserAction } from "../src/index";
import { BrowserExecutor } from "../src/core/translator/browser";
import type { BrowserRefState } from "../src/core/translator/browser-ref-lifecycle";
import { type CdpConnection, CdpProtocolError } from "../src/core/translator/cdp";
import { formatBrowserActResult } from "../src/core/browser-result-format";
import { type BrowserActRuntime, runBrowserAct } from "../src/core/translator/browser-act";
import { evaluateBrowserExpectation, waitForBrowserExpectation } from "../src/core/translator/browser-wait";
import {
	type BrowserObservation,
	type BrowserPresentation,
	diffObservations,
} from "../src/core/translator/browser-observation";
import { InternalComputerTranslator, type KernelBrowser } from "../src/core/translator/translator";
import type {
	BatchReadResult,
	BrowserActResult,
	BrowserWaitForResult,
} from "../src/core/translator/types";

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
	const executed: BrowserAction[] = [];
	const executor = {
		execute: async (action: BrowserAction): Promise<BatchReadResult[]> => {
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

describe("browser_act orchestration", () => {
	const observation = (name: string, epoch = 0): BrowserObservation => ({
		targetId: "target-1", navigationEpoch: epoch, url: `https://example.test/${name}`, title: name,
		generations: new Map([["target-1", epoch]]), stitches: new Map(), incompleteFrames: [], revision: epoch,
		tree: { byId: new Map(), roots: [], ctx: {} as never },
	});
	const waitResult = (evidence: BrowserWaitForResult["evidence"]): BrowserWaitForResult => ({
		status: evidence === "failed" ? "timed_out" : evidence === "unverifiable" ? "unverifiable" : "satisfied",
		evidence,
		initial: { truth: evidence === "preexisting" ? true : false, details: ["before"] },
		final: { truth: evidence === "newly_verified" || evidence === "preexisting", details: ["after"] },
		elapsed_ms: 1, details: ["initial: before", "final: after"],
	});
	function runtime(states: BrowserObservation[], waits: BrowserWaitForResult[] = [], options: { dispatchError?: Error; targets?: string[][]; dialogAfterDispatch?: boolean; failObservationAt?: number | number[]; wait?: BrowserActRuntime["wait"] } = {}): BrowserActRuntime & { dispatched: string[] } {
		let read = 0;
		let targetRead = 0;
		let dialogs = 0;
		const dispatched: string[] = [];
		return {
			dispatched,
			observe: async () => {
				const failures = Array.isArray(options.failObservationAt) ? options.failObservationAt : [options.failObservationAt];
				if (failures.includes(read)) { read += 1; throw new Error("observation unavailable"); }
				const state = states[Math.min(read++, states.length - 1)];
				if (!state) throw new Error("observation unavailable");
				return state;
			},
			targetIds: async () => options.targets?.[Math.min(targetRead++, options.targets.length - 1)] ?? ["target-1"],
			dialogCount: () => dialogs,
			liveGeneration: (frame) => states[Math.max(0, Math.min(read - 1, states.length - 1))]?.generations.get(frame) ?? 0,
			liveNavigationEpoch: () => states[Math.max(0, Math.min(read - 1, states.length - 1))]?.navigationEpoch ?? 0,
			executeStep: async (step) => {
				dispatched.push(step.type);
				if (options.dialogAfterDispatch) dialogs += 1;
				if (options.dispatchError) throw options.dispatchError;
			},
			wait: options.wait ?? (async () => waits.shift() ?? waitResult("newly_verified")),
			evaluate: (expect, state, baseline) => evaluateBrowserExpectation(expect, state, baseline, () => ({ truth: undefined, details: ["ref unavailable"] })),
			present: (state): BrowserPresentation => ({ observation: state, cacheKey: "", shape: state.title, lines: [{ text: `RootWebArea ${state.title} [\u0000]`, ctx: {} as never }] }),
			render: (presentation) => presentation.shape,
		};
	}

	it.each([
		["newly_verified", "worked", undefined, "not_matched", "matched"],
		["preexisting", "unknown", "control_flow", "matched", "matched"],
		["failed", "didnt", "expectation_failed", "not_matched", "not_matched"],
		["unverifiable", "unknown", "control_flow", "not_matched", "unknown"],
	] as const)("maps %s evidence to an honest %s outcome", async (evidence, outcome, stopReason, before, after) => {
		const states = [observation("before"), observation("before"), observation("after"), observation("after")];
		const result = await runBrowserAct({ type: "browser_act", steps: [{ type: "click", ref: "e1", expect: { type: "text", text: "Done" } }] }, runtime(states, [waitResult(evidence)]));
		expect(result).toMatchObject({ outcome, steps: [{ outcome, expectation: { status: evidence, before, after } }], ...(stopReason ? { stop_reason: stopReason } : {}) });
	});

	it("uses a newly verified plan expectation to prove otherwise unverified steps", async () => {
		const result = await runBrowserAct({
			type: "browser_act",
			steps: [{ type: "wait" }],
			expect: { type: "url", contains: "after" },
		}, runtime([
			observation("before"), observation("before"), observation("after"), observation("after"),
		], [waitResult("newly_verified")]));
		expect(result).toMatchObject({
			outcome: "worked",
			steps: [{ outcome: "unknown" }],
			final_expectation: { status: "newly_verified", before: "not_matched", after: "matched" },
		});
	});

	it("does not claim that a preexisting plan condition proves unverified steps worked", async () => {
		const result = await runBrowserAct({
			type: "browser_act",
			steps: [{ type: "wait" }],
			expect: { type: "url", contains: "before" },
		}, runtime([
			observation("before"), observation("before"), observation("before"), observation("before"),
		], [waitResult("preexisting")]));
		expect(result).toMatchObject({
			outcome: "unknown",
			steps: [{ outcome: "unknown" }],
			final_expectation: { status: "preexisting", before: "matched", after: "matched" },
		});
	});

	it("checks a preexisting condition after input before stopping dependent steps", async () => {
		let tick = 0;
		const after = observation("after");
		const wait: BrowserActRuntime["wait"] = (expect, baseline, targetId) => waitForBrowserExpectation({
			selectTarget: async () => targetId,
			observeTarget: async () => after,
			dialogCount: () => 0,
			targetExists: async () => true,
			liveGeneration: () => 0,
			liveNavigationEpoch: () => 0,
			resolveRef: () => ({ truth: undefined, details: [] }),
			now: () => tick,
			delay: async (ms) => { tick += ms; },
		}, { expect, baseline, targetId, timeoutMs: 2, pollMs: 1 });
		const rt = runtime([observation("before"), observation("before"), after, after], [], { wait });
		const result = await runBrowserAct({ type: "browser_act", steps: [
			{ type: "click", ref: "e1", expect: { type: "url", contains: "before" } },
			{ type: "type", text: "no" },
		] }, rt);
		expect(result).toMatchObject({ outcome: "didnt", stopped_at: 0, stop_reason: "expectation_failed", steps: [{ expectation: { status: "failed", before: "matched", after: "not_matched" } }] });
		expect(rt.dispatched).toEqual(["click"]);
	});

	it("does not dispatch dependent steps after a preexisting expectation", async () => {
		const rt = runtime([observation("before"), observation("before"), observation("after"), observation("after")], [waitResult("preexisting")]);
		const result = await runBrowserAct({ type: "browser_act", steps: [{ type: "click", ref: "e1", expect: { type: "text", text: "Done" } }, { type: "type", text: "no" }] }, rt);
		expect(result).toMatchObject({ outcome: "unknown", stopped_at: 0, stop_reason: "control_flow" });
		expect(rt.dispatched).toEqual(["click"]);
	});

	it("does not dispatch later steps after a failed expectation", async () => {
		const rt = runtime([observation("before"), observation("before"), observation("after"), observation("after")], [waitResult("failed")]);
		const result = await runBrowserAct({ type: "browser_act", steps: [{ type: "click", ref: "e1", expect: { type: "text", text: "Missing" } }, { type: "type", text: "no" }] }, rt);
		expect(result).toMatchObject({ outcome: "didnt", stopped_at: 0, stop_reason: "expectation_failed", successor: { status: "observed" } });
		expect(rt.dispatched).toEqual(["click"]);
	});

	it("bounds action dispatch and its expectation by the step timeout", async () => {
		const actionRuntime = runtime([observation("before"), observation("before"), observation("after")]);
		actionRuntime.executeStep = async (step, _tabId, signal) => {
			actionRuntime.dispatched.push(step.type);
			await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
		};
		const actionResult = await runBrowserAct({
			type: "browser_act",
			timeout_ms: 100,
			steps: [{ type: "click", ref: "e1", timeout_ms: 5 }, { type: "type", text: "no" }],
		}, actionRuntime);
		expect(actionResult).toMatchObject({ outcome: "unknown", stopped_at: 0, stop_reason: "step_timeout", successor: { status: "observed" } });
		expect(actionRuntime.dispatched).toEqual(["click"]);

		const expectationRuntime = runtime(
			[observation("before"), observation("before"), observation("after")],
			[],
			{ wait: async () => new Promise<BrowserWaitForResult>(() => {}) },
		);
		const expectationResult = await runBrowserAct({
			type: "browser_act",
			timeout_ms: 100,
			steps: [{ type: "click", ref: "e1", timeout_ms: 5, expect: { type: "text", text: "Done" } }],
		}, expectationRuntime);
		expect(expectationResult).toMatchObject({ outcome: "unknown", stopped_at: 0, stop_reason: "step_timeout", successor: { status: "observed" } });
	});

	it("settles in-flight input before observing a successor after timeout", async () => {
		const events: string[] = [];
		const rt = runtime([observation("before"), observation("before"), observation("after")]);
		const observe = rt.observe;
		rt.observe = async (tabId) => {
			if (events.includes("started")) events.push(events.includes("settled") ? "observed settled" : "observed in-flight");
			return observe(tabId);
		};
		rt.executeStep = async (step, _tabId, signal) => {
			rt.dispatched.push(step.type);
			events.push("started");
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
				events.push("aborted");
				setTimeout(() => { events.push("settled"); resolve(); }, 5);
			}, { once: true }));
		};

		const result = await runBrowserAct({
			type: "browser_act",
			timeout_ms: 100,
			steps: [{ type: "click", ref: "e1", timeout_ms: 5 }],
		}, rt);

		expect(result).toMatchObject({ stop_reason: "step_timeout", successor: { status: "observed" } });
		expect(events).toEqual(["started", "aborted", "settled", "observed settled"]);
	});

	it("uses the parent timeout as one deadline across steps and the final expectation", async () => {
		const executionRuntime = runtime([observation("before"), observation("before")]);
		executionRuntime.executeStep = async (step, _tabId, signal) => {
			executionRuntime.dispatched.push(step.type);
			await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
		};
		const executionResult = await runBrowserAct({
			type: "browser_act",
			timeout_ms: 5,
			steps: [{ type: "click", ref: "e1" }, { type: "type", text: "no" }],
		}, executionRuntime);
		expect(executionResult).toMatchObject({ outcome: "unknown", stopped_at: 0, stop_reason: "global_timeout", successor: { status: "unavailable" } });
		expect(executionRuntime.dispatched).toEqual(["click"]);

		const expectationRuntime = runtime(
			[observation("before"), observation("before"), observation("after")],
			[],
			{ wait: async () => new Promise<BrowserWaitForResult>(() => {}) },
		);
		const expectationResult = await runBrowserAct({
			type: "browser_act",
			timeout_ms: 5,
			steps: [{ type: "wait" }],
			expect: { type: "text", text: "Done" },
		}, expectationRuntime);
		expect(expectationResult).toMatchObject({ outcome: "unknown", stopped_at: 0, stop_reason: "global_timeout", final_expectation: { status: "unverifiable" }, successor: { status: "unavailable" } });
	});

	it("passes each effective deadline to semantic verification", async () => {
		const timeouts: number[] = [];
		const rt = runtime(
			[observation("before"), observation("before"), observation("after"), observation("after")],
			[],
			{ wait: async (_expect, _baseline, _target, _tab, timeoutMs) => {
				timeouts.push(timeoutMs ?? -1);
				return waitResult("newly_verified");
			} },
		);
		await runBrowserAct({
			type: "browser_act",
			timeout_ms: 100,
			steps: [{ type: "click", ref: "e1", timeout_ms: 20, expect: { type: "text", text: "Step done" } }],
			expect: { type: "text", text: "Plan done" },
		}, rt);
		expect(timeouts).toHaveLength(2);
		expect(timeouts[0]).toBeGreaterThan(0);
		expect(timeouts[0]).toBeLessThanOrEqual(20);
		expect(timeouts[1]).toBeGreaterThan(20);
		expect(timeouts[1]).toBeLessThanOrEqual(100);
	});

	it("stops on a stale ref without dispatching later steps", async () => {
		const rt = runtime([observation("before"), observation("before"), observation("successor")], [], { dispatchError: new Error("ref e1 is stale") });
		const result = await runBrowserAct({ type: "browser_act", steps: [{ type: "click", ref: "e1" }, { type: "type", text: "no" }] }, rt);
		expect(result).toMatchObject({ outcome: "didnt", stopped_at: 0, stop_reason: "stale_ref" });
		expect(rt.dispatched).toEqual(["click"]);
	});

	it.each([
		["navigation", [observation("before"), observation("before"), observation("after", 1), observation("after", 1)], {}, "navigation"],
		["dialog", [observation("before"), observation("before"), observation("after"), observation("after")], { dialogAfterDispatch: true }, "dialog"],
		["target", [observation("before"), observation("before"), observation("after"), observation("after")], { targets: [["target-1"], ["target-1"], ["target-1", "target-2"]] }, "control_flow"],
	] as const)("stops the dependent list at a %s boundary", async (_name, states, options, reason) => {
		const rt = runtime([...states], [], options);
		const result = await runBrowserAct({ type: "browser_act", steps: [{ type: "click", ref: "e1" }, { type: "type", text: "no" }] }, rt);
		expect(result).toMatchObject({ outcome: "unknown", stopped_at: 0, stop_reason: reason });
		expect(rt.dispatched).toEqual(["click"]);
	});

	it("reports a verified terminal navigation as worked", async () => {
		const before = observation("before");
		const after = observation("after", 1);
		const result = await runBrowserAct({
			type: "browser_act",
			steps: [{ type: "click", ref: "e1", expect: { type: "url", changed: true } }],
			expect: { type: "url", contains: "after" },
		}, runtime([before, before, after, after, after], [waitResult("newly_verified"), waitResult("newly_verified")]));
		expect(result).toMatchObject({ outcome: "worked", stopped_at: 0, stop_reason: "navigation", final_expectation: { status: "newly_verified" } });
	});

	it("evaluates the plan expectation after terminal navigation without a step expectation", async () => {
		const before = observation("before");
		const after = observation("after", 1);
		const result = await runBrowserAct({
			type: "browser_act",
			steps: [{ type: "click", ref: "e1" }],
			expect: { type: "url", contains: "after" },
		}, runtime([before, before, after, after], [waitResult("newly_verified")]));
		expect(result).toMatchObject({
			outcome: "worked",
			stopped_at: 0,
			stop_reason: "navigation",
			steps: [{ outcome: "unknown" }],
			final_expectation: { status: "newly_verified", before: "not_matched", after: "matched" },
		});
	});

	it("recollects a successor after a raced target boundary", async () => {
		const result = await runBrowserAct({ type: "browser_act", steps: [{ type: "click", ref: "e1", expect: { type: "text", text: "Done" } }] }, runtime([
			observation("before"), observation("before"), observation("after"), observation("stale"), observation("stable"),
		], [waitResult("newly_verified")], { targets: [["target-1"], ["target-1"], ["target-1"], ["target-1", "target-2"], ["target-1", "target-2"]] }));
		expect(result).toMatchObject({ stop_reason: "control_flow", successor: { status: "observed", title: "stable", text: "stable" } });
	});

	it("treats an early timed-out final expectation as failed without consuming the global deadline", async () => {
		const result = await runBrowserAct({ type: "browser_act", steps: [{ type: "wait" }], expect: { type: "url", contains: "after" } }, runtime([
			observation("before"), observation("before"), observation("after"), observation("after"),
		], [waitResult("failed")]));
		expect(result).toMatchObject({ outcome: "didnt", stop_reason: "expectation_failed", final_expectation: { status: "failed", after: "not_matched" }, successor: { status: "observed", title: "after" } });
	});

	it("does not report incomplete successor observations as authoritative", async () => {
		const incomplete = { ...observation("after"), incompleteFrames: [{ backendNodeId: 99, stage: "resolve" as const, reason: "fixture incomplete" }] };
		const result = await runBrowserAct({ type: "browser_act", steps: [{ type: "click", ref: "e1", expect: { type: "text", text: "Done" } }] }, runtime([
			observation("before"), observation("before"), observation("after"), incomplete, incomplete, incomplete,
		], [waitResult("newly_verified")]));
		expect(result.successor).toMatchObject({ status: "unavailable", error: "successor observation incomplete" });
	});

	it("revalidates the final expectation against the returned successor", async () => {
		const result = await runBrowserAct({
			type: "browser_act",
			steps: [{ type: "click", ref: "e1", expect: { type: "url", contains: "after" } }],
			expect: { type: "url", contains: "after" },
		}, runtime([
			observation("before"), observation("before"), observation("after"), observation("before"),
		], [waitResult("newly_verified"), waitResult("newly_verified")]));
		expect(result).toMatchObject({ outcome: "didnt", stop_reason: "expectation_failed", final_expectation: { status: "failed", after: "not_matched" }, successor: { status: "observed", title: "before" } });
	});


	it("rejects incomplete baselines without dispatch or authoritative diffs", async () => {
		const rt = runtime([{ ...observation("before"), incompleteFrames: [{ backendNodeId: 99, stage: "resolve" as const, reason: "fixture incomplete" }] }]);
		const result = await runBrowserAct({ type: "browser_act", steps: [{ type: "click", ref: "e1" }] }, rt);
		expect(rt.dispatched).toEqual([]);
		expect(result).toMatchObject({ outcome: "unknown", stopped_at: 0, successor: { status: "unavailable", error: "baseline observation incomplete" } });
	});

	it("stops when an intermediate observation is incomplete", async () => {
		const incomplete = { ...observation("after"), incompleteFrames: [{ backendNodeId: 99, stage: "resolve" as const, reason: "fixture incomplete" }] };
		const rt = runtime([observation("before"), observation("before"), incomplete, observation("stable")]);
		const result = await runBrowserAct({ type: "browser_act", steps: [{ type: "click", ref: "e1" }, { type: "type", text: "no" }] }, rt);
		expect(rt.dispatched).toEqual(["click"]);
		expect(result).toMatchObject({ outcome: "unknown", stopped_at: 0, stop_reason: "control_flow" });
	});

	it("stops before dispatch when the observed navigation epoch is no longer live", async () => {
		const rt = runtime([observation("before"), observation("before")]);
		rt.liveNavigationEpoch = () => 1;
		const result = await runBrowserAct({ type: "browser_act", steps: [{ type: "click", ref: "e1" }] }, rt);
		expect(rt.dispatched).toEqual([]);
		expect(result).toMatchObject({ stopped_at: 0, stop_reason: "navigation" });
	});

	it("treats removed frames as a navigation boundary", async () => {
		const framed = { ...observation("before"), generations: new Map([["target-1", 0], ["frame-1", 0]]) };
		const rt = runtime([framed, framed, observation("after"), observation("after")]);
		const result = await runBrowserAct({ type: "browser_act", steps: [{ type: "click", ref: "e1" }, { type: "type", text: "no" }] }, rt);
		expect(rt.dispatched).toEqual(["click"]);
		expect(result).toMatchObject({ stopped_at: 0, stop_reason: "navigation" });
	});

	it("returns a complete normalized successor diff", async () => {
		const result = await runBrowserAct({ type: "browser_act", steps: [{ type: "wait", expect: { type: "text", text: "Done" } }] }, runtime([
			observation("before"), observation("before"), observation("after"), observation("after"),
		], [waitResult("newly_verified")]));
		expect(result.successor).toMatchObject({ status: "observed", diff: { changed: true, added: [{ line: "RootWebArea after [ref]", count: 1 }], removed: [{ line: "RootWebArea before [ref]", count: 1 }] } });
		expect(JSON.stringify(result.successor)).not.toMatch(/\be\d+\b/);
	});

	it("applies successor presentation options without narrowing the structured diff", async () => {
		const rt = runtime([
			observation("before"), observation("before"), observation("after"), observation("after"),
		], [waitResult("newly_verified")]);
		const presentations: BrowserAction[] = [];
		const originalPresent = rt.present;
		rt.present = (state, snapshot) => {
			presentations.push(snapshot);
			return originalPresent(state, snapshot);
		};
		const result = await runBrowserAct({
			type: "browser_act",
			steps: [{ type: "wait", expect: { type: "text", text: "Done" } }],
			successor: { filter: "interactive", depth: 3 },
		}, rt);
		expect(result.successor).toMatchObject({ status: "observed" });
		expect(presentations).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "browser_snapshot", filter: "interactive", depth: 3 }),
			expect.objectContaining({ type: "browser_snapshot", depth: Number.MAX_SAFE_INTEGER }),
		]));
	});

	it("compresses duplicate AX lines and reports URL/title changes in successor diffs", () => {
		const beforeObservation = observation("before");
		const afterObservation = observation("after");
		const presentation = (state: BrowserObservation, lines: string[]): BrowserPresentation => ({
			observation: state,
			cacheKey: "",
			shape: lines.join("\n"),
			lines: lines.map((text) => ({ text, ctx: {} as never })),
		});
		const diff = diffObservations(
			presentation(beforeObservation, ["button Save [\u0000]", "button Save [\u0000]", "text old"]),
			presentation(afterObservation, ["button Save [\u0000]", "text new", "text new", "text new"]),
		);
		expect(diff).toEqual({
			changed: true,
			added: [{ line: "text new", count: 3 }],
			removed: [{ line: "button Save [ref]", count: 1 }, { line: "text old", count: 1 }],
			url: { before: "https://example.test/before", after: "https://example.test/after" },
			title: { before: "before", after: "after" },
		});
	});

	it("preserves a definitive outcome when the successor is unavailable", async () => {
		const result = await runBrowserAct({ type: "browser_act", steps: [{ type: "click", ref: "e1", expect: { type: "text", text: "Missing" } }] }, runtime([
			observation("before"), observation("before"), observation("after"),
		], [waitResult("failed")], { failObservationAt: [3, 4, 5] }));
		expect(result).toMatchObject({ outcome: "didnt", stop_reason: "expectation_failed", successor: { status: "unavailable" } });
	});

	it("preserves a verified outcome when successor collection fails", async () => {
		const result = await runBrowserAct({ type: "browser_act", steps: [{ type: "click", ref: "e1", expect: { type: "text", text: "Done" } }] }, runtime([
			observation("before"), observation("before"), observation("after"),
		], [waitResult("newly_verified")], { failObservationAt: [3, 4, 5] }));
		expect(result).toMatchObject({ outcome: "worked", successor: { status: "unavailable" } });
		expect(result).not.toHaveProperty("stop_reason");
	});

	it("reports semantic evidence after uncertain action delivery", async () => {
		const result = await runBrowserAct({ type: "browser_act", steps: [{ type: "click", ref: "e1", expect: { type: "text", text: "Done" } }] }, runtime([
			observation("before"), observation("before"), observation("after"), observation("after"),
		], [waitResult("newly_verified")], { dispatchError: new Error("input acknowledgement lost") }));
		expect(result).toMatchObject({ outcome: "unknown", stop_reason: "action_failed", steps: [{ outcome: "unknown", expectation: { status: "newly_verified" } }], successor: { status: "observed" } });
	});

	it("formats a stop reason even when no step index owns the boundary", () => {
		const result = {
			outcome: "unknown",
			steps: [],
			stop_reason: "control_flow",
			successor: { status: "unavailable", error: "popup changed successor observation" },
		} satisfies BrowserActResult;
		expect(formatBrowserActResult(result)).toContain("stop_reason: control_flow");
	});

	it("bounds formatted diff output while preserving the structured diff", () => {
		const added = Array.from({ length: 250 }, (_, index) => ({ line: `line ${index}`, count: 1 }));
		const result = { outcome: "unknown", steps: [], successor: { status: "observed", text: "successor", url: "u", title: "t", diff: { changed: true, added, removed: [] } } } satisfies BrowserActResult;
		const formatted = formatBrowserActResult(result);
		expect(formatted).toContain("50 more diff entries omitted");
		expect(formatted).not.toContain("line 249");
		expect(result.successor.diff.added).toHaveLength(250);
	});

	it("hard-bounds formatted action-plan feedback even with adversarially large strings", () => {
		const huge = "x".repeat(100_000);
		const result = {
			outcome: "unknown",
			steps: [{ index: 0, type: "wait", outcome: "unknown", diagnostics: [huge] }],
			successor: { status: "observed", text: huge, url: "u", title: "t", diff: { changed: true, added: [{ line: huge, count: 1 }], removed: [] } },
		} satisfies BrowserActResult;
		const formatted = formatBrowserActResult(result);
		expect(formatted.length).toBeLessThanOrEqual(50_100);
		expect(formatted).toContain("truncated");
	});

	it("stops a mixed batch after a failed semantic wait", async () => {
		const { client } = createClient();
		const executed: string[] = [];
		const executor = { execute: async (action: BrowserAction) => {
			executed.push(action.type);
			return action.type === "browser_wait_for" ? [{ type: "browser_wait_for", result: { status: "timed_out", evidence: "failed", initial: { truth: false, details: [] }, final: { truth: false, details: [] }, elapsed_ms: 20, details: [] } } as BatchReadResult] : [];
		} } as unknown as BrowserExecutor;
		const translator = new InternalComputerTranslator({ browser, client, createBrowserExecutor: () => executor });
		await translator.executeBatch([{ type: "browser_wait_for", expect: { type: "text", text: "Ready" } }, { type: "browser_text" }]);
		expect(executed).toEqual(["browser_wait_for"]);
	});

	it("stops a mixed batch after a worked plan's terminal navigation boundary", async () => {
		const { client } = createClient();
		const executed: string[] = [];
		const executor = { execute: async (action: BrowserAction) => {
			executed.push(action.type);
			return action.type === "browser_act" ? [{ type: "browser_act", result: { outcome: "worked", steps: [], stopped_at: 0, stop_reason: "navigation", successor: { status: "observed", text: "new page", url: "https://example.test/new", title: "New", diff: { changed: true, added: [], removed: [], url: { before: "https://example.test/old", after: "https://example.test/new" } } } } } as BatchReadResult] : [];
		} } as unknown as BrowserExecutor;
		const translator = new InternalComputerTranslator({ browser, client, createBrowserExecutor: () => executor });
		const result = await translator.executeBatch([{ type: "browser_act", steps: [{ type: "wait" }] }, { type: "browser_text" }]);
		expect(executed).toEqual(["browser_act"]);
		expect(result.skippedActions).toBe(1);
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
	let mainFrameId = "TARGET-1";
	let runtimeValue: unknown = "hello";
	let autoNavigationLifecycle = true;
	let historyNavigationMode: "load" | "bfcache" = "load";
	let navigationSequence = 0;
	const navigationHistory = { currentIndex: 1, entries: [{ id: 1, url: "https://before.test" }, { id: 2, url: "https://a.test" }, { id: 3, url: "https://after.test" }] };
	const sessionTrees = new Map<string, Array<{ backendDOMNodeId?: number }>>();
	const frameTrees = new Map<string, Array<{ backendDOMNodeId?: number }>>();
	const iframeFrameIds = new Map<number, string>();
	const boxModels = new Map<number, number[]>();
	const frameLoaderIds = new Map<string, string>();
	const oopifFrameKeys = new Set<string>();
	const oopifSessionFrames = new Map<string, string>();
	const autoAttachFrames: Array<{ targetId: string; sessionId: string; delayMs?: number }> = [];
	const targetSessions = new Map<string, string>();
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
	let onSend: ((method: string, params: Record<string, unknown>, sessionId?: string) => void) | undefined;
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
			onSend?.(method, params, sessionId);
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
							frame: { id: mainFrameId, ...(loaderId !== undefined ? { loaderId } : {}) },
							...(childFrames.length ? { childFrames } : {}),
						},
					};
				}
				case "DOM.resolveNode":
					requireBackendId(params.backendNodeId, sessionId);
					return { object: { objectId: "node-obj" } };
				case "Runtime.evaluate":
					if (params.returnByValue === false) return { result: { objectId: "cursor-scan" } };
					return { result: { value: runtimeValue } };
				case "Page.navigate":
				case "Page.reload": {
					const nextLoaderId = `NAV-${++navigationSequence}`;
					if (autoNavigationLifecycle) {
						emit({ method: "Page.frameNavigated", params: { frame: { id: mainFrameId, loaderId: nextLoaderId } }, sessionId });
						emit({ method: "Page.lifecycleEvent", params: { frameId: mainFrameId, loaderId: nextLoaderId, name: "load" }, sessionId });
					}
					return { frameId: mainFrameId, loaderId: nextLoaderId };
				}
				case "Page.getNavigationHistory":
					return navigationHistory;
				case "Page.navigateToHistoryEntry": {
					const nextLoaderId = `HISTORY-${++navigationSequence}`;
					if (historyNavigationMode === "bfcache") {
						emit({
							method: "Page.frameNavigated",
							params: { frame: { id: mainFrameId, loaderId: nextLoaderId }, type: "BackForwardCacheRestore" },
							sessionId,
						});
					} else {
						emit({ method: "Page.frameNavigated", params: { frame: { id: mainFrameId, loaderId: nextLoaderId }, type: "Navigation" }, sessionId });
						emit({ method: "Page.lifecycleEvent", params: { frameId: mainFrameId, loaderId: nextLoaderId, name: "load" }, sessionId });
					}
					return {};
				}
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
		attachToTarget: async (targetId: string) => targetSessions.get(targetId) ?? "session-1",
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
	const setMainFrameId = (id: string) => {
		mainFrameId = id;
	};
	const setRuntimeValue = (value: unknown) => {
		runtimeValue = value;
	};
	const setNavigationAutoLifecycle = (enabled: boolean) => {
		autoNavigationLifecycle = enabled;
	};
	const setHistoryNavigationMode = (mode: "load" | "bfcache") => {
		historyNavigationMode = mode;
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
	const setSendHook = (hook: typeof onSend) => {
		onSend = hook;
	};
	const setTargetProvider = (provider: typeof targetProvider) => {
		targetProvider = provider;
	};
	const setTargetSession = (targetId: string, sessionId: string) => {
		targetSessions.set(targetId, sessionId);
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
		setMainFrameId,
		setRuntimeValue,
		setNavigationAutoLifecycle,
		setHistoryNavigationMode,
		setFrameLoaderId,
		addAutoAttachFrame,
		failOn,
		setFailureProvider,
		setAxReadHook,
		setSendHook,
		setTargetProvider,
		setTargetSession,
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
	const results = await executor.execute({ type: "browser_snapshot", ...action } as BrowserAction);
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
		await executor.execute({ type: "browser_navigate", url: "https://b.test" } as BrowserAction);
		expect(refsOf(executor).size).toBe(0);
	});

	it("does not let a rejected navigate suppress the next real navigation's invalidation", async () => {
		const { cdp, emit, failOn } = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);
		expect(refsOf(executor).size).toBe(1);

		failOn("Page.navigate");
		await expect(executor.execute({ type: "browser_navigate", url: "https://b.test" } as BrowserAction)).rejects.toThrow(/rejected/);

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
		await executor.execute({ type: "browser_click", ref: "e1" } as BrowserAction);
		expect(sent.some((cmd) => cmd.method === "Input.dispatchMouseEvent")).toBe(true);

		emit({ method: "Page.frameNavigated", params: { frame: { id: "F1" } }, sessionId: "session-1" });
		await expect(executor.execute({ type: "browser_click", ref: "e1" } as BrowserAction)).rejects.toThrow(/stale/);
		expect(refsOf(executor).size).toBe(0);
	});

	it("records same-document navigation when the main frame id differs from the target id", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		fake.setMainFrameId("FRAME-1");
		const executor = new BrowserExecutor(fake.cdp);
		await snapshotText(executor);

		fake.emit({
			method: "Page.navigatedWithinDocument",
			params: { frameId: "FRAME-1", url: "https://a.test/#section" },
			sessionId: "session-1",
		});

		const epochs = (executor as unknown as { navigationEpochs: Map<string, number> }).navigationEpochs;
		expect(epochs.get("TARGET-1")).toBe(1);
	});

	it("does not let a same-document navigation suppress the next real navigation's invalidation", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		fake.setNavigationAutoLifecycle(false);
		let commandSent!: () => void;
		const sent = new Promise<void>((resolve) => { commandSent = resolve; });
		fake.setSendHook((method) => { if (method === "Page.navigate") commandSent(); });
		const executor = new BrowserExecutor(fake.cdp);
		const navigation = executor.execute({ type: "browser_navigate", url: "https://a.test/#section" } as BrowserAction);
		await sent;
		fake.emit({ method: "Page.navigatedWithinDocument", params: { frameId: "TARGET-1", url: "https://a.test/#section" }, sessionId: "session-1" });
		await navigation;
		await snapshotText(executor);

		fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "TARGET-1" } }, sessionId: "session-1" });
		await expect(executor.execute({ type: "browser_click", ref: "e1" } as BrowserAction)).rejects.toThrow(/stale/);
	});

	it("does not double-bump the generation for its own navigate", async () => {
		const { cdp } = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(cdp);
		await executor.execute({ type: "browser_navigate", url: "https://b.test" } as BrowserAction);
		const text = await snapshotText(executor);
		expect(text).toContain('button "Save" [e1]');
		await expect(executor.execute({ type: "browser_click", ref: "e1" } as BrowserAction)).resolves.toEqual([]);
	});
});

describe("BrowserExecutor navigation stabilization", () => {
	it("registers lifecycle observation before navigate and accepts a load completed before command acknowledgement", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(fake.cdp);

		await expect(executor.execute({ type: "browser_navigate", url: "https://fast.test" } as BrowserAction)).resolves.toEqual([
			expect.objectContaining({ type: "browser_text", label: "navigate" }),
		]);

		const lifecycleEnable = fake.sent.findIndex((command) => command.method === "Page.setLifecycleEventsEnabled");
		const navigate = fake.sent.findIndex((command) => command.method === "Page.navigate");
		expect(lifecycleEnable).toBeGreaterThanOrEqual(0);
		expect(lifecycleEnable).toBeLessThan(navigate);
	});

	it("ignores lifecycle events from other targets and frames", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		fake.setMainFrameId("FRAME-1");
		fake.setNavigationAutoLifecycle(false);
		let commandSent!: () => void;
		const sent = new Promise<void>((resolve) => { commandSent = resolve; });
		fake.setSendHook((method) => { if (method === "Page.navigate") commandSent(); });
		const executor = new BrowserExecutor(fake.cdp);
		let settled = false;
		const navigation = executor.execute({ type: "browser_navigate", url: "https://new.test" } as BrowserAction)
			.then((result) => { settled = true; return result; });

		await sent;
		fake.emit({ method: "Page.lifecycleEvent", params: { frameId: "FRAME-1", loaderId: "NAV-1", name: "load" }, sessionId: "session-2" });
		fake.emit({ method: "Page.lifecycleEvent", params: { frameId: "CHILD-1", loaderId: "NAV-1", name: "load" }, sessionId: "session-1" });
		await flushMicrotasks();
		expect(settled).toBe(false);

		fake.emit({ method: "Page.lifecycleEvent", params: { frameId: "FRAME-1", loaderId: "NAV-1", name: "load" }, sessionId: "session-1" });
		await expect(navigation).resolves.toEqual([expect.objectContaining({ type: "browser_text", label: "navigate" })]);
	});

	it("waits for the final main-frame loader when navigation redirects", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		fake.setNavigationAutoLifecycle(false);
		let commandSent!: () => void;
		const sent = new Promise<void>((resolve) => { commandSent = resolve; });
		fake.setSendHook((method) => { if (method === "Page.navigate") commandSent(); });
		const executor = new BrowserExecutor(fake.cdp);
		let settled = false;
		const navigation = executor.execute({ type: "browser_navigate", url: "https://redirect.test" } as BrowserAction)
			.then((result) => { settled = true; return result; });

		await sent;
		fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "TARGET-1", loaderId: "NAV-1" } }, sessionId: "session-1" });
		fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "TARGET-1", loaderId: "REDIRECT-2" } }, sessionId: "session-1" });
		fake.emit({ method: "Page.lifecycleEvent", params: { frameId: "TARGET-1", loaderId: "NAV-1", name: "load" }, sessionId: "session-1" });
		await flushMicrotasks();
		expect(settled).toBe(false);

		fake.emit({ method: "Page.lifecycleEvent", params: { frameId: "TARGET-1", loaderId: "REDIRECT-2", name: "load" }, sessionId: "session-1" });
		await expect(navigation).resolves.toEqual([expect.objectContaining({ type: "browser_text", label: "navigate" })]);
	});

	it("returns fresh text after navigate in one mechanical batch", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		fake.setNavigationAutoLifecycle(false);
		let loaded = false;
		fake.setTargetProvider(() => [{
			targetId: "TARGET-1",
			type: "page",
			title: loaded ? "Fresh" : "Stale",
			url: loaded ? "https://fresh.test" : "https://stale.test",
		}]);
		let commandSent!: () => void;
		const sent = new Promise<void>((resolve) => { commandSent = resolve; });
		fake.setSendHook((method) => { if (method === "Page.navigate") commandSent(); });
		const { client } = createClient();
		const translator = new InternalComputerTranslator({
			browser,
			client,
			createBrowserExecutor: () => new BrowserExecutor(fake.cdp),
		});
		let settled = false;
		const batch = translator.executeBatch([
			{ type: "browser_navigate", url: "https://fresh.test" },
			{ type: "browser_text" },
		]).then((result) => { settled = true; return result; });

		await sent;
		await flushMicrotasks();
		expect(settled).toBe(false);
		expect(fake.sent.some((command) => command.method === "Runtime.evaluate")).toBe(false);
		loaded = true;
		fake.setRuntimeValue("fresh body");
		fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "TARGET-1", loaderId: "NAV-1" } }, sessionId: "session-1" });
		fake.emit({ method: "Page.lifecycleEvent", params: { frameId: "TARGET-1", loaderId: "NAV-1", name: "load" }, sessionId: "session-1" });

		const result = await batch;
		expect(result.readResults).toEqual([
			expect.objectContaining({ type: "browser_text", label: "navigate", text: expect.stringContaining('"Fresh" (https://fresh.test)') }),
			{ type: "browser_text", label: "text", text: "fresh body" },
		]);
	});

	it("cleans up promptly when navigation is interrupted", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		fake.setNavigationAutoLifecycle(false);
		let commandSent!: () => void;
		const sent = new Promise<void>((resolve) => { commandSent = resolve; });
		fake.setSendHook((method) => { if (method === "Page.navigate") commandSent(); });
		const executor = new BrowserExecutor(fake.cdp);
		const controller = new AbortController();
		const navigation = executor.execute({ type: "browser_navigate", url: "https://slow.test" } as BrowserAction, controller.signal);
		await sent;
		await flushMicrotasks();
		controller.abort(new Error("stop navigation"));

		await expect(navigation).rejects.toThrow("stop navigation");
		expect((executor as unknown as { pendingNavigations: Map<string, unknown> }).pendingNavigations.size).toBe(0);
		expect((executor as unknown as { selfNavigations: Set<string> }).selfNavigations.size).toBe(0);
	});

	it("owns a bounded stabilization timeout and invalidates refs atomically", async () => {
		vi.useFakeTimers();
		try {
			const fake = createFakeCdp(BUTTON_TREE);
			fake.setNavigationAutoLifecycle(false);
			const executor = new BrowserExecutor(fake.cdp);
			await snapshotText(executor);
			const navigation = executor.execute({ type: "browser_navigate", url: "https://never-loads.test" } as BrowserAction);
			await flushMicrotasks(12);
			expect(fake.sent.some((command) => command.method === "Page.navigate")).toBe(true);
			expect(refsOf(executor).size).toBe(0);
			const rejected = expect(navigation).rejects.toThrow(/timed out after 10000ms waiting for main-frame load/);
			await vi.advanceTimersByTimeAsync(10_000);
			await rejected;
			expect((executor as unknown as { pendingNavigations: Map<string, unknown> }).pendingNavigations.size).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects non-http browser navigation schemes", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(fake.cdp);

		await expect(executor.execute({ type: "browser_navigate", url: "file:///tmp/secret" } as BrowserAction))
			.rejects.toThrow(/requires an http or https URL/);
		expect(fake.sent.some((command) => command.method === "Page.navigate")).toBe(false);
	});

	it("reloads the active tab and waits for its fresh loader", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(fake.cdp);

		await expect(executor.execute({ type: "browser_navigate", url: "reload" } as BrowserAction)).resolves.toEqual([
			expect.objectContaining({ type: "browser_text", label: "navigate", text: expect.stringContaining("Reloaded page") }),
		]);
		expect(fake.sent).toContainEqual(expect.objectContaining({ method: "Page.reload" }));
	});

	it("completes a non-bfcache history navigation after its fresh loader emits load", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		fake.setHistoryNavigationMode("load");
		const executor = new BrowserExecutor(fake.cdp);

		await expect(executor.execute({ type: "browser_navigate", url: "back" } as BrowserAction)).resolves.toEqual([
			expect.objectContaining({ type: "browser_text", label: "navigate", text: expect.stringContaining("Navigated back") }),
		]);
		expect(fake.sent).toContainEqual(expect.objectContaining({ method: "Page.navigateToHistoryEntry", params: { entryId: 1 } }));
	});

	it.each([
		["back", 1],
		["forward", 3],
	] as const)("completes %s promptly when history restores from bfcache without load events", async (direction, entryId) => {
		const fake = createFakeCdp(BUTTON_TREE);
		fake.setHistoryNavigationMode("bfcache");
		let commandSent!: () => void;
		const sent = new Promise<void>((resolve) => { commandSent = resolve; });
		fake.setSendHook((method) => { if (method === "Page.navigateToHistoryEntry") commandSent(); });
		const executor = new BrowserExecutor(fake.cdp);
		const controller = new AbortController();
		let settled = false;
		let result: Awaited<ReturnType<BrowserExecutor["execute"]>> | undefined;
		const navigation = executor.execute({ type: "browser_navigate", url: direction } as BrowserAction, controller.signal)
			.then((value) => { settled = true; result = value; return value; });

		await sent;
		await flushMicrotasks(12);
		try {
			expect(settled).toBe(true);
			expect(result).toEqual([
				expect.objectContaining({ type: "browser_text", label: "navigate", text: expect.stringContaining(`Navigated ${direction}`) }),
			]);
		} finally {
			if (!settled) controller.abort(new Error("bfcache navigation did not settle promptly"));
			await navigation.catch(() => {});
		}
		expect(fake.sent).toContainEqual(expect.objectContaining({ method: "Page.navigateToHistoryEntry", params: { entryId } }));
	});
});

async function flushMicrotasks(count = 6): Promise<void> {
	for (let index = 0; index < count; index += 1) await Promise.resolve();
}

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
		await executor.execute({ type: "browser_click", ref: "e1" } as BrowserAction);
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
		await executor.execute({ type: "browser_click", ref: "e2" } as BrowserAction);
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
		await executor.execute({ type: "browser_fill", ref: "e1", value: "a@b.c" } as BrowserAction);
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
		await expect(executor.execute({ type: "browser_click", ref: "e1" } as BrowserAction)).rejects.toThrow(/stale/);
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
		await expect(executor.execute({ type: "browser_click", ref: "e2" } as BrowserAction)).rejects.toThrow(/stale/);
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
		await executor.execute({ type: "browser_fill", ref: "e1", value: "a@b.c" } as BrowserAction);
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
		await expect(executor.execute({ type: "browser_fill", ref: "e1", value: "x" } as BrowserAction)).rejects.toThrow(
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
		const results = await executor.execute({ type: "browser_find", query: "save button" } as BrowserAction);
		expect((results[0] as { text: string }).text).toContain('button "Save" [e1]');
		expect(sent.some((command) => command.method === "Runtime.evaluate")).toBe(false);
	});
});

describe("BrowserExecutor dialog guard", () => {
	it("dismisses confirm/prompt dialogs and surfaces the message on the next action", async () => {
		const { cdp, emit, sent } = createFakeCdp();
		const executor = new BrowserExecutor(cdp);
		await executor.execute({ type: "browser_text" } as BrowserAction);

		emit({ method: "Page.javascriptDialogOpening", params: { type: "confirm", message: "Delete item?" }, sessionId: "session-1" });
		const handled = sent.find((cmd) => cmd.method === "Page.handleJavaScriptDialog");
		expect(handled).toEqual({ method: "Page.handleJavaScriptDialog", params: { accept: false }, sessionId: "session-1" });

		const results = await executor.execute({ type: "browser_text" } as BrowserAction);
		expect(results).toEqual([
			{ type: "browser_text", label: "text", text: "hello" },
			{ type: "browser_text", label: "dialog", text: 'Dismissed a JavaScript confirm dialog (answered No/cancel): "Delete item?"' },
		]);
	});

	it("accepts alert and beforeunload dialogs so navigation can proceed", async () => {
		const { cdp, emit, sent } = createFakeCdp();
		const executor = new BrowserExecutor(cdp);
		await executor.execute({ type: "browser_text" } as BrowserAction);

		emit({ method: "Page.javascriptDialogOpening", params: { type: "beforeunload", message: "" }, sessionId: "session-1" });
		emit({ method: "Page.javascriptDialogOpening", params: { type: "alert", message: "Saved!" }, sessionId: "session-1" });
		const handled = sent.filter((cmd) => cmd.method === "Page.handleJavaScriptDialog");
		expect(handled.map((cmd) => cmd.params)).toEqual([{ accept: true }, { accept: true }]);

		const results = await executor.execute({ type: "browser_text" } as BrowserAction);
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
		await executor.execute({ type: "browser_click", ref: "e1" } as BrowserAction);
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

describe("BrowserExecutor semantic waits", () => {
	it.each([
		["selected target", "TARGET-1", "session-1"],
		["unrelated target", "TARGET-2", "session-2"],
	] as const)("continues content waits across same-document navigation on the %s", async (_label, frameId, sessionId) => {
		const fake = createFakeCdp(BUTTON_TREE);
		fake.setTargetSession("TARGET-2", "session-2");
		fake.setTargetProvider(() => [
			{ targetId: "TARGET-1", type: "page", title: "One", url: "https://a.test/" },
			{ targetId: "TARGET-2", type: "page", title: "Two", url: "https://b.test/" },
		]);
		const executor = new BrowserExecutor(fake.cdp);
		await executor.execute({ type: "browser_text", tab_id: "TARGET-2" } as BrowserAction);
		fake.setAxReadHook((read) => {
			if (read === 2) fake.emit({ method: "Page.navigatedWithinDocument", params: { frameId }, sessionId });
		});
		const [read] = await executor.execute({
			type: "browser_wait_for",
			tab_id: "TARGET-1",
			expect: { type: "text", text: "Ready" },
			timeout_ms: 20,
			poll_ms: 1,
		} as BrowserAction);
		expect(read).toMatchObject({ type: "browser_wait_for", result: { status: "timed_out", evidence: "failed" } });
	});

	it.each([
		["missing value", {}, { value: "" }, "unverifiable"],
		["empty value", { value: "" }, { value: "" }, "satisfied"],
		["missing false state", {}, { checked: false }, "unverifiable"],
		["actual false state", { properties: [{ name: "checked", value: false }] }, { checked: false }, "satisfied"],
	] as const)("treats %s distinctly", async (_label, metadata, expected, status) => {
		const tree = [
			ax({ nodeId: "1", role: "RootWebArea", childIds: ["2"] }),
			ax({ nodeId: "2", role: "checkbox", name: "Option", backendDOMNodeId: 42, parentId: "1", ...metadata }),
		];
		const executor = new BrowserExecutor(createFakeCdp(tree).cdp);
		await snapshotText(executor);
		const [read] = await executor.execute({
			type: "browser_wait_for",
			expect: { type: "ref", ref: "e1", ...expected },
			timeout_ms: 2,
			poll_ms: 1,
		} as BrowserAction);
		expect(read).toMatchObject({ type: "browser_wait_for", result: { status } });
	});

	it("observes a condition that becomes true during polling", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		fake.setAxReadHook((read) => {
			if (read === 2) {
				fake.emit({
					method: "Page.navigatedWithinDocument",
					params: { frameId: "TARGET-1", url: "https://a.test/#ready" },
					sessionId: "session-1",
				});
				fake.setNodes([
					ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
					ax({ nodeId: "2", role: "status", name: "Ready", backendDOMNodeId: 43, parentId: "1" }),
				]);
			}
		});
		const executor = new BrowserExecutor(fake.cdp);
		const [read] = await executor.execute({
			type: "browser_wait_for",
			expect: { type: "text", text: "Ready" },
			timeout_ms: 100,
			poll_ms: 10,
		} as BrowserAction);
		expect(read).toMatchObject({ type: "browser_wait_for", result: { status: "satisfied", evidence: "newly_verified" } });
	});
});

describe("BrowserExecutor action plans", () => {
	async function act(executor: BrowserExecutor, action: Record<string, unknown>) {
		const [read] = await executor.execute({ type: "browser_act", timeout_ms: 100, poll_ms: 10, ...action } as BrowserAction);
		if (read?.type !== "browser_act") throw new Error("expected browser_act result");
		return read.result;
	}

	it("waits for a delayed postcondition and returns a consistent successor diff", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const done = [ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }), ax({ nodeId: "2", role: "button", name: "Done", backendDOMNodeId: 43, parentId: "1" })];
		fake.setSendHook((method, params) => {
			if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") setTimeout(() => fake.setNodes(done), 15);
		});
		const executor = new BrowserExecutor(fake.cdp);
		await snapshotText(executor);
		const result = await act(executor, { steps: [{ type: "click", ref: "e1", expect: { type: "text", text: "Done" } }] });
		expect(result).toMatchObject({ outcome: "worked", steps: [{ expectation: { status: "newly_verified" } }], successor: { status: "observed", text: expect.stringContaining('button "Done"'), diff: { added: [{ line: expect.stringContaining('button "Done"'), count: 1 }], removed: [{ line: expect.stringContaining('button "Save"'), count: 1 }] } } });
	});

	it("stops a repeated key step after completing its in-flight key pair", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const base = fake.cdp;
		const delayed = {
			...base,
			send: async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
				if (method === "Input.dispatchKeyEvent") await new Promise((resolve) => setTimeout(resolve, 3));
				return base.send(method, params, sessionId);
			},
		} as unknown as CdpConnection;
		const executor = new BrowserExecutor(delayed);
		const result = await act(executor, { steps: [{ type: "key", text: "a", repeat: 100, timeout_ms: 5 }] });
		const keyEvents = fake.sent.filter((command) => command.method === "Input.dispatchKeyEvent");
		expect(result).toMatchObject({ stop_reason: "step_timeout", successor: { status: "observed" } });
		expect(keyEvents.map((command) => command.params.type)).toEqual(["keyDown", "keyUp"]);
	});

	it.each([
		["same-document", "Page.navigatedWithinDocument", { frameId: "TARGET-1", url: "https://a.test/#next" }],
		["cross-document", "Page.frameNavigated", { frame: { id: "TARGET-1" } }],
	] as const)("stops at a selected-target %s navigation", async (_label, method, params) => {
		const fake = createFakeCdp(BUTTON_TREE);
		fake.setSendHook((sent, input, sessionId) => {
			if (sent === "Input.dispatchMouseEvent" && input.type === "mousePressed") fake.emit({ method, params, sessionId });
		});
		const executor = new BrowserExecutor(fake.cdp);
		await snapshotText(executor);
		const result = await act(executor, { steps: [{ type: "click", ref: "e1" }, { type: "type", text: "no" }] });
		expect(result).toMatchObject({ outcome: "unknown", stopped_at: 0, stop_reason: "navigation" });
		expect(fake.sent.some((command) => command.method === "Input.insertText")).toBe(false);
	});

	it("stops at dialog and popup boundaries", async () => {
		const dialog = createFakeCdp(BUTTON_TREE);
		dialog.setSendHook((method, params, sessionId) => {
			if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") dialog.emit({ method: "Page.javascriptDialogOpening", params: { type: "alert", message: "done" }, sessionId });
		});
		const dialogExecutor = new BrowserExecutor(dialog.cdp);
		await snapshotText(dialogExecutor);
		expect(await act(dialogExecutor, { steps: [{ type: "click", ref: "e1" }, { type: "type", text: "no" }] })).toMatchObject({ stopped_at: 0, stop_reason: "dialog" });

		const popup = createFakeCdp(BUTTON_TREE);
		let opened = false;
		popup.setTargetProvider(() => [
			{ targetId: "TARGET-1", type: "page", title: "Page", url: "https://a.test/" },
			...(opened ? [{ targetId: "TARGET-2", type: "page", title: "Popup", url: "https://b.test/" }] : []),
		]);
		popup.setSendHook((method, params) => { if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") opened = true; });
		const popupExecutor = new BrowserExecutor(popup.cdp);
		await snapshotText(popupExecutor);
		expect(await act(popupExecutor, { steps: [{ type: "click", ref: "e1" }, { type: "type", text: "no" }] })).toMatchObject({ stopped_at: 0, stop_reason: "control_flow" });
	});

	it("isolates navigation epochs to the selected target", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		fake.setTargetSession("TARGET-2", "session-2");
		fake.setTargetProvider(() => [
			{ targetId: "TARGET-1", type: "page", title: "One", url: "https://a.test/" },
			{ targetId: "TARGET-2", type: "page", title: "Two", url: "https://b.test/" },
		]);
		fake.setSendHook((method, params) => {
			if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") fake.emit({ method: "Page.navigatedWithinDocument", params: { frameId: "TARGET-2", url: "https://b.test/#next" }, sessionId: "session-2" });
		});
		const executor = new BrowserExecutor(fake.cdp);
		await snapshotText(executor, { tab_id: "TARGET-1" });
		const result = await act(executor, { tab_id: "TARGET-1", steps: [{ type: "click", ref: "e1" }, { type: "type", text: "yes" }] });
		expect(result).toMatchObject({ outcome: "unknown", steps: [{}, {}] });
		expect(result).not.toHaveProperty("stop_reason");
		expect(fake.sent.some((command) => command.method === "Input.insertText")).toBe(true);
	});

	it("does not verify absence when a nested frame is incomplete", async () => {
		const tree = [ax({ nodeId: "1", role: "RootWebArea", childIds: ["2"] }), ax({ nodeId: "2", role: "Iframe", backendDOMNodeId: 50, parentId: "1" })];
		const result = await act(new BrowserExecutor(createFakeCdp(tree).cdp), { timeout_ms: 10, steps: [{ type: "wait", expect: { type: "text", text: "Missing", exists: false } }] });
		expect(result).toMatchObject({ outcome: "unknown", stop_reason: "control_flow", steps: [], successor: { status: "unavailable", error: "baseline observation incomplete" } });
	});

	it("reports verified state but unknown delivery when input acknowledgement is lost", async () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const done = [ax({ nodeId: "1", role: "RootWebArea", childIds: ["2"] }), ax({ nodeId: "2", role: "button", name: "Done", backendDOMNodeId: 43, parentId: "1" })];
		fake.setSendHook((method, params) => {
			if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") { fake.setNodes(done); throw new Error("input acknowledgement lost"); }
		});
		const executor = new BrowserExecutor(fake.cdp);
		await snapshotText(executor);
		const result = await act(executor, { steps: [{ type: "click", ref: "e1", expect: { type: "text", text: "Done" } }] });
		expect(result).toMatchObject({ outcome: "unknown", stop_reason: "action_failed", steps: [{ outcome: "unknown", expectation: { status: "newly_verified" } }] });
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
		await executor.execute({ type: "browser_click", ref: "e2" } as BrowserAction);

		emit({ method: "Page.frameNavigated", params: { frame: { id: "FRAME-SP", parentId: "F0" } }, sessionId: "session-1" });
		await expect(executor.execute({ type: "browser_click", ref: "e2" } as BrowserAction)).rejects.toThrow(/stale/);
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

	const importOopifRefWithoutOwner = async () => {
		const source = setupOopif();
		const mint = new BrowserExecutor(source.cdp);
		await snapshotText(mint);
		const state = mint.exportRefState();

		const fake = createFakeCdp(OOPIF_PAGE);
		fake.setIframeFrame(50, "FRAME-OOP");
		fake.setSessionTree("session-oop", OOPIF_CHILD);
		const executor = new BrowserExecutor(fake.cdp);
		executor.importRefState(state);
		// Simulate an OOPIF session attaching without a parent session id. The
		// imported ref state must still identify its owning page for invalidation.
		fake.emit({
			method: "Target.attachedToTarget",
			params: { sessionId: "session-oop", targetInfo: { targetId: "FRAME-OOP", type: "iframe" } },
		});
		expect([...refsOf(executor).keys()].sort()).toEqual(["e1", "e2", "e3"]);
		return { executor, fake };
	};

	it("resolves an OOPIF ref's node through the child session but dispatches input on the page session", async () => {
		const { cdp, sent } = setupOopif();
		const executor = new BrowserExecutor(cdp);
		const text = await snapshotText(executor);
		expect(text).toContain('button "Top" [e1]');
		expect(text).toContain('      button "Pay" [e3]');

		await executor.execute({ type: "browser_click", ref: "e3" } as BrowserAction);
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

		await executor.execute({ type: "browser_click", ref: "e3" } as BrowserAction);
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

		await executor.execute({ type: "browser_hover", ref: "e3" } as BrowserAction);
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
		await executor.execute({ type: "browser_click", ref: "e1" } as BrowserAction);
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

		await executor.execute({ type: "browser_click", ref: "e2" } as BrowserAction);
		expect(fake.sent.some((cmd) => cmd.method === "DOM.getFrameOwner")).toBe(false);
		const pressed = fake.sent.find((cmd) => cmd.method === "Input.dispatchMouseEvent" && cmd.params.type === "mousePressed");
		expect([pressed?.params.x, pressed?.params.y]).toEqual([5, 5]);
	});

	it("rebinds and invalidates OOPIF refs through action plans", async () => {
		const nestedSetup = () => {
			const fake = createFakeCdp(OOPIF_PAGE);
			fake.setIframeFrame(50, "FRAME-OOP");
			fake.setIframeFrame(80, "FRAME-INNER");
			fake.addAutoAttachFrame({ targetId: "FRAME-OOP", sessionId: "session-oop" });
			fake.setSessionTree("session-oop", [ax({ nodeId: "o1", role: "RootWebArea", childIds: ["o2"] }), ax({ nodeId: "o2", role: "Iframe", backendDOMNodeId: 80, parentId: "o1" }), ax({ nodeId: "hidden", role: "button", name: "Nested", backendDOMNodeId: 90, parentId: "unrendered" })]);
			fake.setFrameTree("FRAME-INNER", [ax({ nodeId: "i1", role: "RootWebArea", childIds: ["i2"] }), ax({ nodeId: "i2", role: "button", name: "Nested", backendDOMNodeId: 90, parentId: "i1" })]);
			return fake;
		};
		const source = new BrowserExecutor(nestedSetup().cdp);
		await snapshotText(source);
		const state = source.exportRefState();

		const reboundCdp = nestedSetup();
		const rebound = new BrowserExecutor(reboundCdp.cdp);
		rebound.importRefState(state);
		const [worked] = await rebound.execute({ type: "browser_act", steps: [{ type: "click", ref: "e3" }] } as BrowserAction);
		expect(worked).toMatchObject({ type: "browser_act", result: { steps: [{ diagnostics: ["action dispatched"] }] } });
		expect(reboundCdp.sent.find((command) => command.method === "DOM.scrollIntoViewIfNeeded" && command.params.backendNodeId === 80)?.sessionId).toBe("session-oop");

		const staleCdp = nestedSetup();
		const stale = new BrowserExecutor(staleCdp.cdp);
		stale.importRefState(state);
		await snapshotText(stale);
		staleCdp.emit({ method: "Page.frameNavigated", params: { frame: { id: "FRAME-INNER", parentId: "FRAME-OOP" } }, sessionId: "session-oop" });
		const [failed] = await stale.execute({ type: "browser_act", steps: [{ type: "click", ref: "e3" }] } as BrowserAction);
		expect(failed).toMatchObject({ type: "browser_act", result: { outcome: "didnt", stop_reason: "stale_ref" } });
	});

	it("invalidates a frame target's refs when a subframe inside it navigates", async () => {
		const { cdp, emit } = setupOopif();
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);

		emit({ method: "Page.frameNavigated", params: { frame: { id: "FRAME-INNER", parentId: "FRAME-OOP" } }, sessionId: "session-oop" });
		await expect(executor.execute({ type: "browser_click", ref: "e3" } as BrowserAction)).rejects.toThrow(/stale/);
	});

	it.each([
		{
			label: "Page.frameNavigated",
			event: { method: "Page.frameNavigated", params: { frame: { id: "FRAME-OOP" } }, sessionId: "session-oop" },
		},
		{
			label: "Page.frameDetached",
			event: { method: "Page.frameDetached", params: { frameId: "FRAME-OOP", reason: "swap" }, sessionId: "session-oop" },
		},
		{
			label: "Target.detachedFromTarget",
			event: { method: "Target.detachedFromTarget", params: { sessionId: "session-oop" } },
		},
	] as const)("drops imported OOPIF refs when $label fires before owner mapping is known", async ({ event }) => {
		const { fake, executor } = await importOopifRefWithoutOwner();
		fake.emit(event);
		expect([...refsOf(executor).keys()].sort()).toEqual(["e1", "e2"]);
	});

	it("waits on semantic content inside stitched iframes", async () => {
		const { cdp } = setupOopif();
		const executor = new BrowserExecutor(cdp);
		const [read] = await executor.execute({
			type: "browser_wait_for",
			expect: { type: "text", text: "Pay" },
			timeout_ms: 20,
		} as BrowserAction);
		expect(read).toMatchObject({ type: "browser_wait_for", result: { status: "satisfied", evidence: "preexisting" } });
	});

	it("finds elements inside stitched iframes", async () => {
		const { cdp, sent } = setupOopif();
		const executor = new BrowserExecutor(cdp);

		const results = await executor.execute({ type: "browser_find", query: "pay button" } as BrowserAction);
		const text = (results[0] as { text: string }).text;
		expect(text).toContain('button "Pay" [e');

		const ref = /\[(e\d+)\]/.exec(text)![1]!;
		await executor.execute({ type: "browser_click", ref } as BrowserAction);
		const resolved = sent.find((cmd) => cmd.method === "DOM.getBoxModel" && cmd.params.backendNodeId === 70);
		expect(resolved?.sessionId).toBe("session-oop");
	});

	it("invalidates only the child frame's refs when the child frame navigates", async () => {
		const { cdp, emit } = setupOopif();
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);

		emit({ method: "Page.frameNavigated", params: { frame: { id: "FRAME-OOP" } }, sessionId: "session-oop" });
		await expect(executor.execute({ type: "browser_click", ref: "e3" } as BrowserAction)).rejects.toThrow(/stale/);
		await executor.execute({ type: "browser_click", ref: "e1" } as BrowserAction);

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
		await expect(executor.execute({ type: "browser_click", ref: "e2" } as BrowserAction)).rejects.toThrow(/stale/);

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
			(type === "browser_snapshot" ? { type } : { type, query: "stable button" }) as BrowserAction,
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
			executor.execute((type === "browser_snapshot" ? { type } : { type, query: "save" }) as BrowserAction),
		).rejects.toThrow(/observation changed/i);
		expect(fake.sent.filter((command) => command.method === "Accessibility.getFullAXTree")).toHaveLength(3);
		expect(refsOf(executor).size).toBe(0);
	});
});

describe("BrowserExecutor multi-click", () => {
	it("rejects invalid click counts before dispatch", async () => {
		const { cdp, sent } = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);
		for (const num_clicks of [0, 1.5, 4]) await expect(executor.execute({ type: "browser_click", ref: "e1", num_clicks } as BrowserAction)).rejects.toThrow(/integer between 1 and 3/);
		expect(sent.some((cmd) => cmd.method === "Input.dispatchMouseEvent")).toBe(false);
	});

	it("dispatches one press/release cycle per click with incrementing clickCount", async () => {
		const { cdp, sent } = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(cdp);
		await snapshotText(executor);
		await executor.execute({ type: "browser_click", ref: "e1", num_clicks: 2 } as BrowserAction);

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
		await second.execute({ type: "browser_click", ref: "e1" } as BrowserAction);
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
		await second.execute({ type: "browser_click", ref: "e2" } as BrowserAction);
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
		await expect(second.execute({ type: "browser_click", ref: "e1" } as BrowserAction)).rejects.toThrow(/stale/);
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
		await expect(second.execute({ type: "browser_click", ref: "e1" } as BrowserAction)).rejects.toThrow(/stale/);
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
		await second.execute({ type: "browser_click", ref: "e1" } as BrowserAction);
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
		await expect(second.execute({ type: "browser_fill", ref: "e1", value: "x" } as BrowserAction)).rejects.toThrow(/stale/);
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
		await second.execute({ type: "browser_fill", ref: "e1", value: "x" } as BrowserAction);
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
		await expect(second.execute({ type: "browser_scroll_to", ref: "e1" } as BrowserAction)).rejects.toThrow(/stale/);
		expect(refsOf(second).size).toBe(0);
		expect(secondFake.sent.some((cmd) => cmd.method === "DOM.scrollIntoViewIfNeeded")).toBe(false);
	});

	it("carries the document identity through an invocation that never re-attaches the target", async () => {
		const firstFake = createFakeCdp(BUTTON_TREE);
		firstFake.setLoaderId("L0");
		const first = new BrowserExecutor(firstFake.cdp);
		await snapshotText(first);
		const state = first.exportRefState();

		// Middle invocation imports and re-exports without ever attaching (e.g. `loop url`).
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
		await expect(last.execute({ type: "browser_click", ref: "e1" } as BrowserAction)).rejects.toThrow(/stale/);
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
		await expect(second.execute({ type: "browser_click", ref: "e1" } as BrowserAction)).rejects.toThrow(/stale/);
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

		await expect(second.execute({ type: "browser_click", ref: "e3" } as BrowserAction)).rejects.toThrow(/stale/);
		// Only the OOPIF's refs were dropped; the main-frame "Top" and parent
		// Iframe refs survive.
		expect([...refsOf(second).keys()].sort()).toEqual(["e1", "e2"]);
		await second.execute({ type: "browser_click", ref: "e1" } as BrowserAction);
		expect(importFake.sent.some((cmd) => cmd.method === "Input.dispatchMouseEvent" && cmd.params.type === "mousePressed")).toBe(true);
	});

	it("keeps every ref when no frame's document changed across processes", async () => {
		const state = await mintOopifState();
		const importFake = oopifProcess({ main: "M0", oopif: "O0" });
		const second = new BrowserExecutor(importFake.cdp);
		second.importRefState(state);

		await second.execute({ type: "browser_click", ref: "e1" } as BrowserAction);
		await second.execute({ type: "browser_click", ref: "e3" } as BrowserAction);
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

		await second.execute({ type: "browser_click", ref: "e3" } as BrowserAction);
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

		await expect(second.execute({ type: "browser_click", ref: "e3" } as BrowserAction)).rejects.toThrow(/stale/);
		await second.execute({ type: "browser_click", ref: "e1" } as BrowserAction);
		expect(importFake.sent.some((cmd) => cmd.method === "Input.dispatchMouseEvent" && cmd.params.type === "mousePressed")).toBe(true);
	});

	it.each(["browser_fill", "browser_scroll_to"] as const)(
		"reconciles the OOPIF document before %s resolves its ref",
		async (type) => {
			const state = await mintOopifState();
			const importFake = oopifProcess({ main: "M0", oopif: "O1" });
			const second = new BrowserExecutor(importFake.cdp);
			second.importRefState(state);

			const action = (type === "browser_fill" ? { type, ref: "e3", value: "x" } : { type, ref: "e3" }) as BrowserAction;
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
		await expect(last.execute({ type: "browser_click", ref: "e3" } as BrowserAction)).rejects.toThrow(/stale/);
		await last.execute({ type: "browser_click", ref: "e1" } as BrowserAction);
		expect(lastFake.sent.some((cmd) => cmd.method === "Input.dispatchMouseEvent" && cmd.params.type === "mousePressed")).toBe(true);
	});

	it("reads the frame tree at most once for the page and once per pending OOPIF", async () => {
		const state = await mintOopifState();
		const importFake = oopifProcess({ main: "M0", oopif: "O0" });
		const second = new BrowserExecutor(importFake.cdp);
		second.importRefState(state);

		await second.execute({ type: "browser_click", ref: "e3" } as BrowserAction);
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

		await expect(second.execute({ type: "browser_click", ref: payA } as BrowserAction)).rejects.toThrow(/stale/);
		// The sibling frame's ref still resolves against its unchanged document.
		await second.execute({ type: "browser_click", ref: payB } as BrowserAction);
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
		await expect(second.execute({ type: "browser_click", ref: "e3" } as BrowserAction)).rejects.toThrow(/stale/);
		// The frame that *does* carry identity is preserved.
		await second.execute({ type: "browser_click", ref: "e1" } as BrowserAction);
		expect(importFake.sent.some((cmd) => cmd.method === "Input.dispatchMouseEvent" && cmd.params.type === "mousePressed")).toBe(true);
	});

	it("rejects ref state serialized by a newer, unknown identity scheme", () => {
		const fake = createFakeCdp(BUTTON_TREE);
		const executor = new BrowserExecutor(fake.cdp);
		const future: BrowserRefState = { version: 2, refCounter: 0, generations: [], refs: [] };
		expect(() => executor.importRefState(future)).toThrow(/version 2/);
	});
});
