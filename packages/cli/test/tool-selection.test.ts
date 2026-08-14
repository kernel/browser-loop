import { describe, expect, it } from "vitest";
import { cua } from "@onkernel/cua-ai";
import { defaultApplicationTools, defaultInteractionTools } from "../src/harness";
import {
	describeMenu,
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

describe("describeMenu", () => {
	it("offers the model's whole menu, not just what the application composed", () => {
		const baseline = [...defaultInteractionTools("openai:gpt-5.6-sol"), ...defaultApplicationTools()];
		const items = describeMenu("openai:gpt-5.6-sol", defaultApplicationTools(), baseline);
		expect(items.length).toBeGreaterThan(baseline.length);
		// Not composed by the CLI for this model, but offerable.
		expect(items.some((item) => item.label === "playwright_execute")).toBe(true);
		expect(items.some((item) => item.label === "computer_click")).toBe(true);
	});

	it("marks what the live selection already holds", () => {
		const baseline = [...defaultInteractionTools("openai:gpt-5.6-sol"), ...defaultApplicationTools()];
		const items = describeMenu("openai:gpt-5.6-sol", defaultApplicationTools(), baseline);
		const snapshot = items.find((item) => item.label === "browser_snapshot")!;
		expect(snapshot.available).toBe(true);
		expect(items.filter((item) => item.group === "application").every((item) => item.available)).toBe(true);
	});

	it("marks a tool the model cannot take, with the compiler's reason", () => {
		const items = describeMenu("google:gemini-3.6-flash", defaultApplicationTools(), []);
		const waitFor = items.find((item) => item.label === "browser_wait_for")!;
		expect(waitFor.available).toBe(false);
		expect(waitFor.unavailableReason).toContain("does not accept the schema");

		const openaiNative = items.filter((item) => item.group === "native" && !item.available);
		expect(openaiNative.length).toBeGreaterThan(0);
	});

	it("labels provider-native, cua, and application groups", () => {
		const items = describeMenu("google:gemini-3.6-flash", defaultApplicationTools(), []);
		const groups = new Set(items.map((item) => item.group));
		expect(groups.has("native")).toBe(true);
		expect(groups.has("application")).toBe(true);
		expect(groups.has("browser")).toBe(true);
	});
});

describe("toolSearchText", () => {
	it("covers the label, group, and identity", () => {
		const items = describeMenu("openai:gpt-5.6-sol", [], []);
		const item = items.find((entry) => entry.label === "browser_snapshot")!;
		const text = toolSearchText(item);
		expect(text).toContain(item.label);
		expect(text).toContain("browser");
		expect(text).toContain("cua.browser.snapshot.v1");
	});
});

describe("selection state machine", () => {
	const baseline = [...defaultInteractionTools("openai:gpt-5.6-sol"), ...defaultApplicationTools()];
	const items = describeMenu("openai:gpt-5.6-sol", defaultApplicationTools(), baseline);
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
