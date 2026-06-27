import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessExtensionHost } from "../../src/extensions/host";
import { buildTestHarness, type TestHarnessFixture } from "../fixtures/harness";

/**
 * End-to-end self-improve loop against HarnessExtensionHost.
 *
 * A pixel-only agent reads a results table the slow way: scroll, screenshot,
 * scroll, screenshot. A meta-agent then authors a learned tool that parses the
 * table's HTML in one structured call. After the host reloads to pick the file
 * up, the next run resolves the whole table in a single tool call.
 *
 * Both runs are scripted deterministically, so this drives the host directly
 * (the CLI runtime does not wire the host in yet) with no real browser or LLM.
 */

const here = dirname(fileURLToPath(import.meta.url));
const LEARNED_TOOL_FIXTURE = join(here, "dom-table-extraction", "extract-table.ts");

// The page content the agent would otherwise have stitched together across
// screenshots. The learned tool reads it in one call instead.
const TABLE_HTML =
	"<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>";
const EXPECTED_ROWS = [
	["a", "b"],
	["1", "2"],
];

let fx: TestHarnessFixture | undefined;
let host: HarnessExtensionHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	await fx?.dispose();
	fx = undefined;
});

/** Count tool_execution_end events for the duration of one prompt, scoped by an
 * optional tool-name filter. Returns the count plus an unsubscribe to call when
 * the run finishes so it does not bleed into the next run. */
function countToolRuns(
	harness: TestHarnessFixture["harness"],
	toolName?: string,
): { counter: { value: number }; stop: () => void } {
	const counter = { value: 0 };
	const stop = harness.subscribe((event) => {
		if (event.type !== "tool_execution_end") return;
		if (toolName && event.toolName !== toolName) return;
		counter.value += 1;
	});
	return { counter, stop };
}

describe("self-improve: DOM table extraction", () => {
	it("replaces a scroll/screenshot loop with a learned structured-read tool after reload", async () => {
		// RUN 1 turns (base computer tools): a scroll/screenshot hunt down the
		// table, ending on a plain-text turn so the agent run stops. RUN 2 turns:
		// a single call to the learned tool, then a stop. The scripted provider
		// replays one turn per provider call across both runs.
		fx = await buildTestHarness({
			turns: [
				// RUN 1: pixel-only walk of the table.
				{ steps: [{ type: "tool_call", toolName: "scroll", args: { dx: 0, dy: 500 } }] },
				{ steps: [{ type: "tool_call", toolName: "screenshot", args: {} }] },
				{ steps: [{ type: "tool_call", toolName: "screenshot", args: {} }] },
				{ steps: [{ type: "text", text: "run1 done" }] },
				// RUN 2: one structured read replaces the whole loop.
				{
					steps: [
						{ type: "tool_call", toolName: "extract_table_rows", args: { html: TABLE_HTML } },
					],
				},
				{ steps: [{ type: "text", text: "run2 done" }] },
			],
		});

		// The host starts pointed at an empty discovery dir: the learned tool does
		// not exist during RUN 1. The meta-agent authors it between the two runs.
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		host = new HarnessExtensionHost({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			configuredPaths: [extDir],
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
		});
		await host.load();

		// Sanity: the base computer tools RUN 1 drives are present, and the learned
		// tool is not yet registered.
		const baseToolNames = fx.harness.getTools().map((tool) => tool.name);
		expect(baseToolNames).toEqual(expect.arrayContaining(["scroll", "screenshot"]));
		expect(baseToolNames).not.toContain("extract_table_rows");

		// RUN 1: the inefficient pixel walk. Count its tool executions.
		const run1 = countToolRuns(fx.harness);
		await fx.harness.prompt("read every row of the results table");
		run1.stop();
		expect(run1.counter.value).toBe(3); // scroll + screenshot + screenshot

		// META-AGENT step: author the learned tool as a pi extension on disk.
		cpSync(LEARNED_TOOL_FIXTURE, join(extDir, "extract-table.ts"));

		// Reload re-discovers the directory from disk and re-applies the tool union.
		await host.reload();

		// The learned tool is now registered and active on the harness.
		expect(fx.harness.getTools().map((tool) => tool.name)).toContain("extract_table_rows");
		expect(fx.harness.getActiveTools().map((tool) => tool.name)).toContain(
			"extract_table_rows",
		);

		// RUN 2: capture the learned tool's bridged result and count its executions.
		let learnedResultText = "";
		let learnedRows: unknown;
		const run2 = countToolRuns(fx.harness, "extract_table_rows");
		const captureResult = fx.harness.subscribe((event) => {
			if (event.type !== "tool_execution_end" || event.toolName !== "extract_table_rows") return;
			const result = event.result as {
				content: Array<{ type: string; text?: string }>;
				details?: { rows?: unknown };
			};
			learnedResultText = result.content.map((part) => part.text ?? "").join("");
			learnedRows = result.details?.rows;
		});
		await fx.harness.prompt("read the results table again");
		run2.stop();
		captureResult();

		// The learned tool ran exactly once and produced structured rows...
		expect(run2.counter.value).toBe(1);
		expect(learnedResultText).toContain("extracted 2 rows");
		expect(learnedRows).toEqual(EXPECTED_ROWS);

		// ...and the self-improve payoff: the second run used fewer steps.
		expect(run2.counter.value).toBeLessThan(run1.counter.value);
	});
});
