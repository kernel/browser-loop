import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessExtensionHost } from "../src/extensions/host";
import { loadHarnessExtensions } from "../src/extensions/setup";
import { buildTestHarness, type TestHarnessFixture } from "./fixtures/harness";

/**
 * Runtime tool authoring: with `--self-extend` on, the agent calls
 * `write_extension` to write a pi extension into the project extension dir. The
 * file is trial-loaded in isolation for immediate validation feedback, and a
 * reload is queued for the next idle boundary so the authored tool joins the
 * toolset for subsequent prompts — never a mid-turn runner swap.
 *
 * Fully scripted, no model calls: a scripted provider replays one turn per
 * provider call, so a `tool_call` step makes the harness execute the registered
 * tool exactly as a model would. Every extension file written here obeys the
 * loader contract
 * (type-only imports, inline JSON Schema, result includes `details`) so the jiti
 * loader never hangs.
 */

/** A loadable extension module that registers one tool. */
function makeToolExtension(toolName: string): string {
	return [
		"export default function (pi) {",
		"  pi.registerTool({",
		`    name: ${JSON.stringify(toolName)},`,
		`    label: ${JSON.stringify(toolName)},`,
		`    description: ${JSON.stringify(toolName)},`,
		'    parameters: { type: "object", properties: {}, additionalProperties: false },',
		'    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },',
		"  });",
		"}",
		"",
	].join("\n");
}

/** A module that fails to parse — stands in for a broken authoring attempt. */
const BROKEN_EXTENSION = "export default function ( {  // syntactically broken\n";

interface WriteExtensionResult {
	content: Array<{ type: string; text?: string }>;
	details: {
		written: string;
		valid: boolean;
		registeredTools: string[];
		loadErrors: Array<{ path: string; error: string }>;
		hostLoadErrors: Array<{ path: string; error: string }>;
	};
}

let fx: TestHarnessFixture | undefined;
let host: HarnessExtensionHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	await fx?.dispose();
	fx = undefined;
});

function toolNames(harness: TestHarnessFixture["harness"]): string[] {
	return harness.getTools().map((tool) => tool.name);
}

function activeToolNames(harness: TestHarnessFixture["harness"]): string[] {
	return harness.getActiveTools().map((tool) => tool.name);
}

function captureWriteResult(harness: TestHarnessFixture["harness"]): () => WriteExtensionResult | undefined {
	let result: WriteExtensionResult | undefined;
	harness.subscribe((event) => {
		if (event.type === "tool_execution_end" && event.toolName === "write_extension") {
			result = event.result as WriteExtensionResult;
		}
	});
	return () => result;
}

/**
 * Yield macrotasks until `predicate` holds or the deadline passes. The bridge
 * schedules the queued reload off-stack and `reload()` then awaits async I/O, so
 * the authored tool only becomes live a few macrotasks after `prompt()` resolves;
 * this waits for that without reaching into the host's drain.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return true;
}

describe("self-extend: runtime tool authoring", () => {
	it("registers write_extension only when the flag is on", async () => {
		fx = await buildTestHarness({ turns: [{ steps: [{ type: "text", text: "ok" }] }] });
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));

		host = new HarnessExtensionHost({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			configuredPaths: [extDir],
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
			selfExtend: true,
		});
		await host.load();
		expect(toolNames(fx.harness)).toContain("write_extension");
		expect(activeToolNames(fx.harness)).toContain("write_extension");
	});

	it("omits write_extension when the flag is off", async () => {
		fx = await buildTestHarness({ turns: [{ steps: [{ type: "text", text: "ok" }] }] });
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));

		// Routed through loadHarnessExtensions to also cover the setup.ts hop.
		host = await loadHarnessExtensions({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			noExtensions: false,
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
			configuredPaths: [extDir],
		});
		expect(host).toBeDefined();
		expect(toolNames(fx.harness)).not.toContain("write_extension");
	});

	it("writes the file and reports a valid trial load without a mid-turn swap", async () => {
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		fx = await buildTestHarness({
			turns: [
				{
					steps: [
						{
							type: "tool_call",
							toolName: "write_extension",
							args: { filename: "authored_tool.ts", code: makeToolExtension("authored_tool") },
						},
					],
				},
				{ steps: [{ type: "text", text: "done" }] },
			],
		});

		host = new HarnessExtensionHost({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			configuredPaths: [extDir],
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
			selfExtend: true,
		});
		await host.load();

		const getResult = captureWriteResult(fx.harness);
		await fx.harness.prompt("author it");

		const result = getResult();
		expect(result).toBeDefined();
		const target = join(extDir, "authored_tool.ts");
		expect(existsSync(target)).toBe(true);
		expect(readFileSync(target, "utf8")).toBe(makeToolExtension("authored_tool"));
		expect(result!.details.written).toBe(target);
		expect(result!.details.valid).toBe(true);
		expect(result!.details.registeredTools).toContain("authored_tool");
		expect(result!.details.loadErrors).toHaveLength(0);
		// The trial load used a throwaway runner: the live toolset must not have
		// swapped in the authored tool mid-turn.
		expect(toolNames(fx.harness)).not.toContain("authored_tool");
	});

	it("surfaces load errors for a broken authored extension without swapping the runner", async () => {
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		fx = await buildTestHarness({
			turns: [
				{
					steps: [
						{
							type: "tool_call",
							toolName: "write_extension",
							args: { filename: "broken_tool.ts", code: BROKEN_EXTENSION },
						},
					],
				},
				{ steps: [{ type: "text", text: "done" }] },
			],
		});

		host = new HarnessExtensionHost({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			configuredPaths: [extDir],
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
			selfExtend: true,
		});
		await host.load();

		const getResult = captureWriteResult(fx.harness);
		const before = toolNames(fx.harness);
		await fx.harness.prompt("author a broken one");

		const result = getResult();
		expect(result).toBeDefined();
		expect(result!.details.valid).toBe(false);
		expect(result!.details.loadErrors.length).toBeGreaterThan(0);
		// A status line, not just structured details, conveys the failure.
		const text = result!.content.map((part) => part.text ?? "").join("");
		expect(text).toContain("did not load");
		// The live toolset is unchanged.
		expect(toolNames(fx.harness)).toEqual(before);
	});

	it("makes the authored tool callable after the queued reload drains at idle", async () => {
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		fx = await buildTestHarness({
			turns: [
				// Turn 1: author the tool, then end the run.
				{
					steps: [
						{
							type: "tool_call",
							toolName: "write_extension",
							args: { filename: "authored_tool.ts", code: makeToolExtension("authored_tool") },
						},
					],
				},
				{ steps: [{ type: "text", text: "authored" }] },
				// Turn 2: call the now-live authored tool, then end the run.
				{ steps: [{ type: "tool_call", toolName: "authored_tool", args: {} }] },
				{ steps: [{ type: "text", text: "used it" }] },
			],
		});

		host = new HarnessExtensionHost({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			configuredPaths: [extDir],
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
			selfExtend: true,
		});
		await host.load();

		expect(toolNames(fx.harness)).not.toContain("authored_tool");
		await fx.harness.prompt("author it");

		// The reload is queued at the idle boundary, not run synchronously inside
		// the tool. Draining it here mirrors what the bridge schedules off-stack at
		// agent_end; afterwards the authored tool is both registered and active.
		await host.drainPendingReload();
		expect(toolNames(fx.harness)).toContain("authored_tool");
		expect(activeToolNames(fx.harness)).toContain("authored_tool");

		// And it is actually callable on the next prompt.
		let sawAuthoredCall = false;
		fx.harness.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolName === "authored_tool") {
				sawAuthoredCall = true;
			}
		});
		await fx.harness.prompt("use it");
		expect(sawAuthoredCall).toBe(true);
	});

	it("auto-reloads at the idle boundary so the authored tool goes live without a manual drain", async () => {
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		fx = await buildTestHarness({
			turns: [
				// Turn 1: author the tool, then end the run so agent_end fires.
				{
					steps: [
						{
							type: "tool_call",
							toolName: "write_extension",
							args: { filename: "authored_tool.ts", code: makeToolExtension("authored_tool") },
						},
					],
				},
				{ steps: [{ type: "text", text: "authored" }] },
				// Turn 2: call the now-live authored tool, then end the run.
				{ steps: [{ type: "tool_call", toolName: "authored_tool", args: {} }] },
				{ steps: [{ type: "text", text: "used it" }] },
			],
		});

		host = new HarnessExtensionHost({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			configuredPaths: [extDir],
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
			selfExtend: true,
		});
		await host.load();

		expect(toolNames(fx.harness)).not.toContain("authored_tool");
		await fx.harness.prompt("author it");

		// The crux: do NOT call host.drainPendingReload(). The bridge schedules the
		// reload off-stack at agent_end; just letting macrotasks run must bring the
		// authored tool live. (Without the bridge's scheduling this never happens.)
		const wentLive = await waitFor(() => toolNames(fx!.harness).includes("authored_tool"));
		expect(wentLive).toBe(true);
		expect(activeToolNames(fx.harness)).toContain("authored_tool");

		// And it is callable on the next prompt, still without any manual drain.
		let sawAuthoredCall = false;
		fx.harness.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolName === "authored_tool") {
				sawAuthoredCall = true;
			}
		});
		await fx.harness.prompt("use it");
		expect(sawAuthoredCall).toBe(true);
	});

	it("drains a reload latched while another reload is in flight", async () => {
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		const extFile = join(extDir, "learned.ts");
		writeFileSync(extFile, makeToolExtension("alpha_tool"));
		fx = await buildTestHarness({ turns: [{ steps: [{ type: "text", text: "ok" }] }] });
		host = new HarnessExtensionHost({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			configuredPaths: [extDir],
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
		});
		await host.load();
		expect(toolNames(fx.harness)).toContain("alpha_tool");

		// Start a reload, then latch a second one via the reentrancy guard while it
		// runs, having rewritten the extension. The drain loop must process the
		// latched reload here (not defer it to the next agent_end), so the rewritten
		// tool is live and the old one is gone once the drain settles.
		const inFlight = host.reload();
		expect(await host.reload()).toBe("coalesced");
		writeFileSync(extFile, makeToolExtension("beta_tool"));
		await inFlight;
		await host.drainPendingReload();

		const names = toolNames(fx.harness);
		expect(names).toContain("beta_tool");
		expect(names).not.toContain("alpha_tool");
		// The drain ran to completion: a follow-up drain has nothing left to do.
		await host.drainPendingReload();
		expect(toolNames(fx.harness)).toContain("beta_tool");
	});

	it("keeps write_extension and the authored tool across a model switch", async () => {
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		fx = await buildTestHarness({
			turns: [
				{
					steps: [
						{
							type: "tool_call",
							toolName: "write_extension",
							args: { filename: "authored_tool.ts", code: makeToolExtension("authored_tool") },
						},
					],
				},
				{ steps: [{ type: "text", text: "authored" }] },
			],
		});

		host = new HarnessExtensionHost({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			configuredPaths: [extDir],
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
			selfExtend: true,
		});
		await host.load();

		await fx.harness.prompt("author it");
		await host.drainPendingReload();
		expect(toolNames(fx.harness)).toEqual(expect.arrayContaining(["write_extension", "authored_tool"]));

		// setModel rebuilds the harness tool list from construction-time tools,
		// dropping runtime-added tools; the host folds both the host tool and the
		// authored extension tool back in on the model_update reapply.
		await fx.harness.setModel("anthropic:claude-opus-4-7");
		expect(toolNames(fx.harness)).toEqual(expect.arrayContaining(["write_extension", "authored_tool"]));
		expect(activeToolNames(fx.harness)).toEqual(
			expect.arrayContaining(["write_extension", "authored_tool"]),
		);
	});

	it("trial-load reports only the authored file's tools, not others in the dir", async () => {
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		// A pre-existing extension already living in the discovery dir.
		writeFileSync(join(extDir, "preexisting.ts"), makeToolExtension("preexisting_tool"));
		fx = await buildTestHarness({
			turns: [
				{
					steps: [
						{
							type: "tool_call",
							toolName: "write_extension",
							args: { filename: "authored_tool.ts", code: makeToolExtension("authored_tool") },
						},
					],
				},
				{ steps: [{ type: "text", text: "done" }] },
			],
		});

		host = new HarnessExtensionHost({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			configuredPaths: [extDir],
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
			selfExtend: true,
		});
		await host.load();

		const getResult = captureWriteResult(fx.harness);
		await fx.harness.prompt("author it");

		const result = getResult();
		expect(result).toBeDefined();
		// The trial load is isolated to the authored file: the sibling extension's
		// tool must not appear in the reported registration.
		expect(result!.details.registeredTools).toEqual(["authored_tool"]);
	});

	it("drops an extension tool that collides with write_extension instead of crashing", async () => {
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		// An extension that tries to claim the host tool's name.
		writeFileSync(join(extDir, "collide.ts"), makeToolExtension("write_extension"));
		fx = await buildTestHarness({ turns: [{ steps: [{ type: "text", text: "ok" }] }] });

		host = new HarnessExtensionHost({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			configuredPaths: [extDir],
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
			selfExtend: true,
		});
		// The colliding name must not crash setTools (which throws on duplicates).
		await host.load();

		const names = toolNames(fx.harness);
		expect(names.filter((name) => name === "write_extension")).toHaveLength(1);
		expect(host.loadErrors.some((e) => e.path === "write_extension")).toBe(true);
	});

	it("rejects a filename with path separators", async () => {
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		fx = await buildTestHarness({
			turns: [
				{
					steps: [
						{
							type: "tool_call",
							toolName: "write_extension",
							args: { filename: "../escape.ts", code: makeToolExtension("escape_tool") },
						},
					],
				},
				{ steps: [{ type: "text", text: "done" }] },
			],
		});

		host = new HarnessExtensionHost({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			configuredPaths: [extDir],
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
			selfExtend: true,
		});
		await host.load();

		let toolError: string | undefined;
		fx.harness.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolName === "write_extension" && event.isError) {
				const content = (event.result as { content: Array<{ type: string; text?: string }> }).content;
				toolError = content.map((part) => part.text ?? "").join("");
			}
		});
		await fx.harness.prompt("try to escape");
		expect(toolError).toBeDefined();
		expect(existsSync(join(extDir, "escape.ts"))).toBe(false);
	});
});
