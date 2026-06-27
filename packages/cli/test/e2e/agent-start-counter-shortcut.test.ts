import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessExtensionHost } from "../../src/extensions/host";
import { buildTestHarness, type TestHarnessFixture } from "../fixtures/harness";

/**
 * End-to-end self-improve loop for HarnessExtensionHost: a computer-use agent
 * paginates a list inefficiently, a meta-agent authors a learned tool as a pi
 * extension, the host reloads it, and the next run resolves the whole list in
 * one call to the learned tool.
 *
 * What this scenario proves beyond the basic loop: the learned tool keeps an
 * `agent_start`-incremented run counter and reports it in its result, so the
 * test observes that the host re-binds an extension's `pi.on` handlers after
 * reload — the bridge re-delivers `agent_start` to the freshly-imported
 * extension on the second run.
 *
 * The learned tool also de-duplicates items across page boundaries, which is the
 * concrete inefficiency the pixel agent had: it screenshotted each page and
 * re-read the rows overlapping the previous page, double-counting them.
 *
 * The fake harness is built without `playwright: true` and its Kernel client has
 * no daemon, so the learned tool operates as pure JS over an `html` parameter
 * that stands in for the page markup the agent would otherwise stitch together
 * across screenshots. The mechanism under test is the host loop, not a browser.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** The meta-agent's deliverable — the learned-tool extension committed alongside this test. */
const LEARNED_TOOL_EXTENSION = join(here, "agent-start-counter-shortcut", "collect-items.ts");

/**
 * Two "pages" of a list concatenated as the agent would have stitched them from
 * successive screenshots. "y" is the last item of page one and the first item of
 * page two: the overlap a pixel agent double-counts and the learned tool folds
 * into a single occurrence.
 */
const PAGINATED_HTML =
	"<ul><li>x</li><li>y</li></ul><ul><li>y</li><li>z</li></ul>";

/** The unique, de-duplicated items the learned tool must recover from the blob. */
const EXPECTED_ITEMS = ["x", "y", "z"];

let fx: TestHarnessFixture | undefined;
let host: HarnessExtensionHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	await fx?.dispose();
	fx = undefined;
});

interface ToolEndTap {
	/** Names of every tool that finished, in completion order. */
	names: string[];
	/** Latest `collect_unique_items` result text, if it ran. */
	collectText: string;
	/** Latest `collect_unique_items` result details, if it ran. */
	collectDetails: { items?: string[]; agentRuns?: number } | undefined;
}

/**
 * Subscribe to the harness and record tool completions. The bridge forwards each
 * `tool_execution_end` with the full tool result, so this taps the same channel
 * the host's bridge uses to observe both base-tool steps and the learned tool's
 * structured output.
 */
function tapToolEnds(harness: TestHarnessFixture["harness"]): { tap: ToolEndTap; stop: () => void } {
	const tap: ToolEndTap = { names: [], collectText: "", collectDetails: undefined };
	const stop = harness.subscribe((event) => {
		if (event.type !== "tool_execution_end") return;
		tap.names.push(event.toolName);
		if (event.toolName !== "collect_unique_items") return;
		const result = event.result as {
			content?: Array<{ type: string; text?: string }>;
			details?: { items?: string[]; agentRuns?: number };
		};
		tap.collectText = (result.content ?? []).map((part) => part.text ?? "").join("");
		tap.collectDetails = result.details;
	});
	return { tap, stop };
}

describe("HarnessExtensionHost self-improve: pagination de-dup extractor", () => {
	it("learns collect_unique_items, re-binds its agent_start handler on reload, and runs it in one step", async () => {
		// RUN 1 scripts the inefficient pagination: screenshot a page, click to the
		// next, repeat — five base computer-use tool calls — then stop. RUN 2 scripts
		// the single learned-tool call against the stitched page HTML, then stops.
		fx = await buildTestHarness({
			turns: [
				// RUN 1: five base steps. One tool call per assistant turn (the CUA
				// convention the scripted provider replays), each followed by the next
				// provider turn, ending with a text turn that stops the run.
				{ steps: [{ type: "tool_call", toolName: "screenshot", args: {} }] },
				{ steps: [{ type: "tool_call", toolName: "click", args: { x: 980, y: 600 } }] },
				{ steps: [{ type: "tool_call", toolName: "screenshot", args: {} }] },
				{ steps: [{ type: "tool_call", toolName: "click", args: { x: 980, y: 600 } }] },
				{ steps: [{ type: "tool_call", toolName: "screenshot", args: {} }] },
				{ steps: [{ type: "text", text: "run1 done" }] },
				// RUN 2: the learned tool replaces all of the above with one call.
				{
					steps: [
						{ type: "tool_call", toolName: "collect_unique_items", args: { html: PAGINATED_HTML } },
					],
				},
				{ steps: [{ type: "text", text: "run2 done" }] },
			],
		});

		// The host loads over an empty discovery directory: before the meta-agent
		// writes the learned tool, only base tools exist. This is the honest start
		// state of the self-improve loop — RUN 1 cannot call a tool that isn't there.
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		host = new HarnessExtensionHost({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			configuredPaths: [extDir],
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
		});
		await host.load();
		expect(fx.harness.getTools().map((tool) => tool.name)).not.toContain("collect_unique_items");

		// RUN 1: drive the inefficient pagination and count the base-tool steps.
		const run1 = tapToolEnds(fx.harness);
		await fx.harness.prompt("list all items");
		run1.stop();
		const run1Steps = run1.tap.names.length;
		expect(run1.tap.names).toEqual(["screenshot", "click", "screenshot", "click", "screenshot"]);
		expect(run1Steps).toBe(5);

		// Meta-agent deliverable: author the learned tool into the discovery dir.
		// Copying the committed fixture stands in for the meta-agent writing the
		// extension file after analyzing RUN 1.
		cpSync(LEARNED_TOOL_EXTENSION, join(extDir, "collect-items.ts"));

		// Reload picks up the newly-authored file: re-discovers extensions from
		// disk, registers + activates the learned tool, and re-binds its pi.on
		// handlers onto the fresh runner's event bus.
		await host.reload();
		expect(fx.harness.getTools().map((tool) => tool.name)).toContain("collect_unique_items");
		expect(fx.harness.getActiveTools().map((tool) => tool.name)).toContain("collect_unique_items");

		// RUN 2: the agent calls the learned tool once. Its agent_start fires first,
		// so the freshly-bound handler increments the counter before execute reads it.
		const run2 = tapToolEnds(fx.harness);
		await fx.harness.prompt("list all items again");
		run2.stop();
		const run2Steps = run2.tap.names.length;

		// The learned tool ran, and it ran exactly once — pagination collapsed to a
		// single structured read.
		expect(run2.tap.names).toEqual(["collect_unique_items"]);
		expect(run2Steps).toBe(1);

		// It recovered the unique items, de-duplicating "y" across the page boundary.
		expect(run2.tap.collectDetails?.items).toEqual(EXPECTED_ITEMS);
		expect(run2.tap.collectText).toContain("collected 3 unique");

		// Re-bind proof: the result reports runs=1, meaning the bridge re-delivered
		// agent_start to the reloaded extension and its pi.on handler fired. If reload
		// had not re-bound the handler the counter would be 0 (runs=0). It is 1, not 2,
		// because discoverAndLoadExtensions imports each extension fresh from disk
		// (the loader sets moduleCache:false), so reload starts a new module instance
		// with the counter reset — RUN 1's increment lived on the prior generation.
		// What survives reload is the binding, not the accumulated count.
		expect(run2.tap.collectDetails?.agentRuns).toBe(1);
		expect(run2.tap.collectText).toContain("runs=1");

		// The whole point of the learned tool: RUN 2 used far fewer steps than RUN 1.
		expect(run2Steps).toBeLessThan(run1Steps);
	});
});
