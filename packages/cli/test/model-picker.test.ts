import { describe, expect, it } from "vitest";
import { listCuaModels } from "@onkernel/cua-ai";
import {
	clampSelection,
	filterModelsForPicker,
	modelSearchText,
	moveSelection,
	sortModelsForPicker,
	visibleWindow,
} from "../src/tui/model-picker";

const catalog = listCuaModels();

describe("modelSearchText", () => {
	it("leads with the provider and repeats it, keeping the bare id last", () => {
		const item = { ref: "openai:gpt-5.5" as const, provider: "openai" as const, model: "gpt-5.5", name: "GPT-5.5" };
		expect(modelSearchText(item)).toBe("openai openai:gpt-5.5 openai gpt-5.5 GPT-5.5");
	});

	it("omits an empty name", () => {
		const item = { ref: "openai:x" as const, provider: "openai" as const, model: "x", name: "" };
		expect(modelSearchText(item)).toBe("openai openai:x openai x");
	});
});

describe("filterModelsForPicker", () => {
	it("returns the whole catalog for an empty query", () => {
		expect(filterModelsForPicker(catalog, "")).toHaveLength(catalog.length);
	});

	it("ranks an exact provider-qualified ref first", () => {
		const target = catalog.find((m) => m.provider === "openai");
		expect(target).toBeDefined();
		const filtered = filterModelsForPicker(catalog, target!.ref);
		expect(filtered[0]?.ref).toBe(target!.ref);
	});

	it("matches on the human-readable name across the colon-delimited ref", () => {
		const google = catalog.filter((m) => m.provider === "google");
		expect(google.length).toBeGreaterThan(0);
		const filtered = filterModelsForPicker(catalog, "google");
		expect(filtered.length).toBeGreaterThan(0);
		expect(filtered.every((m) => m.provider === "google")).toBe(true);
	});

	it("returns an empty list when nothing matches", () => {
		expect(filterModelsForPicker(catalog, "zzzzz-no-such-model")).toEqual([]);
	});
});

describe("sortModelsForPicker", () => {
	it("hoists the current ref and preserves catalog order for the rest", () => {
		const current = catalog[catalog.length - 1]!;
		const sorted = sortModelsForPicker(catalog, current.ref);
		expect(sorted[0]?.ref).toBe(current.ref);
		const rest = sorted.slice(1).map((m) => m.ref);
		const expected = catalog.filter((m) => m.ref !== current.ref).map((m) => m.ref);
		expect(rest).toEqual(expected);
	});

	it("leaves order untouched when the current ref is unknown", () => {
		expect(sortModelsForPicker(catalog, undefined).map((m) => m.ref)).toEqual(catalog.map((m) => m.ref));
	});
});

describe("moveSelection", () => {
	it("wraps at both ends", () => {
		expect(moveSelection(0, -1, 5)).toBe(4);
		expect(moveSelection(4, 1, 5)).toBe(0);
		expect(moveSelection(2, 1, 5)).toBe(3);
		expect(moveSelection(2, -1, 5)).toBe(1);
	});

	it("is a no-op on an empty list", () => {
		expect(moveSelection(0, 1, 0)).toBe(0);
		expect(moveSelection(0, -1, 0)).toBe(0);
	});
});

describe("clampSelection", () => {
	it("pulls the cursor into a list that shrank", () => {
		expect(clampSelection(9, 3)).toBe(2);
		expect(clampSelection(1, 3)).toBe(1);
		expect(clampSelection(4, 0)).toBe(0);
	});
});

describe("visibleWindow", () => {
	it("shows the whole list when it fits", () => {
		expect(visibleWindow(0, 4, 10)).toEqual({ start: 0, end: 4 });
	});

	it("centres the cursor and clamps at the tail", () => {
		expect(visibleWindow(0, 30, 10)).toEqual({ start: 0, end: 10 });
		expect(visibleWindow(15, 30, 10)).toEqual({ start: 10, end: 20 });
		expect(visibleWindow(29, 30, 10)).toEqual({ start: 20, end: 30 });
	});
});
