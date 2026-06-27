import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { HarnessExtensionHost } from "../../src/extensions/host";
import { buildTestHarness, type TestHarnessFixture } from "../fixtures/harness";

/**
 * End-to-end self-improve loop driven directly against HarnessExtensionHost
 * (the cua CLI runtime does not wire the host yet, so the host is exercised here
 * the same way the runtime eventually will).
 *
 * The loop being proven:
 *   RUN 1  a pixel-only agent hunts for a fixed-icon control — screenshot,
 *          scroll, screenshot again, then click by a guessed coordinate
 *          (4 base tool executions).
 *   ->     a meta-agent saves the crop around that successful click as a
 *          template and authors the `click_template` learned tool (the fixture
 *          committed alongside this test).
 *   ->     host.reload() picks the new extension up from disk.
 *   RUN 2  one `click_template` call locates the template in the current frame
 *          and returns the exact click coordinate (1 tool execution).
 *
 * The host APIs under stress: load/reload, reapplyTools (the learned tool is
 * registered *and* active after reload), and the bridge forwarding
 * `tool_execution_end` with the tool's `details` intact.
 */

const here = dirname(fileURLToPath(import.meta.url));
const LEARNED_TOOL_FIXTURE = join(here, "template-match-click", "click-template.ts");

// An 8x6 grayscale frame with a 2x2 marker patch whose top-left is (4,3); the
// patch center — the click target — is therefore (5,4). The template is the 2x2
// crop of that marker. These plain arrays stand in for the live frame and the
// saved crop, since the fake harness exposes no real screenshot pixels.
const HAYSTACK_W = 8;
const HAYSTACK_H = 6;
const TEMPLATE_W = 2;
const TEMPLATE_H = 2;
const MARKER = 9;
const SCREENSHOT = buildFrameWithMarker();
const TEMPLATE = [MARKER, MARKER, MARKER, MARKER];
const EXPECTED_HIT = { x: 5, y: 4 };

let fx: TestHarnessFixture | undefined;
let host: HarnessExtensionHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	await fx?.dispose();
	fx = undefined;
});

describe("self-improve loop: template-match click replaces a scroll-and-hunt loop", () => {
	it("authors click_template after run 1, reloads it, and run 2 uses it in fewer steps", async () => {
		// RUN 1 is scripted as the hunt; RUN 2 is the single learned-tool call. The
		// scripted provider replays one turn per provider call, so naming
		// `click_template` in a tool_call makes the harness execute the registered
		// learned tool exactly as a model would.
		fx = await buildTestHarness({
			turns: [
				// --- RUN 1: hunt for the control across scroll positions ---
				{ steps: [{ type: "tool_call", toolName: "screenshot", args: {} }] },
				{ steps: [{ type: "tool_call", toolName: "scroll", args: { dx: 0, dy: 400 } }] },
				{ steps: [{ type: "tool_call", toolName: "screenshot", args: {} }] },
				{ steps: [{ type: "tool_call", toolName: "click", args: EXPECTED_HIT }] },
				{ steps: [{ type: "text", text: "run1 done" }] },
				// --- RUN 2: one deterministic locate via the learned tool ---
				{
					steps: [
						{
							type: "tool_call",
							toolName: "click_template",
							args: {
								screenshot: SCREENSHOT,
								hw: HAYSTACK_W,
								hh: HAYSTACK_H,
								template: TEMPLATE,
								nw: TEMPLATE_W,
								nh: TEMPLATE_H,
							},
						},
					],
				},
				{ steps: [{ type: "text", text: "run2 done" }] },
			],
		});

		// The discovery dir starts empty: at run 1 the meta-agent has not authored
		// the learned tool yet. It is written here between the runs, then reload
		// picks it up — modeling the self-improve timeline honestly.
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));

		host = new HarnessExtensionHost({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			configuredPaths: [extDir],
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
		});
		await host.load();

		// Count base tool executions per run by toggling which counter the single
		// subscriber feeds. Capture the learned tool's forwarded result/details so
		// run 2 can assert the coordinate came back through the bridge.
		let run1Tools = 0;
		let run2Tools = 0;
		let activeCounter: "run1" | "run2" | undefined;
		let learnedResultText = "";
		let learnedDetails: { found?: boolean; x?: number; y?: number } | undefined;
		fx.harness.subscribe((event) => {
			if (event.type !== "tool_execution_end") return;
			if (activeCounter === "run1") run1Tools += 1;
			if (activeCounter === "run2") run2Tools += 1;
			if (event.toolName === "click_template") {
				const content = (event.result as { content: Array<{ type: string; text?: string }> }).content;
				learnedResultText = content.map((part) => part.text ?? "").join("");
				learnedDetails = (event.result as { details?: typeof learnedDetails }).details;
			}
		});

		// RUN 1: the learned tool does not exist yet.
		expect(activeToolNames(fx.harness)).not.toContain("click_template");
		activeCounter = "run1";
		await fx.harness.prompt("click submit");

		// The meta-agent analyzes run 1 and authors the learned tool to disk; reload
		// discovers it from the previously-empty directory.
		cpSync(LEARNED_TOOL_FIXTURE, join(extDir, "click-template.ts"));
		await host.reload();

		// reapplyTools must leave the learned tool both registered and active so the
		// model can call it on the next run.
		expect(toolNames(fx.harness)).toContain("click_template");
		expect(activeToolNames(fx.harness)).toContain("click_template");

		// RUN 2: the single learned-tool call returns the coordinate.
		activeCounter = "run2";
		await fx.harness.prompt("click submit again");
		activeCounter = undefined;

		// The bridge forwarded the tool result and its details unchanged.
		expect(learnedResultText).toContain(`located at ${EXPECTED_HIT.x},${EXPECTED_HIT.y}`);
		expect(learnedDetails).toMatchObject({ found: true, x: EXPECTED_HIT.x, y: EXPECTED_HIT.y });

		// The whole point: the learned tool collapsed the hunt into one step.
		expect(run1Tools).toBe(4);
		expect(run2Tools).toBe(1);
		expect(run2Tools).toBeLessThan(run1Tools);
	});
});

function toolNames(harness: TestHarnessFixture["harness"]): string[] {
	return harness.getTools().map((tool) => tool.name);
}

function activeToolNames(harness: TestHarnessFixture["harness"]): string[] {
	return harness.getActiveTools().map((tool) => tool.name);
}

/** 8x6 zero frame with the 2x2 marker placed so its center is (5,4). */
function buildFrameWithMarker(): number[] {
	const frame = new Array<number>(HAYSTACK_W * HAYSTACK_H).fill(0);
	const left = 4;
	const top = 3;
	for (let ty = 0; ty < TEMPLATE_H; ty++) {
		for (let tx = 0; tx < TEMPLATE_W; tx++) {
			frame[(top + ty) * HAYSTACK_W + (left + tx)] = MARKER;
		}
	}
	return frame;
}
