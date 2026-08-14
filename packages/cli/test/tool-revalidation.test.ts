import { describe, expect, it } from "vitest";
import { defaultApplicationTools, defaultInteractionTools } from "../src/harness";
import { describeMenu, selectedKeys, toolKey, toolsForSelection } from "../src/tui/tool-selection";
import { buildTestHarness } from "./fixtures/harness";

/**
 * The `/tools` picker applies a selection of the model's tool menu via
 * `catalog.setTools()`. These tests pin the behavior the picker relies on:
 * compile-and-validate happens before any mutation, so a rejected selection
 * leaves the live catalog untouched.
 */
describe("/tools selection revalidation", () => {
	it("accepts a partial Google native subset", async () => {
		const modelRef = "google:gemini-3.6-flash";
		const baseline = [...defaultInteractionTools(modelRef), ...defaultApplicationTools()];
		const fixture = await buildTestHarness({ turns: [], modelRef, tools: baseline });

		const items = describeMenu(modelRef, defaultApplicationTools(), baseline);
		const dropped = items.find((item) => item.group === "native" && item.available)!;
		const next = baseline.filter((tool) => toolKey(tool) !== dropped.key);

		await fixture.catalog.setTools(next);
		expect(fixture.catalog.getTools().map(toolKey)).toEqual(next.map(toolKey));
		expect(fixture.catalog.getTools().map(toolKey)).not.toContain(dropped.key);
	});

	it("rejects a duplicated tool name and leaves the catalog unchanged", async () => {
		const modelRef = "google:gemini-3.6-flash";
		const baseline = [...defaultInteractionTools(modelRef), ...defaultApplicationTools()];
		const fixture = await buildTestHarness({ turns: [], modelRef, tools: baseline });
		const before = fixture.catalog.getTools().map(toolKey);

		const [first] = baseline;
		await expect(fixture.catalog.setTools([...baseline, first!])).rejects.toThrow(/requested more than once/);
		// Atomicity: the failed compile must not have mutated live state.
		expect(fixture.catalog.getTools().map(toolKey)).toEqual(before);
	});

	it("accepts dropping the whole Google native group", async () => {
		const modelRef = "google:gemini-3.6-flash";
		const baseline = [...defaultInteractionTools(modelRef), ...defaultApplicationTools()];
		const fixture = await buildTestHarness({ turns: [], modelRef, tools: baseline });

		const items = describeMenu(modelRef, defaultApplicationTools(), baseline);
		const nativeKeys = new Set(items.filter((item) => item.group === "native").flatMap((item) => item.tools.map(toolKey)));
		const next = baseline.filter((tool) => !nativeKeys.has(toolKey(tool)));

		await fixture.catalog.setTools(next);
		expect(fixture.catalog.getTools().map(toolKey)).toEqual(next.map(toolKey));
	});

	it("accepts an empty selection (text-only agent)", async () => {
		const modelRef = "openai:gpt-5.6-sol";
		const baseline = [...defaultInteractionTools(modelRef), ...defaultApplicationTools()];
		const fixture = await buildTestHarness({ turns: [], modelRef, tools: baseline });

		await fixture.catalog.setTools([]);
		expect(fixture.catalog.getTools()).toEqual([]);
	});

	it("recomposes the baseline after a model switch across providers", async () => {
		const cwd = process.cwd();
		const from = "openai:gpt-5.6-sol";
		const to = "anthropic:claude-opus-5";
		const application = defaultApplicationTools();
		const fixture = await buildTestHarness({
			turns: [],
			modelRef: from,
			tools: [...defaultInteractionTools(from), ...application],
		});

		// Mirrors switchModel(): the new model and its interaction catalog compile
		// as one pair, because the selected tools decide the transport.
		await fixture.catalog.setModelAndTools(to, [...defaultInteractionTools(to), ...application]);

		const expected = [...defaultInteractionTools(to), ...application].map(toolKey);
		expect(fixture.catalog.getTools().map(toolKey)).toEqual(expected);
		expect(fixture.harness.getModel().provider).toBe("anthropic");
	});

	it("adds a tool the application never composed", async () => {
		const modelRef = "openai:gpt-5.6-sol";
		const baseline = [...defaultInteractionTools(modelRef), ...defaultApplicationTools()];
		const fixture = await buildTestHarness({ turns: [], modelRef, tools: baseline });
		expect(baseline.some((tool) => tool.name === "playwright_execute")).toBe(false);

		// The picker offers the model's whole menu, not just the baseline, so a
		// selection can grow past what the CLI composed.
		const items = describeMenu(modelRef, defaultApplicationTools(), baseline);
		const playwright = items.find((item) => item.label === "playwright_execute")!;
		expect(playwright.available).toBe(true);

		const enabled = new Set([...selectedKeys(items, baseline), playwright.key]);
		await fixture.catalog.setTools(toolsForSelection(items, enabled));
		expect(fixture.catalog.getTools().map((tool) => tool.name)).toContain("playwright_execute");
	});
});
