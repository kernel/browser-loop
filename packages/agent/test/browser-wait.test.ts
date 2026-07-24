import { describe, expect, it } from "vitest";
import type { CuaBrowserExpectation } from "@onkernel/cua-ai";
import { buildNthIndex, type AXNode, type BrowserObservation, type RenderContext } from "../src/translator/browser-observation";
import { evaluateBrowserExpectation, waitForBrowserExpectation, type BrowserRefResolver } from "../src/translator/browser-wait";

const nodes = (names: string[]): AXNode[] => [
	{ nodeId: "root", role: { value: "RootWebArea" }, childIds: names.map((_, index) => `n${index}`) },
	...names.map((name, index) => ({ nodeId: `n${index}`, parentId: "root", role: { value: index === 0 ? "button" : "StaticText" }, name: { value: name }, backendDOMNodeId: index + 1 })),
];

function observation(names: string[] = [], complete = true, overrides: Partial<BrowserObservation> = {}): BrowserObservation {
	const list = nodes(names);
	const ctx: RenderContext = { targetId: "page", frameKey: "page", sessionId: "s", generation: 0, nthIndex: buildNthIndex(list) };
	const tree = { byId: new Map(list.map((node) => [node.nodeId, node])), roots: ["root"], ctx };
	return {
		targetId: "page",
		navigationEpoch: 0,
		url: "https://a.test",
		title: "A",
		tree,
		stitches: new Map(),
		incompleteFrames: complete ? [] : [{ backendNodeId: 99, stage: "resolve", reason: "fixture incomplete" }],
		revision: 0,
		generations: new Map([["page", 0]]),
		...overrides,
	};
}

const missingRef: BrowserRefResolver = (expectation) => ({ truth: undefined, details: [`${expectation.ref} stale`], reason: "stale_ref" });

describe("evaluateBrowserExpectation", () => {
	it.each([
		[{ type: "text", text: "SAVE" }, true],
		[{ type: "role_name", role: "button", name: "Save" }, true],
		[{ type: "role_name", role: "button", name: "save" }, false],
		[{ type: "url", contains: "a.test" }, true],
		[{ type: "title", equals: "A" }, true],
		[{ type: "url", changed: false }, true],
	] as Array<[CuaBrowserExpectation, boolean]>) ("evaluates %#", (condition, truth) => {
		const current = observation(["Save"]);
		expect(evaluateBrowserExpectation(condition, current, current, missingRef).truth).toBe(truth);
	});

	it("merges static text runs and ignores ignored nodes", () => {
		const current = observation(["button", "Hello", "world"], false);
		const hello = current.tree.byId.get("n1") as { ignored?: boolean };
		hello.ignored = true;
		expect(evaluateBrowserExpectation({ type: "text", text: "Hello" }, current, current, missingRef).truth).toBeUndefined();
		hello.ignored = false;
		expect(evaluateBrowserExpectation({ type: "text", text: "Hello world" }, current, current, missingRef).truth).toBe(true);
	});

	it.each([
		[true, undefined, { all: [{ type: "text", text: "Save" }, { type: "text", text: "Missing" }] }, undefined],
		[false, undefined, { all: [{ type: "text", text: "Save", exists: false }, { type: "text", text: "Missing" }] }, false],
		[true, undefined, { any: [{ type: "text", text: "Save" }, { type: "text", text: "Missing" }] }, true],
		[false, undefined, { any: [{ type: "text", text: "No" }, { type: "text", text: "Missing" }] }, undefined],
	] as Array<[boolean, undefined, CuaBrowserExpectation, boolean | undefined]>) ("combines three-valued condition %#", (_a, _b, condition, truth) => {
		const current = observation(["Save"], false);
		expect(evaluateBrowserExpectation(condition, current, current, missingRef).truth).toBe(truth);
	});

	it("distinguishes complete absence from incomplete absence", () => {
		expect(evaluateBrowserExpectation({ type: "text", text: "Gone", exists: false }, observation(), observation(), missingRef).truth).toBe(true);
		const incomplete = observation([], false);
		expect(evaluateBrowserExpectation({ type: "text", text: "Gone", exists: false }, incomplete, incomplete, missingRef).truth).toBeUndefined();
	});
});

describe("waitForBrowserExpectation", () => {
	it.each([
		[[["Ready"]], "satisfied", "preexisting"],
		[[[], ["Ready"]], "satisfied", "newly_verified"],
		[[[]], "timed_out", "failed"],
	] as Array<[string[][], string, string]>) ("returns %s as %s", async (states, status, evidence) => {
		let time = 0, read = 0;
		const result = await waitForBrowserExpectation({
			selectTarget: async () => "page", observeTarget: async () => observation(states[Math.min(read++, states.length - 1)]!),
			dialogCount: () => 0, targetExists: async () => true, liveGeneration: () => 0, resolveRef: missingRef,
			now: () => time, delay: async (ms) => { time += ms; },
		}, { expect: { type: "text", text: "Ready" }, timeoutMs: 20, pollMs: 10 });
		expect(result).toMatchObject({ status, evidence });
	});

	it("reports initial observation failures and stale refs honestly", async () => {
		const failed = await waitForBrowserExpectation({ selectTarget: async () => "page", observeTarget: async () => { throw new Error("boom"); }, dialogCount: () => 0, targetExists: async () => true, liveGeneration: () => 0, resolveRef: missingRef }, { expect: { type: "text", text: "Ready" }, timeoutMs: 10 });
		expect(failed).toMatchObject({ status: "unverifiable", reason: "observation_failed" });
		const stale = await waitForBrowserExpectation({ selectTarget: async () => "page", observeTarget: async () => observation(), dialogCount: () => 0, targetExists: async () => true, liveGeneration: () => 0, resolveRef: missingRef }, { expect: { type: "ref", ref: "e1", checked: true }, timeoutMs: 10 });
		expect(stale).toMatchObject({ status: "interrupted", reason: "stale_ref" });
	});

	it.each([
		["target_detached", { exists: false }],
		["target_changed", { targetId: "other" }],
		["dialog", { dialog: true }],
		["navigation", { crossDocument: true }],
		["observation_failed", { observationError: true }],
	] as const)("returns the public %s interruption reason", async (reason, scenario) => {
		let time = 0, reads = 0, dialogReads = 0;
		const result = await waitForBrowserExpectation({
			selectTarget: async () => "page",
			observeTarget: async () => {
				if (reads++ > 0 && "observationError" in scenario) throw new Error("boom");
				return observation([], true, {
					...(reads > 1 && scenario.targetId ? { targetId: scenario.targetId } : {}),
					...(reads > 1 && "crossDocument" in scenario ? { generations: new Map([["page", 1]]) } : {}),
				});
			},
			dialogCount: () => "dialog" in scenario && scenario.dialog && dialogReads++ > 0 ? 1 : 0,
			targetExists: async () => !("exists" in scenario) || scenario.exists,
			liveGeneration: () => 0, resolveRef: missingRef,
			now: () => time, delay: async (ms) => { time += ms; },
		}, { expect: { type: "text", text: "Ready" }, timeoutMs: 20, pollMs: 10 });
		expect(result).toMatchObject({ status: reason === "observation_failed" ? "unverifiable" : "interrupted", reason });
	});

	it.each([
		["target_changed", { targetId: "other" }],
		["dialog", { dialog: true }],
		["navigation", { crossDocument: true }],
	] as const)("includes the current observation in %s interruption evidence", async (reason, scenario) => {
		let time = 0, reads = 0, dialogReads = 0;
		const result = await waitForBrowserExpectation({
			selectTarget: async () => "page",
			observeTarget: async () => observation(reads++ === 0 ? [] : ["Ready"], true, {
				...(reads > 1 && scenario.targetId ? { targetId: scenario.targetId } : {}),
				...(reads > 1 && "crossDocument" in scenario ? { generations: new Map([["page", 1]]) } : {}),
			}),
			dialogCount: () => "dialog" in scenario && scenario.dialog && dialogReads++ > 0 ? 1 : 0,
			targetExists: async () => true,
			resolveRef: missingRef,
			now: () => time,
			delay: async (ms) => { time += ms; },
		}, { expect: { type: "text", text: "Ready" }, timeoutMs: 20, pollMs: 10 });
		expect(result).toMatchObject({
			status: "interrupted",
			reason,
			final: { truth: true, details: ["text present"] },
		});
	});

	it("allows a condition to satisfy after an unrelated baseline frame is removed", async () => {
		let time = 0, reads = 0;
		const baseline = observation(["Gone"]);
		baseline.generations.set("frame", 1);
		const result = await waitForBrowserExpectation({
			selectTarget: async () => "page", observeTarget: async () => reads++ === 0 ? baseline : observation(),
			dialogCount: () => 0, targetExists: async () => true, liveGeneration: () => 0,
			resolveRef: missingRef, now: () => time, delay: async (ms) => { time += ms; },
		}, { expect: { type: "text", text: "Gone", exists: false }, timeoutMs: 20, pollMs: 10 });
		expect(result).toMatchObject({ status: "satisfied", evidence: "newly_verified" });
	});

	it("interrupts when a ref becomes stale after the baseline", async () => {
		let time = 0, resolves = 0;
		const resolveRef: BrowserRefResolver = () => resolves++ === 0 ? { truth: false, details: ["not checked"] } : { truth: undefined, details: ["stale"], reason: "stale_ref" };
		const result = await waitForBrowserExpectation({ selectTarget: async () => "page", observeTarget: async () => observation(), dialogCount: () => 0, targetExists: async () => true, liveGeneration: () => 0, resolveRef, now: () => time, delay: async (ms) => { time += ms; } }, { expect: { type: "ref", ref: "e1", checked: true }, timeoutMs: 20, pollMs: 10 });
		expect(result).toMatchObject({ status: "interrupted", reason: "stale_ref" });
	});

	it("retries transient incomplete observations", async () => {
		let time = 0, reads = 0;
		const states = [observation(), observation([], false), observation(["Ready"])];
		const result = await waitForBrowserExpectation({
			selectTarget: async () => "page", observeTarget: async () => states[Math.min(reads++, states.length - 1)]!,
			dialogCount: () => 0, targetExists: async () => true, liveGeneration: () => 0,
			resolveRef: missingRef, now: () => time, delay: async (ms) => { time += ms; },
		}, { expect: { type: "text", text: "Ready" }, timeoutMs: 30, pollMs: 10 });
		expect(result).toMatchObject({ status: "satisfied", evidence: "newly_verified" });
	});

	it("accepts positive evidence from an incomplete polling observation", async () => {
		let time = 0, reads = 0;
		const states = [observation(), observation(["Ready"], false)];
		const result = await waitForBrowserExpectation({
			selectTarget: async () => "page", observeTarget: async () => states[Math.min(reads++, states.length - 1)]!,
			dialogCount: () => 0, targetExists: async () => true, resolveRef: missingRef,
			now: () => time, delay: async (ms) => { time += ms; },
		}, { expect: { type: "text", text: "Ready" }, timeoutMs: 20, pollMs: 10 });
		expect(result).toMatchObject({ status: "satisfied", evidence: "newly_verified" });
	});

	it("returns unproven absence in incomplete observations as unverifiable", async () => {
		let time = 0;
		const result = await waitForBrowserExpectation({ selectTarget: async () => "page", observeTarget: async () => observation([], false), dialogCount: () => 0, targetExists: async () => true, liveGeneration: () => 0, resolveRef: missingRef, now: () => time, delay: async (ms) => { time += ms; } }, { expect: { type: "text", text: "Gone", exists: false }, timeoutMs: 10, pollMs: 10 });
		expect(result).toMatchObject({ status: "unverifiable", reason: "incomplete_observation" });
	});

	it.each([
		[{ type: "text", text: "Ready" } as const, observation(["Ready"], false)],
		[{ type: "url", contains: "a.test" } as const, observation([], false)],
	])("accepts positive evidence from an incomplete baseline", async (expectation, baseline) => {
		let time = 0;
		const result = await waitForBrowserExpectation({
			selectTarget: async () => "page", observeTarget: async () => baseline,
			dialogCount: () => 0, targetExists: async () => true, resolveRef: missingRef,
			now: () => time, delay: async (ms) => { time += ms; },
		}, { expect: expectation, timeoutMs: 20, pollMs: 10 });
		expect(result).toMatchObject({ status: "satisfied", evidence: "preexisting" });
	});

	it("retries an incomplete baseline until the condition is verifiable", async () => {
		let time = 0, reads = 0;
		const states = [observation([], false), observation(["Ready"])];
		const result = await waitForBrowserExpectation({
			selectTarget: async () => "page", observeTarget: async () => states[Math.min(reads++, states.length - 1)]!,
			dialogCount: () => 0, targetExists: async () => true, resolveRef: missingRef,
			now: () => time, delay: async (ms) => { time += ms; },
		}, { expect: { type: "text", text: "Ready" }, timeoutMs: 20, pollMs: 10 });
		expect(result).toMatchObject({ status: "satisfied", evidence: "newly_verified" });
	});

	it("allows location expectations to be satisfied by navigation", async () => {
		let time = 0, reads = 0;
		const result = await waitForBrowserExpectation({ selectTarget: async () => "page", observeTarget: async () => reads++ === 0 ? observation() : observation([], true, { url: "https://a.test/done", generations: new Map([["page", 1]]) }), dialogCount: () => 0, targetExists: async () => true, liveGeneration: () => 0, resolveRef: missingRef, now: () => time, delay: async (ms) => { time += ms; } }, { expect: { type: "url", contains: "/done" }, timeoutMs: 20, pollMs: 10 });
		expect(result).toMatchObject({ status: "satisfied", evidence: "newly_verified" });
	});

	it.each([
		{ any: [{ type: "url", contains: "/done" }, { type: "text", text: "Never" }] },
		{ all: [{ type: "url", contains: "/done" }, { type: "text", text: "Ready" }] },
	] as CuaBrowserExpectation[])("allows mixed location condition %# to satisfy after navigation", async (expectation) => {
		let time = 0, reads = 0;
		const result = await waitForBrowserExpectation({
			selectTarget: async () => "page",
			observeTarget: async () => reads++ === 0
				? observation()
				: observation(["Ready"], true, { url: "https://a.test/done", generations: new Map([["page", 1]]) }),
			dialogCount: () => 0,
			targetExists: async () => true,
			resolveRef: missingRef,
			now: () => time,
			delay: async (ms) => { time += ms; },
		}, { expect: expectation, timeoutMs: 20, pollMs: 10 });
		expect(result).toMatchObject({ status: "satisfied", evidence: "newly_verified" });
	});

	it("reports timeout when a non-matching location change lands at the deadline", async () => {
		let time = 0, reads = 0;
		const result = await waitForBrowserExpectation({
			selectTarget: async () => "page",
			observeTarget: async () => {
				if (reads++ === 0) return observation();
				time = 100;
				return observation([], true, { url: "https://a.test/other", generations: new Map([["page", 1]]) });
			},
			dialogCount: () => 0, targetExists: async () => true, liveGeneration: () => 0,
			resolveRef: missingRef, now: () => time, delay: async (ms) => { time += ms; },
		}, { expect: { type: "url", contains: "/done" }, timeoutMs: 100, pollMs: 10 });
		expect(result).toMatchObject({ status: "timed_out", evidence: "failed" });
	});

	it("continues content waits across same-document navigation", async () => {
		let time = 0, reads = 0;
		const result = await waitForBrowserExpectation({
			selectTarget: async () => "page",
			observeTarget: async () => reads++ === 0 ? observation() : observation(["Ready"], true, { navigationEpoch: 1 }),
			dialogCount: () => 0, targetExists: async () => true, resolveRef: missingRef,
			now: () => time, delay: async (ms) => { time += ms; },
		}, { expect: { type: "text", text: "Ready" }, timeoutMs: 20, pollMs: 10 });
		expect(result).toMatchObject({ status: "satisfied", evidence: "newly_verified" });
	});

	it("continues location waits across redirect hops", async () => {
		let time = 0, reads = 0;
		const states = [
			observation(),
			observation([], true, { url: "https://a.test/interstitial", generations: new Map([["page", 1]]) }),
			observation([], true, { url: "https://a.test/done", generations: new Map([["page", 2]]) }),
		];
		const result = await waitForBrowserExpectation({
			selectTarget: async () => "page", observeTarget: async () => states[Math.min(reads++, states.length - 1)]!,
			dialogCount: () => 0, targetExists: async () => true, resolveRef: missingRef,
			now: () => time, delay: async (ms) => { time += ms; },
		}, { expect: { type: "url", contains: "/done" }, timeoutMs: 30, pollMs: 10 });
		expect(result).toMatchObject({ status: "satisfied", evidence: "newly_verified" });
	});

	it("keeps polling an any-condition when one ref branch is stale", async () => {
		let time = 0, reads = 0;
		const result = await waitForBrowserExpectation({
			selectTarget: async () => "page",
			observeTarget: async () => observation(reads++ === 0 ? [] : ["Ready"]),
			dialogCount: () => 0, targetExists: async () => true, resolveRef: missingRef,
			now: () => time, delay: async (ms) => { time += ms; },
		}, {
			expect: { any: [{ type: "ref", ref: "e1", checked: true }, { type: "text", text: "Ready" }] },
			timeoutMs: 20,
			pollMs: 10,
		});
		expect(result).toMatchObject({ status: "satisfied", evidence: "newly_verified" });
	});

	it("does not accept a condition completed after the deadline", async () => {
		let time = 0, reads = 0;
		const result = await waitForBrowserExpectation({ selectTarget: async () => "page", observeTarget: async () => { if (reads++ > 0) time += 20; return observation(reads > 1 ? ["Ready"] : []); }, dialogCount: () => 0, targetExists: async () => true, liveGeneration: () => 0, resolveRef: missingRef, now: () => time, delay: async (ms) => { time += ms; } }, { expect: { type: "text", text: "Ready" }, timeoutMs: 20, pollMs: 10 });
		expect(result.status).toBe("timed_out");
	});

	it("preserves a stale-ref interruption discovered at the deadline", async () => {
		let time = 0;
		const result = await waitForBrowserExpectation({
			selectTarget: async () => "page", observeTarget: async () => observation(),
			dialogCount: () => 0, targetExists: async () => true,
			resolveRef: () => {
				time = 10;
				return { truth: undefined, details: ["stale"], reason: "stale_ref" };
			},
			now: () => time,
		}, { expect: { type: "ref", ref: "e1", checked: true }, timeoutMs: 10 });
		expect(result).toMatchObject({ status: "interrupted", reason: "stale_ref" });
	});

	it("evaluates the baseline snapshot before returning timed_out at the deadline", async () => {
		let time = 0;
		const result = await waitForBrowserExpectation({
			selectTarget: async () => "page",
			observeTarget: async () => {
				time = 10;
				return observation(["Ready"]);
			},
			dialogCount: () => 0,
			targetExists: async () => true,
			resolveRef: missingRef,
			now: () => time,
		}, { expect: { type: "text", text: "Ready" }, timeoutMs: 10 });
		expect(result).toMatchObject({
			status: "timed_out",
			initial: { truth: true, details: ["text present"] },
			final: { truth: true, details: ["text present"] },
		});
	});

	it.each(["select", "observe", "evaluate"] as const)("includes initial %s in the hard deadline", async (phase) => {
		let time = 0;
		const result = await waitForBrowserExpectation({
			selectTarget: async () => { if (phase === "select") time = 10; return "page"; },
			observeTarget: async () => { if (phase === "observe") time = 10; return observation(); },
			dialogCount: () => 0, targetExists: async () => true, liveGeneration: () => 0,
			resolveRef: () => { if (phase === "evaluate") time = 10; return { truth: true, details: [] }; },
			now: () => time,
		}, { expect: phase === "evaluate" ? { type: "ref", ref: "e1", checked: true } : { type: "text", text: "Ready" }, timeoutMs: 10 });
		expect(result.status).toBe("timed_out");
	});
});
