import { describe, expect, it } from "vitest";
import { defaultApplicationTools, defaultInteractionTools } from "../src/harness";
import { describeTools, toolKey } from "../src/tui/tool-selection";
import { buildTestHarness } from "./fixtures/harness";

/**
 * The `/tools` picker applies a subset of the application-owned baseline via
 * `harness.setTools()`. These tests pin the behavior the picker relies on:
 * compile-and-validate happens before any mutation, so a rejected selection
 * leaves the live catalog untouched.
 */
describe("/tools selection revalidation", () => {
	it("accepts a partial Google native subset", async () => {
		const modelRef = "google:gemini-3.6-flash";
		const baseline = [...defaultInteractionTools(modelRef), ...defaultApplicationTools()];
		const fixture = await buildTestHarness({ turns: [], modelRef, tools: baseline });

		const items = describeTools(baseline);
		const dropped = items.find((item) => item.group === "native")!;
		const next = baseline.filter((tool) => toolKey(tool) !== dropped.key);

		await fixture.harness.setTools(next);
		expect(fixture.harness.getTools().map(toolKey)).toEqual(next.map(toolKey));
		expect(fixture.harness.getTools().map(toolKey)).not.toContain(dropped.key);
	});

	it("rejects a partial Yutori n1 native subset and leaves the catalog unchanged", async () => {
		const modelRef = "yutori:n1-latest";
		const baseline = [...defaultInteractionTools(modelRef), ...defaultApplicationTools()];
		const fixture = await buildTestHarness({ turns: [], modelRef, tools: baseline });
		const before = fixture.harness.getTools().map(toolKey);

		const items = describeTools(baseline);
		const oneNative = items.find((item) => item.atomicGroup)!;
		const partial = baseline.filter((tool) => toolKey(tool) !== oneNative.key);

		await expect(fixture.harness.setTools(partial)).rejects.toThrow(/partial native action set/);
		// Atomicity: the failed compile must not have mutated live state.
		expect(fixture.harness.getTools().map(toolKey)).toEqual(before);
	});

	it("accepts dropping the whole Yutori n1 native group", async () => {
		const modelRef = "yutori:n1-latest";
		const baseline = [...defaultInteractionTools(modelRef), ...defaultApplicationTools()];
		const fixture = await buildTestHarness({ turns: [], modelRef, tools: baseline });

		const items = describeTools(baseline);
		const atomicKeys = new Set(items.filter((item) => item.atomicGroup).map((item) => item.key));
		const next = baseline.filter((tool) => !atomicKeys.has(toolKey(tool)));

		await fixture.harness.setTools(next);
		expect(fixture.harness.getTools().map(toolKey)).toEqual(next.map(toolKey));
	});

	it("accepts an empty selection (text-only agent)", async () => {
		const modelRef = "openai:gpt-5.6-sol";
		const baseline = [...defaultInteractionTools(modelRef), ...defaultApplicationTools()];
		const fixture = await buildTestHarness({ turns: [], modelRef, tools: baseline });

		await fixture.harness.setTools([]);
		expect(fixture.harness.getTools()).toEqual([]);
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

		// Mirrors the TUI's three-step transition in switchModel().
		await fixture.harness.setTools(application);
		await fixture.harness.setModel(to);
		await fixture.harness.setTools([...defaultInteractionTools(to), ...application]);

		const expected = [...defaultInteractionTools(to), ...application].map(toolKey);
		expect(fixture.harness.getTools().map(toolKey)).toEqual(expected);
		expect(fixture.harness.getModel().provider).toBe("anthropic");
	});
});
