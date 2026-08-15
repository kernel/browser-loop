import { describe, expect, it } from "vitest";
import { type RefEntry, RefGenerationLifecycle } from "../src/core/translator/browser-ref-lifecycle";

function frameRef(overrides: Partial<RefEntry> = {}): RefEntry {
	return {
		backendNodeId: 70,
		targetId: "TARGET-A",
		frameId: "FRAME-X",
		sessionId: "session-a",
		generation: 0,
		role: "button",
		name: "Pay",
		nth: 0,
		cohort: 1,
		...overrides,
	};
}

// A frame id is expected to belong to exactly one owning target within a
// process. captureFrame throws on a genuine owner change rather than silently
// re-keying the frame under a new target, which would cross-wire refs. This
// pins the diagnostic and confirms the throw leaves the existing frame state
// intact (no partial reassignment). It documents current behavior only.
describe("RefGenerationLifecycle.captureFrame owner invariant", () => {
	it("throws when a still-referenced frame is captured under a different target and preserves prior state", () => {
		const refs = new Map<string, RefEntry>();
		const lifecycle = new RefGenerationLifecycle(refs);

		const capture = lifecycle.captureFrame("TARGET-A", "FRAME-X");
		lifecycle.retainRef("e1", frameRef({ generation: capture.generation }));

		expect(() => lifecycle.captureFrame("TARGET-B", "FRAME-X")).toThrow(
			"frame FRAME-X changed owner from TARGET-A to TARGET-B",
		);

		// The frame stays owned by TARGET-A: the retained ref is still current and
		// a re-capture on the original target succeeds, so the throw did not
		// re-key the frame or bump its generation.
		expect(lifecycle.isRefCurrent(refs.get("e1")!)).toBe(true);
		expect(lifecycle.isCurrent(lifecycle.captureFrame("TARGET-A", "FRAME-X"))).toBe(true);
		expect(refs.size).toBe(1);
		expect(lifecycle.exportGenerations().filter(([key]) => key === "FRAME-X")).toEqual([["FRAME-X", 0]]);
	});
});

function mainEntry(targetId: string, generation = 0): Omit<RefEntry, "sessionId"> {
	return { backendNodeId: 10, targetId, frameId: targetId, generation, role: "button", name: "Main", nth: 0, cohort: 1 };
}

function childEntry(targetId: string, frameId: string, backendNodeId: number, generation = 0): Omit<RefEntry, "sessionId"> {
	return { backendNodeId, targetId, frameId, generation, role: "button", name: frameId, nth: 0, cohort: 1 };
}

// Per-frame document reconciliation is what lets a child-frame or OOPIF change
// stale only that frame's imported refs. These pin the invalidation scope and
// the fail-safe classification of missing/malformed identities directly on the
// lifecycle, independent of any CDP wiring.
describe("RefGenerationLifecycle document reconciliation", () => {
	it("stales only the mismatched child frame, preserving the main frame and sibling frames", () => {
		const refs = new Map<string, RefEntry>();
		const lifecycle = new RefGenerationLifecycle(refs);
		lifecycle.importState(
			[
				["T", 0],
				["FRAME-A", 0],
				["FRAME-B", 0],
			],
			[
				["e1", mainEntry("T")],
				["e2", childEntry("T", "FRAME-A", 21)],
				["e3", childEntry("T", "FRAME-B", 22)],
			],
			"T",
			[
				["T", "M0"],
				["FRAME-A", "A0"],
				["FRAME-B", "B0"],
			],
		);

		// FRAME-A's document changed: invalidateFrame, not invalidateTarget.
		lifecycle.reconcileDocument("FRAME-A", "T", "A1");
		expect(refs.has("e2")).toBe(false);
		// The main frame and the untouched sibling frame keep their refs — proof the
		// whole target was not invalidated.
		expect(lifecycle.isRefCurrent(refs.get("e1")!)).toBe(true);
		expect(lifecycle.isRefCurrent(refs.get("e3")!)).toBe(true);
	});

	it("keeps a child frame whose live document matches its mint-time identity", () => {
		const refs = new Map<string, RefEntry>();
		const lifecycle = new RefGenerationLifecycle(refs);
		lifecycle.importState(
			[["T", 0], ["FRAME-A", 0]],
			[["e1", mainEntry("T")], ["e2", childEntry("T", "FRAME-A", 21)]],
			"T",
			[["T", "M0"], ["FRAME-A", "A0"]],
		);
		lifecycle.reconcileDocument("FRAME-A", "T", "A0");
		expect(lifecycle.isRefCurrent(refs.get("e2")!)).toBe(true);
		expect(lifecycle.documentOf("FRAME-A", "T")).toBe("A0");
	});

	it("treats a blank imported or live loaderId as a non-match and fails safe", () => {
		const refs = new Map<string, RefEntry>();
		const lifecycle = new RefGenerationLifecycle(refs);
		lifecycle.importState([["T", 0]], [["e1", mainEntry("T")]], "T", [["T", ""]]);
		// A blank loaderId is unusable, so the frame is unverifiable.
		expect(lifecycle.pendingDocuments("T")).toEqual([{ frameKey: "T", verifiable: false }]);
		// Even a blank *live* loaderId must never be accepted as a match.
		lifecycle.reconcileDocument("T", "T", "");
		expect(refs.has("e1")).toBe(false);
	});

	it("treats duplicate conflicting identities as ambiguous and fails safe", () => {
		const refs = new Map<string, RefEntry>();
		const lifecycle = new RefGenerationLifecycle(refs);
		lifecycle.importState([["T", 0]], [["e1", mainEntry("T")]], "T", [["T", "M0"], ["T", "M9"]]);
		expect(lifecycle.pendingDocuments("T")).toEqual([{ frameKey: "T", verifiable: false }]);
		// Matching one of the two conflicting identities must not resolve the ref.
		lifecycle.reconcileDocument("T", "T", "M0");
		expect(refs.has("e1")).toBe(false);
	});

	it("ignores malformed document entries, leaving those frames unverifiable", () => {
		const refs = new Map<string, RefEntry>();
		const lifecycle = new RefGenerationLifecycle(refs);
		const malformed = [["T"], "nope", ["T", 5], [42, "x"]] as unknown as Array<[string, string]>;
		lifecycle.importState([["T", 0]], [["e1", mainEntry("T")]], "T", malformed);
		expect(lifecycle.pendingDocuments("T")).toEqual([{ frameKey: "T", verifiable: false }]);
		lifecycle.reconcileDocument("T", "T", "whatever");
		expect(refs.has("e1")).toBe(false);
	});

	it("never fabricates identity on re-export but upgrades once a live document is recorded", () => {
		const refs = new Map<string, RefEntry>();
		const lifecycle = new RefGenerationLifecycle(refs);
		lifecycle.importState([["T", 0]], [["e1", mainEntry("T")]], "T", undefined);
		// Legacy state stays honestly legacy: nothing to export for an unverifiable frame.
		expect(lifecycle.exportDocuments(new Set(["T"]))).toEqual([]);
		lifecycle.recordDocument("T", "T", "M0");
		expect(lifecycle.exportDocuments(new Set(["T"]))).toEqual([["T", "M0"]]);
	});
});
