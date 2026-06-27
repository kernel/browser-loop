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
 * the same way the runtime eventually will), with no real browser or LLM.
 *
 * The loop being proven:
 *   RUN 1  an agent drills into a deep settings page the slow way — goto the
 *          site root, then a menu/submenu/settings click chain (4 base tool
 *          executions).
 *   ->     a meta-agent distills the section -> deep-URL mapping it observed and
 *          authors the `open_section` learned tool (the fixture committed
 *          alongside this test).
 *   ->     host.reload() picks the new extension up from disk.
 *   RUN 2  one `open_section` call resolves the section to its deep URL and
 *          returns the single-navigation plan (1 tool execution).
 *
 * Host APIs under stress: load/reload, reapplyTools (the learned tool ends up
 * both registered and active after reload), and the bridge forwarding
 * `tool_execution_end` with the tool's `details` intact.
 */

const here = dirname(fileURLToPath(import.meta.url));
const LEARNED_TOOL_FIXTURE = join(here, "nav-shortcut-tool", "open-section.ts");

// The drill-down RUN 1 performs by hand. The goto lands on the root; each click
// is one hop deeper through the nav. These coordinates are the menu targets the
// meta-agent watches to learn where the chain terminates.
const ROOT_URL = "https://app.test/";
const MENU_CLICK = { x: 40, y: 24 };
const SUBMENU_CLICK = { x: 80, y: 96 };
const SETTINGS_CLICK = { x: 120, y: 168 };
// The deep URL the drill-down terminates on — the destination the learned tool
// resolves `settings` to in one call.
const DEEP_URL = "https://app.test/settings/profile";

let fx: TestHarnessFixture | undefined;
let host: HarnessExtensionHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	await fx?.dispose();
	fx = undefined;
});

describe("self-improve loop: navigation shortcut replaces a goto/click drill-down", () => {
	it("authors open_section after run 1, reloads it, and run 2 reaches the page in fewer steps", async () => {
		// RUN 1 is scripted as the drill-down; RUN 2 is the single learned-tool call.
		// The scripted provider replays one turn per provider call, so naming
		// `open_section` in a tool_call makes the harness execute the registered
		// learned tool exactly as a model would. A trailing not-found call exercises
		// the degrade-safe branch without polluting the run1-vs-run2 step counts.
		fx = await buildTestHarness({
			turns: [
				// --- RUN 1: goto root, then click the nav chain to the settings page ---
				{ steps: [{ type: "tool_call", toolName: "goto", args: { url: ROOT_URL } }] },
				{ steps: [{ type: "tool_call", toolName: "click", args: MENU_CLICK }] },
				{ steps: [{ type: "tool_call", toolName: "click", args: SUBMENU_CLICK }] },
				{ steps: [{ type: "tool_call", toolName: "click", args: SETTINGS_CLICK }] },
				{ steps: [{ type: "text", text: "run1 done" }] },
				// --- RUN 2: one deep-link resolve via the learned tool ---
				{ steps: [{ type: "tool_call", toolName: "open_section", args: { section: "settings" } }] },
				{ steps: [{ type: "text", text: "run2 done" }] },
				// --- RUN 3: an unknown section hits the learned tool's not-found branch ---
				{ steps: [{ type: "tool_call", toolName: "open_section", args: { section: "billing" } }] },
				{ steps: [{ type: "text", text: "run3 done" }] },
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

		// Sanity: the base computer tools RUN 1 drives are present, and the learned
		// tool is not yet registered.
		const baseToolNames = toolNames(fx.harness);
		expect(baseToolNames).toEqual(expect.arrayContaining(["goto", "click"]));
		expect(baseToolNames).not.toContain("open_section");

		// Count base tool executions per run by toggling which counter the single
		// subscriber feeds. Capture the learned tool's forwarded result/details so
		// the runs can assert the resolved URL came back through the bridge.
		let run1Tools = 0;
		let run2Tools = 0;
		let foundResultText = "";
		let foundDetails: { found?: boolean; url?: string } | undefined;
		let notFoundResultText = "";
		let notFoundDetails: { found?: boolean; section?: string; url?: string } | undefined;
		let activeCounter: "run1" | "run2" | undefined;
		fx.harness.subscribe((event) => {
			if (event.type !== "tool_execution_end") return;
			if (activeCounter === "run1") run1Tools += 1;
			if (activeCounter === "run2") run2Tools += 1;
			if (event.toolName !== "open_section") return;
			const result = event.result as {
				content: Array<{ type: string; text?: string }>;
				details?: { found?: boolean; section?: string; url?: string };
			};
			const text = result.content.map((part) => part.text ?? "").join("");
			if (result.details?.found) {
				foundResultText = text;
				foundDetails = result.details;
			} else {
				notFoundResultText = text;
				notFoundDetails = result.details;
			}
		});

		// RUN 1: the inefficient drill-down. The learned tool does not exist yet.
		expect(activeToolNames(fx.harness)).not.toContain("open_section");
		activeCounter = "run1";
		await fx.harness.prompt("go to settings");

		// META-AGENT step: author the learned tool as a pi extension on disk.
		cpSync(LEARNED_TOOL_FIXTURE, join(extDir, "open-section.ts"));

		// Reload re-discovers the directory from disk and re-applies the tool union.
		await host.reload();

		// reapplyTools must leave the learned tool both registered and active so the
		// model can call it on the next run.
		expect(toolNames(fx.harness)).toContain("open_section");
		expect(activeToolNames(fx.harness)).toContain("open_section");

		// RUN 2: the single learned-tool call resolves the deep URL.
		activeCounter = "run2";
		await fx.harness.prompt("go to settings again");
		activeCounter = undefined;

		// The bridge forwarded the tool result and its details unchanged: the
		// resolved deep URL is in both the navigation plan text and details.url.
		expect(foundDetails).toMatchObject({ found: true, url: DEEP_URL });
		expect(foundResultText).toContain(`navigate to ${DEEP_URL}`);

		// The whole point: the deep-link resolve collapsed the drill-down into one
		// step.
		expect(run1Tools).toBe(4); // goto + click + click + click
		expect(run2Tools).toBe(1); // open_section
		expect(run2Tools).toBeLessThan(run1Tools);

		// RUN 3: an unknown section degrades safely rather than guessing a URL.
		await fx.harness.prompt("open the billing section");
		expect(notFoundDetails).toMatchObject({ found: false, section: "billing" });
		expect(notFoundDetails?.url).toBeUndefined();
		expect(notFoundResultText).toContain("no known deep link for section: billing");
	});
});

function toolNames(harness: TestHarnessFixture["harness"]): string[] {
	return harness.getTools().map((tool) => tool.name);
}

function activeToolNames(harness: TestHarnessFixture["harness"]): string[] {
	return harness.getActiveTools().map((tool) => tool.name);
}
