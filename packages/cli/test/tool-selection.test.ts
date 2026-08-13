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
		const off = toggleTool(new Set(allKeys), target);
		expect(off.has(target)).toBe(false);
		expect(off.size).toBe(allKeys.length - 1);
		const on = toggleTool(off, target);
		expect(sameSelection(on, new Set(allKeys))).toBe(true);
	});

	it("enables and clears in bulk", () => {
		expect(disableTools(new Set(allKeys), allKeys).size).toBe(0);
		expect(sameSelection(enableTools(new Set(), allKeys), new Set(allKeys))).toBe(true);
	});

	it("restricts bulk actions to the keys it is given", () => {
		const subset = allKeys.slice(0, 2);
		const cleared = disableTools(new Set(allKeys), subset);
		expect(cleared.size).toBe(allKeys.length - 2);
		for (const key of subset) expect(cleared.has(key)).toBe(false);
	});
});

describe("sameSelection", () => {
	it("compares by membership, not order", () => {
		expect(sameSelection(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
		expect(sameSelection(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
		expect(sameSelection(new Set(), new Set())).toBe(true);
	});
});
