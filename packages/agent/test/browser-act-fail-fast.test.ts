import { describe, expect, it } from "vitest";
import { runBrowserAct, type BrowserActRuntime } from "../src/translator/browser-act";

// `boundary()` compares the observation's navigation epoch and per-frame
// generations against what the runtime reports live, so a fixture has to agree
// with the stub's liveNavigationEpoch/liveGeneration or every step reports a
// spurious navigation.
const observation = {
	targetId: "target-1",
	url: "https://example.com/",
	title: "Example",
	navigationEpoch: 1,
	generations: new Map([["frame-1", 1]]),
	incompleteFrames: [],
	frames: [],
	nodes: [],
} as unknown as Awaited<ReturnType<BrowserActRuntime["observe"]>>;

/** Records what the plan asked for, and makes any wait take the whole deadline. */
function stubRuntime(overrides: Partial<BrowserActRuntime> = {}) {
	const calls = { waits: 0, steps: 0, observes: 0 };
	const runtime: BrowserActRuntime = {
		observe: async () => {
			calls.observes += 1;
			return observation;
		},
		targetIds: async () => ["target-1"],
		dialogCount: () => 0,
		liveGeneration: () => 1,
		liveNavigationEpoch: () => 1,
		executeStep: async () => {
			calls.steps += 1;
		},
		wait: async (_expect, _baseline, _targetId, _tabId, timeoutMs) => {
			calls.waits += 1;
			// Stand in for a condition that can never become true: consume the budget.
			await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs ?? 0, 300)));
			return { status: "timed_out", reason: "timeout", details: [], initial: { truth: false, details: [] } } as never;
		},
		evaluate: () => ({ truth: undefined, details: [] }) as never,
		present: () => ({}) as never,
		render: () => "",
		...overrides,
	};
	return { runtime, calls };
}

describe("browser_act failure handling", () => {
	it("does not wait for the effect of an action that failed", async () => {
		// The reported symptom: the model invents a ref it never snapshotted, the click
		// throws immediately, and the plan then spends its whole deadline waiting for
		// the effect of an action that never happened.
		const { runtime, calls } = stubRuntime({
			executeStep: async () => {
				throw new Error('ref "e3" is stale');
			},
		});
		const started = Date.now();
		const result = await runBrowserAct(
			{
				type: "act",
				steps: [{ type: "click", ref: "e3", expect: { type: "text", text: "never appears" } }],
				timeout_ms: 5000,
			} as never,
			runtime,
		);

		expect(calls.waits).toBe(0);
		expect(result.stop_reason).toBe("stale_ref");
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("still waits for the effect of an action that succeeded", async () => {
		const { runtime, calls } = stubRuntime();
		const result = await runBrowserAct(
			{
				type: "act",
				steps: [{ type: "click", ref: "e1", expect: { type: "text", text: "never appears" } }],
				timeout_ms: 800,
			} as never,
			runtime,
		);

		expect(calls.steps).toBe(1);
		expect(calls.waits).toBe(1);
		expect(result.stop_reason).toBeDefined();
	});
});
