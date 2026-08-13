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

	it("rejects a duplicated tool name and leaves the catalog unchanged", async () => {
		const modelRef = "google:gemini-3.6-flash";
		const baseline = [...defaultInteractionTools(modelRef), ...defaultApplicationTools()];
		const fixture = await buildTestHarness({ turns: [], modelRef, tools: baseline });
		const before = fixture.harness.getTools().map(toolKey);

		const [first] = baseline;
		await expect(fixture.harness.setTools([...baseline, first!])).rejects.toThrow(/requested more than once/);
		// Atomicity: the failed compile must not have mutated live state.
		expect(fixture.harness.getTools().map(toolKey)).toEqual(before);
	});

	it("accepts dropping the whole Google native group", async () => {
		const modelRef = "google:gemini-3.6-flash";
		const baseline = [...defaultInteractionTools(modelRef), ...defaultApplicationTools()];
		const fixture = await buildTestHarness({ turns: [], modelRef, tools: baseline });

		const nativeKeys = new Set(describeTools(baseline).filter((item) => item.group === "native").map((item) => item.key));
		const next = baseline.filter((tool) => !nativeKeys.has(toolKey(tool)));

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

		// Mirrors switchModel(): the new model and its interaction catalog compile
		// as one pair, because the selected tools decide the transport.
		await fixture.harness.setModelAndTools(to, [...defaultInteractionTools(to), ...application]);

		const expected = [...defaultInteractionTools(to), ...application].map(toolKey);
		expect(fixture.harness.getTools().map(toolKey)).toEqual(expected);
		expect(fixture.harness.getModel().provider).toBe("anthropic");
	});
});
