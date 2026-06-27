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
 * An agent fills the same signup form the slow way: one click+type pair per
 * field (name, email) plus a final submit click. A meta-agent then authors a
 * learned macro tool that takes the field values in one object and emits the
 * full ordered action plan in a single call. After the host reloads to pick the
 * file up, the next run fills the form with a single tool call.
 *
 * Both runs are scripted deterministically, so this drives the host directly
 * (the CLI runtime does not wire the host in yet) with no real browser or LLM.
 */

const here = dirname(fileURLToPath(import.meta.url));
const LEARNED_TOOL_FIXTURE = join(here, "form-fill-macro", "fill-form.ts");

// The values the agent enters into the form on both runs. On RUN 2 they are
// passed to the learned macro as one object instead of typed field by field.
const FORM_VALUES = { name: "Ada", email: "ada@x.test" };
// The plan the macro is expected to emit: click+type per field, then submit.
const EXPECTED_PLAN_LENGTH = 5;

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

describe("self-improve: form-fill macro", () => {
	it("replaces a per-field click/type sequence with a learned macro tool after reload", async () => {
		// RUN 1 turns: the manual fill — a click+type pair per field then a submit
		// click, ending on a plain-text turn so the agent run stops. RUN 2 turns: a
		// single call to the learned macro, then a stop. The scripted provider
		// replays one turn per provider call across both runs. click and type are
		// registered base computer tools, so each of the five RUN 1 calls executes
		// against the fake kernel and emits a tool_execution_end. That per-field
		// grind (5 executions) is the cost the learned macro collapses.
		fx = await buildTestHarness({
			turns: [
				// RUN 1: per-field click/type plus submit.
				{ steps: [{ type: "tool_call", toolName: "click", args: { x: 220, y: 140 } }] },
				{ steps: [{ type: "tool_call", toolName: "type", args: { text: FORM_VALUES.name } }] },
				{ steps: [{ type: "tool_call", toolName: "click", args: { x: 220, y: 200 } }] },
				{ steps: [{ type: "tool_call", toolName: "type", args: { text: FORM_VALUES.email } }] },
				{ steps: [{ type: "tool_call", toolName: "click", args: { x: 220, y: 260 } }] },
				{ steps: [{ type: "text", text: "run1 done" }] },
				// RUN 2: one macro call fills the whole form.
				{
					steps: [
						{ type: "tool_call", toolName: "fill_signup_form", args: { values: FORM_VALUES } },
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

		// Sanity: the learned macro is not registered before the meta-agent writes it.
		expect(fx.harness.getTools().map((tool) => tool.name)).not.toContain("fill_signup_form");

		// RUN 1: the manual per-field fill. Count its tool executions.
		const run1 = countToolRuns(fx.harness);
		await fx.harness.prompt("fill the signup form");
		run1.stop();
		expect(run1.counter.value).toBe(5); // click,type,click,type,click

		// META-AGENT step: author the learned macro as a pi extension on disk.
		cpSync(LEARNED_TOOL_FIXTURE, join(extDir, "fill-form.ts"));

		// Reload re-discovers the directory from disk and re-applies the tool union.
		await host.reload();

		// The learned macro is now registered and active on the harness.
		expect(fx.harness.getTools().map((tool) => tool.name)).toContain("fill_signup_form");
		expect(fx.harness.getActiveTools().map((tool) => tool.name)).toContain("fill_signup_form");

		// RUN 2: capture the learned macro's bridged result and count its executions.
		let macroResultText = "";
		let macroPlan: Array<{ action: string; x?: number; y?: number; text?: string }> | undefined;
		const run2 = countToolRuns(fx.harness, "fill_signup_form");
		const captureResult = fx.harness.subscribe((event) => {
			if (event.type !== "tool_execution_end" || event.toolName !== "fill_signup_form") return;
			const result = event.result as {
				content: Array<{ type: string; text?: string }>;
				details?: { plan?: typeof macroPlan };
			};
			macroResultText = result.content.map((part) => part.text ?? "").join("");
			macroPlan = result.details?.plan;
		});
		await fx.harness.prompt("fill the signup form again");
		run2.stop();
		captureResult();

		// The learned macro ran exactly once and emitted the full ordered plan...
		expect(run2.counter.value).toBe(1);
		expect(macroResultText).toContain(`planned ${EXPECTED_PLAN_LENGTH} actions`);
		expect(macroPlan).toBeDefined();
		expect(macroPlan).toHaveLength(EXPECTED_PLAN_LENGTH);
		// ...with the supplied values landing in the type actions, in field order...
		expect(macroPlan?.[1]).toMatchObject({ action: "type", text: FORM_VALUES.name });
		expect(macroPlan?.[3]).toMatchObject({ action: "type", text: FORM_VALUES.email });
		// ...the clicks bracketing them, ending on the submit click...
		expect(macroPlan?.[0].action).toBe("click");
		expect(macroPlan?.[2].action).toBe("click");
		expect(macroPlan?.[4].action).toBe("click");

		// ...and the self-improve payoff: the second run used fewer steps.
		expect(run2.counter.value).toBeLessThan(run1.counter.value);
	});
});
