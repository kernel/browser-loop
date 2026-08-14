import { describe, test } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { CuaModelRef } from "@onkernel/cua-ai";
import { defaultApplicationTools, defaultInteractionTools } from "../src/harness";
import { describeMenu } from "../src/tui/tool-selection";

/**
 * Drive the interactive TUI through ptywright with a scripted provider sitting
 * below the real {@link CuaAgentHarness}. The runner script ({@link tuiRunnerPath})
 * registers the scripted provider, assembles the harness via the production
 * {@link buildCuaHarness}, and starts {@link runInteractive}. Each test case
 * spawns a fresh process with its own per-scenario fixture JSON so the
 * scripted provider's sequential turn replay never crosses scenarios.
 *
 * ptywright requires a native ghostty-vt binding (built via Zig). When that
 * binding is missing the suite is skipped by default; set PTYWRIGHT_REQUIRED=1
 * (CI uses this) to turn the silent skip into a failure.
 */

const tuiRunnerPath = fileURLToPath(new URL("./fixtures/tui-fixture-runner.ts", import.meta.url));
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");
const fixtureDir = fileURLToPath(new URL("./fixtures/tui-fixtures/", import.meta.url));
const cwd = fileURLToPath(new URL("../", import.meta.url));

const ptywrightDist = fileURLToPath(new URL("../../ptywright/dist/index.js", import.meta.url));
const ptywrightNative = resolve(dirname(ptywrightDist), "..", "native", "build", "Release", "ptywright_native.node");
const ptywrightAvailable = existsSync(ptywrightNative);

if (!ptywrightAvailable && process.env.PTYWRIGHT_REQUIRED) {
	throw new Error(
		`ptywright native binding not found at ${ptywrightNative}; build with 'npm run build --workspace @onkernel/ptywright' or unset PTYWRIGHT_REQUIRED`,
	);
}

const suite = ptywrightAvailable ? describe : describe.skip;
const WAIT_MS = 15_000;
/**
 * Pickers render their frame across several component updates, so snapshot
 * assertions must wait for the screen to settle first.
 */
const STABLE_MS = 250;

/**
 * The baseline size the `/tools` picker reports for a `tools: true` fixture,
 * derived from the same production defaults the fixture runner assembles.
 * Deriving it keeps these assertions from churning whenever a default tool is
 * added or removed, while still pinning the exact number the picker shows.
 */
function baselineToolCount(modelRef: string): number {
	return defaultInteractionTools(modelRef as CuaModelRef).length + defaultApplicationTools().length;
}

/**
 * Rows the picker can select for a model. The footer counts selectable rows,
 * not the baseline: `/tools` offers the model's whole menu, of which the
 * application-composed baseline is just the part enabled on open.
 */
function selectableToolCount(modelRef: string): number {
	const application = defaultApplicationTools();
	const baseline = [...defaultInteractionTools(modelRef as CuaModelRef), ...application];
	return describeMenu(modelRef as CuaModelRef, application, baseline).filter((item) => item.available).length;
}

suite("TUI ptywright scenarios", () => {
	test("streams assistant text into the message list", async (ctx) => {
		const { spawnFixture, exitFixture, waitForFixtureReady } = await loadPtywrightHelpers();
		const session = spawnFixture("streaming.json");
		ctx.onTestFinished(() => session.close());

		await waitForFixtureReady(session);

		// The pi-styled preamble renders the "cua v<version>" logo and a
		// key-hint row reflecting cua's real bindings.
		const preamble = session.snapshot();
		assert.match(preamble.visible, /cua v/);
		assert.match(preamble.visible, /to interrupt/);
		assert.match(preamble.visible, /for commands/);

		session.line("say hi");
		await session.waitForVisible("fixture response", { timeoutMs: WAIT_MS });

		const snapshot = session.snapshot();
		assert.match(snapshot.visible, /say hi/);
		assert.match(snapshot.visible, /fixture response/);

		await exitFixture(session);
	});

	test("renders [Context] and [Skills] sections and no [Extensions]", async (ctx) => {
		const { spawnFixture, exitFixture, waitForFixtureReady } = await loadPtywrightHelpers();
		const session = spawnFixture("resources.json");
		ctx.onTestFinished(() => session.close());

		await waitForFixtureReady(session);

		const snapshot = session.snapshot();
		assert.match(snapshot.visible, /\[Context\]/);
		assert.match(snapshot.visible, /AGENTS\.md/);
		assert.match(snapshot.visible, /\[Skills\]/);
		assert.match(snapshot.visible, /deploy-skill/);
		assert.match(snapshot.visible, /review-skill/);
		assert.doesNotMatch(snapshot.visible, /\[Extensions\]/);

		await exitFixture(session);
	});

	test("keeps multiline drafts left aligned", async (ctx) => {
		const { spawnFixture, exitFixture, waitForFixtureReady, KeyEnter } = await loadPtywrightHelpers();
		const session = spawnFixture("multiline.json");
		ctx.onTestFinished(() => session.close());

		await waitForFixtureReady(session);
		session.send("first line\\");
		session.press(KeyEnter);
		session.send("second line");
		await session.waitForVisible("second line", { timeoutMs: WAIT_MS });

		const beforeSubmit = session.snapshot();
		assert.match(beforeSubmit.visible, /^second line/m);
		assert.doesNotMatch(beforeSubmit.visible, /^\s+second line/m);

		session.press(KeyEnter);
		await session.waitForVisible("multiline ok", { timeoutMs: WAIT_MS });

		await exitFixture(session);
	});

	test("queues input during a running turn for the next agent step", async (ctx) => {
		const { spawnFixture, exitFixture, waitForFixtureReady } = await loadPtywrightHelpers();
		const session = spawnFixture("steer.json");
		ctx.onTestFinished(() => session.close());

		await waitForFixtureReady(session);
		session.line("start the turn");
		await session.waitForVisible("working...", { timeoutMs: WAIT_MS });

		session.line("use this next");
		await session.waitForVisible("queued for the next available turn", { timeoutMs: WAIT_MS });
		await session.waitForVisible("queued response", { timeoutMs: WAIT_MS });

		const snapshot = session.snapshot();
		assert.match(snapshot.visible, /use this next/);
		assert.doesNotMatch(snapshot.visible, /AgentHarness is busy/);

		await exitFixture(session);
	});

	test("escape interrupts and immediately sends queued input", async (ctx) => {
		const { spawnFixture, exitFixture, waitForFixtureReady, KeyEscape } = await loadPtywrightHelpers();
		const session = spawnFixture("abort.json");
		ctx.onTestFinished(() => session.close());

		await waitForFixtureReady(session);
		session.line("please run forever");
		await session.waitForVisible("working...", { timeoutMs: WAIT_MS });

		session.line("switch to this instead");
		await session.waitForVisible("queued for the next available turn", { timeoutMs: WAIT_MS });
		session.press(KeyEscape);
		await session.waitForVisible("turn interrupted; sending 1 queued message", { timeoutMs: WAIT_MS });
		await session.waitForVisible("fixture response", { timeoutMs: WAIT_MS });

		await exitFixture(session);
	});

	test("ctrl+c cancels an escape-triggered queued replay", async (ctx) => {
		const { spawnFixture, exitFixture, waitForFixtureReady, KeyCtrlC, KeyEscape } = await loadPtywrightHelpers();
		const session = spawnFixture("interrupt-cancel.json");
		ctx.onTestFinished(() => session.close());

		await waitForFixtureReady(session);
		session.line("please run forever");
		await session.waitForVisible("working...", { timeoutMs: WAIT_MS });
		session.line("do not replay this");
		await session.waitForVisible("queued for the next available turn", { timeoutMs: WAIT_MS });

		session.press(KeyEscape);
		await session.waitForVisible("interrupting…", { timeoutMs: WAIT_MS });
		session.press(KeyCtrlC);
		await session.waitForVisible("aborted", { timeoutMs: WAIT_MS });
		session.line("recover after cancelling replay");
		await session.waitForVisible("queued for after abort", { timeoutMs: WAIT_MS });
		await session.waitForVisible("fixture response", { timeoutMs: WAIT_MS });
		assert.doesNotMatch(session.snapshot().visible, /turn interrupted; sending 1 queued message/);

		await exitFixture(session);
	});

	test("refuses slash commands while a turn is running", async (ctx) => {
		const { spawnFixture, exitFixture, waitForFixtureReady, KeyCtrlC, KeyEnter } = await loadPtywrightHelpers();
		const session = spawnFixture("abort.json");
		ctx.onTestFinished(() => session.close());

		await waitForFixtureReady(session);
		session.line("please run forever");
		await session.waitForVisible("working...", { timeoutMs: WAIT_MS });
		session.send("/thinking high");
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
		session.press(KeyEnter);
		session.press(KeyEnter);
		await session.waitForVisible("/thinking is unavailable while a turn is running", { timeoutMs: WAIT_MS });

		session.press(KeyCtrlC);
		await session.waitForVisible("aborted", { timeoutMs: WAIT_MS });
		await exitFixture(session);
	});

	test("aborts a running turn with ctrl+c and recovers on the next prompt", async (ctx) => {
		const { spawnFixture, exitFixture, waitForFixtureReady, KeyCtrlC } = await loadPtywrightHelpers();
		const session = spawnFixture("abort.json");
		ctx.onTestFinished(() => session.close());

		await waitForFixtureReady(session);
		session.line("please run forever");
		await session.waitForVisible("working...", { timeoutMs: WAIT_MS });

		session.press(KeyCtrlC);
		await session.waitForVisible("aborted", { timeoutMs: WAIT_MS });

		session.line("recover after abort");
		await session.waitForVisible("fixture response", { timeoutMs: WAIT_MS });

		await exitFixture(session);
	});

	test("opens a searchable model picker for /model with no argument", async (ctx) => {
		const { spawnFixture, exitFixture, waitForFixtureReady, KeyArrowDown, KeyEscape } = await loadPtywrightHelpers();
		const session = spawnFixture("model-picker.json", { rows: 50 });
		ctx.onTestFinished(() => session.close());

		await waitForFixtureReady(session);
		session.line("/model");
		await session.waitForVisible("Model Name:", { timeoutMs: WAIT_MS });
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });

		// pi's row format: cursor arrow, provider badge, and a check on the current model.
		const opened = session.snapshot();
		assert.match(opened.visible, /gpt-5\.5 \[openai\]/);
		assert.match(opened.visible, /→ /);
		assert.match(opened.visible, /✓/);

		// Typing filters the list; the fuzzy match ranks Gemini models first and
		// drops the previously-listed current model.
		session.send("gemini");
		await session.waitForVisible("[google]", { timeoutMs: WAIT_MS });
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
		const filtered = session.snapshot();
		assert.match(filtered.visible, /→ gemini-/);
		assert.doesNotMatch(filtered.visible, /gpt-5\.5 \[openai\]/);

		session.press(KeyArrowDown);
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
		assert.match(session.snapshot().visible, /\[google\]/);

		// Escape closes without switching, and hands focus back to the editor.
		session.press(KeyEscape);
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
		const closed = session.snapshot();
		assert.doesNotMatch(closed.visible, /Model Name:/);
		assert.doesNotMatch(closed.visible, /model → /);

		session.line("say hi");
		await session.waitForVisible("fixture response", { timeoutMs: WAIT_MS });

		await exitFixture(session);
	});

	test("cancels the model picker with ctrl+c and selects with enter", async (ctx) => {
		const { spawnFixture, exitFixture, waitForFixtureReady, KeyCtrlC, KeyEnter } = await loadPtywrightHelpers();
		const session = spawnFixture("model-picker-cancel.json", { rows: 50 });
		ctx.onTestFinished(() => session.close());

		await waitForFixtureReady(session);
		session.line("/model");
		await session.waitForVisible("Model Name:", { timeoutMs: WAIT_MS });

		// Regression: the global input listener must not treat ctrl+c as "quit"
		// while a picker owns the keyboard.
		session.press(KeyCtrlC);
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
		assert.doesNotMatch(session.snapshot().visible, /Model Name:/);

		// The process is still alive: a prompt still round-trips.
		session.line("say hi");
		await session.waitForVisible("fixture response", { timeoutMs: WAIT_MS });

		session.line("/model");
		await session.waitForVisible("Model Name:", { timeoutMs: WAIT_MS });
		session.send("gpt-5.6-sol");
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
		session.press(KeyEnter);
		await session.waitForVisible("model → openai:gpt-5.6-sol", { timeoutMs: WAIT_MS });
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
		assert.doesNotMatch(session.snapshot().visible, /Model Name:/);

		await exitFixture(session);
	});

	test("keeps /model <ref> non-interactive and prefills the picker for an unknown ref", async (ctx) => {
		const { spawnFixture, exitFixture, waitForFixtureReady, KeyEscape } = await loadPtywrightHelpers();
		const session = spawnFixture("model-arg.json", { rows: 50 });
		ctx.onTestFinished(() => session.close());

		await waitForFixtureReady(session);

		// An explicit ref switches directly; the picker never opens.
		await submitCommand(session, "/model openai:gpt-5.6-sol");
		await session.waitForVisible("model → openai:gpt-5.6-sol", { timeoutMs: WAIT_MS });
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
		assert.doesNotMatch(session.snapshot().visible, /Model Name:/);

		// An unresolvable ref still reports the error, then offers the picker
		// prefilled with what was typed.
		await submitCommand(session, "/model nope-not-a-real-model");
		await session.waitForVisible("No matching models", { timeoutMs: WAIT_MS });
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
		const prefilled = session.snapshot();
		assert.match(prefilled.visible, /unknown model/);
		assert.match(prefilled.visible, /nope-not-a-real-model/);

		session.press(KeyEscape);
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });

		await exitFixture(session);
	});

	test("toggles tools through /tools, discarding staged edits on cancel", async (ctx) => {
		const { spawnFixture, exitFixture, waitForFixtureReady, KeyArrowDown, KeyCtrlA, KeyCtrlR, KeyCtrlS, KeyCtrlX, KeyEscape } =
			await loadPtywrightHelpers();
		const session = spawnFixture("tools-picker.json", { rows: 50 });
		ctx.onTestFinished(() => session.close());

		await waitForFixtureReady(session);
		session.line("/tools");
		await session.waitForVisible("Tool Configuration", { timeoutMs: WAIT_MS });
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });

		const opened = session.snapshot();
		assert.match(opened.visible, /browser_snapshot/);
		assert.match(opened.visible, /✓ enabled/);
		// Keyboard-only controls are advertised, including the cua-specific ones.
		assert.match(opened.visible, /ctrl\+s apply/);
		assert.match(opened.visible, /ctrl\+a all/);
		const baseline = baselineToolCount("openai:gpt-5.5");
		const selectable = selectableToolCount("openai:gpt-5.5");
		assert.ok(selectable > baseline, "the menu offers more than the composed baseline");
		assert.match(opened.visible, new RegExp(`${baseline}/${selectable} enabled`));

		// Stage a toggle, then cancel: live state must be untouched.
		session.send(" ");
		await session.waitForVisible("✗ disabled", { timeoutMs: WAIT_MS });
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
		assert.match(session.snapshot().visible, /unapplied/);
		session.press(KeyEscape);
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
		const cancelled = session.snapshot();
		assert.doesNotMatch(cancelled.visible, /Tool Configuration/);
		assert.doesNotMatch(cancelled.visible, /tools → /);

		// Reopening shows the discarded edit is gone.
		session.line("/tools");
		await session.waitForVisible("Tool Configuration", { timeoutMs: WAIT_MS });
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
		assert.doesNotMatch(session.snapshot().visible, /✗ disabled/);

		// Now toggle and apply for real.
		session.press(KeyArrowDown);
		session.send(" ");
		await session.waitForVisible("✗ disabled", { timeoutMs: WAIT_MS });
		session.press(KeyCtrlS);
		await session.waitForVisible(`tools → ${baseline - 1} enabled`, { timeoutMs: WAIT_MS });
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
		assert.doesNotMatch(session.snapshot().visible, /Tool Configuration/);

		// The applied selection persists: reopening shows the disabled row and the
		// reduced count, and the picker's baseline is still the full default list.
		session.line("/tools");
		await session.waitForVisible("Tool Configuration", { timeoutMs: WAIT_MS });
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
		const reopened = session.snapshot();
		assert.match(reopened.visible, /✗ disabled/);
		assert.match(reopened.visible, new RegExp(`${baseline - 1}/${selectable} enabled`));

		// ctrl+a enables every selectable row — including tools the application
		// never composed — and ctrl+x clears it; both are staged.
		session.press(KeyCtrlA);
		// No `waitForVisible` here: the footer already reads `…/${selectable}
		// enabled`, so a substring wait would resolve on the pre-keypress screen.
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
		const enabledAll = /(\d+)\/\d+ enabled/.exec(session.snapshot().visible);
		assert.ok(enabledAll && Number(enabledAll[1]) > baseline, "ctrl+a grows the selection past the baseline");
		session.press(KeyCtrlX);
		await session.waitForVisible("text-only agent", { timeoutMs: WAIT_MS });
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
		assert.match(session.snapshot().visible, new RegExp(`0/${selectable} enabled`));

		// ctrl+r restores the model defaults, and escape discards all of it.
		session.press(KeyCtrlR);
		await session.waitForVisible(`${baseline}/${selectable} enabled`, { timeoutMs: WAIT_MS });
		session.press(KeyEscape);
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
		assert.doesNotMatch(session.snapshot().visible, /Tool Configuration/);

		await exitFixture(session);
	});

	test("resets a customized tool selection when the model changes", async (ctx) => {
		const { spawnFixture, exitFixture, waitForFixtureReady, KeyCtrlS } = await loadPtywrightHelpers();
		const session = spawnFixture("tools-reset-on-model.json", { rows: 50 });
		ctx.onTestFinished(() => session.close());

		await waitForFixtureReady(session);
		session.line("/tools");
		await session.waitForVisible("Tool Configuration", { timeoutMs: WAIT_MS });
		session.send(" ");
		await session.waitForVisible("✗ disabled", { timeoutMs: WAIT_MS });
		session.press(KeyCtrlS);
		await session.waitForVisible("tools → ", { timeoutMs: WAIT_MS });

		await submitCommand(session, "/model openai:gpt-5.6-sol");
		await session.waitForVisible("tool selection reset", { timeoutMs: WAIT_MS });

		// The new model's full default catalog is live again.
		session.line("/tools");
		await session.waitForVisible("Tool Configuration", { timeoutMs: WAIT_MS });
		await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
		assert.doesNotMatch(session.snapshot().visible, /✗ disabled/);

		await exitFixture(session);
	});

	test("renders assistant errors as error notices", async (ctx) => {
		const { spawnFixture, exitFixture, waitForFixtureReady } = await loadPtywrightHelpers();
		const session = spawnFixture("error.json");
		ctx.onTestFinished(() => session.close());

		await waitForFixtureReady(session);
		session.line("please fail");
		await session.waitForVisible("fixture provider failed", { timeoutMs: WAIT_MS });

		const snapshot = session.snapshot();
		assert.match(snapshot.visible, /error fixture provider failed/);

		await exitFixture(session);
	});
});

/**
 * Submit a slash command whose argument triggers editor autocomplete. The
 * dropdown swallows the first Enter (it accepts the completion), so dismiss it
 * with Escape before submitting.
 */
async function submitCommand(
	session: { send: (text: string) => void; press: (key: string) => void; waitForStable: (ms: number, o: { timeoutMs: number }) => Promise<unknown> },
	text: string,
): Promise<void> {
	session.send(text);
	await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
	session.press("\x1b");
	await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
	session.press("\r");
	await session.waitForStable(STABLE_MS, { timeoutMs: WAIT_MS });
}

/**
 * Lazy-load ptywright so missing native bindings only fail this suite. The
 * suite is gated behind `describe.skip` when the binding is missing, but the
 * dynamic import also keeps the import graph clean for the rest of vitest.
 */
async function loadPtywrightHelpers() {
	const ptywright = await import("@onkernel/ptywright");
	const { KeyArrowDown, KeyCtrlC, KeyEnter, KeyEscape, spawnSession } = ptywright;
	// ptywright has no constants for the picker's bulk-action bindings; send the
	// raw control bytes (ctrl+<letter> is 0x01 + letter offset).
	const KeyCtrlA = "\x01";
	const KeyCtrlR = "\x12";
	const KeyCtrlS = "\x13";
	const KeyCtrlX = "\x18";

	// Picker scenarios need more rows than the base 40 so the whole selector
	// frame stays inside the viewport alongside the header and message list.
	const spawnFixture = (fixtureFile: string, options: { rows?: number } = {}) =>
		spawnSession({
			command: process.execPath,
			args: [tsxCliPath, tuiRunnerPath, resolve(fixtureDir, fixtureFile)],
			cwd,
			cols: 160,
			rows: options.rows ?? 40,
			env: {
				...process.env,
				KERNEL_API_KEY: "fixture-key",
				OPENAI_API_KEY: "fixture-key",
			},
		});

	type FixtureSession = ReturnType<typeof spawnFixture>;

	async function waitForFixtureReady(session: FixtureSession): Promise<void> {
		await session.waitForVisible("openai/gpt-5.5", { timeoutMs: WAIT_MS });
	}

	async function exitFixture(session: FixtureSession): Promise<void> {
		try {
			await session.waitForStable(100, { timeoutMs: 2_000 });
		} catch {
			// fall through to abort-then-exit path
		}

		session.press(KeyCtrlC);
		try {
			await session.waitForExit({ timeoutMs: 1_500 });
			return;
		} catch {
			// continue to the second-ctrl-c path
		}
		try {
			await session.waitForVisible("aborted", { timeoutMs: 2_000 });
		} catch {
			// first ctrl+c may have landed during final run settlement
		}
		await session.waitForStable(100, { timeoutMs: 5_000 });
		session.press(KeyCtrlC);
		await session.waitForExit({ timeoutMs: 5_000 });
	}

	return {
		spawnFixture,
		exitFixture,
		waitForFixtureReady,
		KeyArrowDown,
		KeyCtrlA,
		KeyCtrlC,
		KeyCtrlR,
		KeyCtrlS,
		KeyCtrlX,
		KeyEnter,
		KeyEscape,
	};
}
