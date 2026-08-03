import { describe, expect, it } from "vitest";
import { cua } from "@onkernel/cua-ai";
import { defaultApplicationTools, defaultInteractionTools } from "../src/harness";
import {
	describeTools,
	disableTools,
	enableTools,
	sameSelection,
	toggleTool,
	toolKey,
	toolSearchText,
} from "../src/tui/tool-selection";

const cwd = process.cwd();

describe("toolKey", () => {
	it("uses a spec's own identity", () => {
		expect(toolKey(cua.tools.browser.snapshot())).toBe("cua.browser.snapshot.v1");
		expect(toolKey(cua.tools.browser.act())).toBe("cua.browser.act.v1");
	});

	it("namespaces a plain caller tool as caller.<name>", () => {
		const coding = defaultApplicationTools();
		expect(coding.length).toBeGreaterThan(0);
		for (const tool of coding) {
			expect(toolKey(tool)).toBe(`caller.${tool.name}`);
		}
	});
});

describe("describeTools", () => {
	it("preserves the baseline order the application composed", () => {
		const baseline = [...defaultInteractionTools("openai:gpt-5.6-sol"), ...defaultApplicationTools()];
		expect(describeTools(baseline).map((item) => item.key)).toEqual(baseline.map(toolKey));
	});

	it("labels provider-native, cua, and application groups", () => {
		const items = describeTools([
			...defaultInteractionTools("google:gemini-3.6-flash"),
			...defaultApplicationTools(),
		]);
		const groups = new Set(items.map((item) => item.group));
		expect(groups.has("native")).toBe(true);
		expect(groups.has("application")).toBe(true);

		const cuaItems = describeTools(defaultInteractionTools("openai:gpt-5.6-sol"));
		expect(cuaItems.every((item) => item.group === "cua")).toBe(true);
	});

	it("marks the Yutori n1 native action set as one atomic group", () => {
		const items = describeTools(defaultInteractionTools("yutori:n1-latest"));
		const atomic = items.filter((item) => item.atomicGroup);
		expect(atomic.length).toBeGreaterThan(1);
		expect(new Set(atomic.map((item) => item.atomicGroup))).toEqual(new Set(["provider.yutori.native.n1"]));
		// The screenshot helper the CLI appends is not part of the native set.
		expect(items.some((item) => !item.atomicGroup)).toBe(true);
	});

	it("leaves Yutori n1.5 individually toggleable", () => {
		const items = describeTools(defaultInteractionTools("yutori:n1.5-latest"));
		expect(items.every((item) => item.atomicGroup === undefined)).toBe(true);
	});
});

describe("toolSearchText", () => {
	it("covers the label, group, and identity", () => {
		const [item] = describeTools([cua.tools.browser.snapshot()]);
		const text = toolSearchText(item!);
		expect(text).toContain(item!.label);
		expect(text).toContain("cua");
		expect(text).toContain("cua.browser.snapshot.v1");
	});
});

describe("selection state machine", () => {
	const baseline = [...defaultInteractionTools("openai:gpt-5.6-sol"), ...defaultApplicationTools()];
	const items = describeTools(baseline);
	const allKeys = items.map((item) => item.key);

	it("toggles a single tool off and back on", () => {
		const target = allKeys[0]!;
		const off = toggleTool(new Set(allKeys), items, target);
		expect(off.has(target)).toBe(false);
		expect(off.size).toBe(allKeys.length - 1);
		const on = toggleTool(off, items, target);
		expect(sameSelection(on, new Set(allKeys))).toBe(true);
	});

	it("enables and clears in bulk", () => {
		expect(disableTools(new Set(allKeys), items, allKeys).size).toBe(0);
		expect(sameSelection(enableTools(new Set(), items, allKeys), new Set(allKeys))).toBe(true);
	});

	it("restricts bulk actions to the keys it is given", () => {
		const subset = allKeys.slice(0, 2);
		const cleared = disableTools(new Set(allKeys), items, subset);
		expect(cleared.size).toBe(allKeys.length - 2);
		for (const key of subset) expect(cleared.has(key)).toBe(false);
	});

	it("moves an atomic group as one unit", () => {
		const yutori = describeTools(defaultInteractionTools("yutori:n1-latest"));
		const yutoriKeys = yutori.map((item) => item.key);
		const nativeKeys = yutori.filter((item) => item.atomicGroup).map((item) => item.key);
		const standalone = yutori.filter((item) => !item.atomicGroup).map((item) => item.key);

		const off = toggleTool(new Set(yutoriKeys), yutori, nativeKeys[0]!);
		for (const key of nativeKeys) expect(off.has(key)).toBe(false);
		for (const key of standalone) expect(off.has(key)).toBe(true);

		const on = toggleTool(off, yutori, nativeKeys[1]!);
		for (const key of nativeKeys) expect(on.has(key)).toBe(true);
	});

	it("expands atomic groups for bulk disables too", () => {
		const yutori = describeTools(defaultInteractionTools("yutori:n1-latest"));
		const first = yutori.find((item) => item.atomicGroup)!;
		const cleared = disableTools(new Set(yutori.map((i) => i.key)), yutori, [first.key]);
		expect(yutori.filter((i) => i.atomicGroup).every((i) => !cleared.has(i.key))).toBe(true);
	});
});

describe("sameSelection", () => {
	it("compares by membership, not order", () => {
		expect(sameSelection(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
		expect(sameSelection(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
		expect(sameSelection(new Set(), new Set())).toBe(true);
	});
});
