import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessExtensionHost } from "../src/extensions/host";
import { buildTestHarness, type TestHarnessFixture } from "./fixtures/harness";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_EXTENSION = join(here, "fixtures", "extensions", "click-visual.ts");

let fx: TestHarnessFixture | undefined;
let host: HarnessExtensionHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	await fx?.dispose();
	fx = undefined;
});

/** Copy the committed example extension into an isolated discovery directory. */
function makeExtensionDir(): string {
	const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
	cpSync(EXAMPLE_EXTENSION, join(extDir, "click-visual.ts"));
	return extDir;
}

async function loadHost(): Promise<HarnessExtensionHost> {
	fx = await buildTestHarness({
		turns: [
			{ steps: [{ type: "tool_call", toolName: "click_visual", args: { description: "the button" } }] },
			{ steps: [{ type: "text", text: "done" }] },
		],
	});
	const created = new HarnessExtensionHost({
		harness: fx.harness,
		session: fx.session,
		cwd: fx.cwd,
		configuredPaths: [makeExtensionDir()],
		agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
	});
	await created.load();
	host = created;
	return created;
}

describe("HarnessExtensionHost", () => {
	it("registers an extension tool on the harness", async () => {
		await loadHost();
		const toolNames = fx!.harness.getTools().map((tool) => tool.name);
		expect(toolNames).toContain("click_visual");
	});

	it("bridges harness events into extension handlers", async () => {
		await loadHost();

		let sawAgentStart = false;
		let toolResultText = "";
		fx!.harness.subscribe((event) => {
			if (event.type === "agent_start") sawAgentStart = true;
			if (event.type === "tool_execution_end" && event.toolName === "click_visual") {
				const content = (event.result as { content: Array<{ type: string; text?: string }> }).content;
				toolResultText = content.map((part) => part.text ?? "").join("");
			}
		});

		await fx!.harness.prompt("hi");

		// agent_start reached the harness subscriber (loop-event forwarding path)…
		expect(sawAgentStart).toBe(true);
		// …and the extension's own agent_start handler ran: the tool, executed via
		// the runner's wrapper, reports the count the extension incremented.
		expect(toolResultText).toContain("would click: the button");
		expect(toolResultText).toContain("runs=1");
	});

	it("keeps the extension tool after a model switch", async () => {
		await loadHost();
		expect(fx!.harness.getTools().map((tool) => tool.name)).toContain("click_visual");

		await fx!.harness.setModel("anthropic:claude-opus-4-7");

		expect(fx!.harness.getTools().map((tool) => tool.name)).toContain("click_visual");
	});

	it("keeps the extension tool active across a model switch", async () => {
		await loadHost();
		expect(fx!.harness.getActiveTools().map((tool) => tool.name)).toContain("click_visual");

		// setModel rebuilds the harness tool list from construction-time tools and
		// resets active state; the host must re-activate extension tools, not just
		// re-register them.
		await fx!.harness.setModel("anthropic:claude-opus-4-7");

		expect(fx!.harness.getActiveTools().map((tool) => tool.name)).toContain("click_visual");
	});

	it("re-registers extension tools after reload", async () => {
		const created = await loadHost();
		expect(fx!.harness.getTools().map((tool) => tool.name)).toContain("click_visual");

		await created.reload();

		expect(fx!.harness.getTools().map((tool) => tool.name)).toContain("click_visual");
	});

	it("drops a renamed extension's old tool on reload", async () => {
		// Model a meta-agent revising a learned tool: the extension file is rewritten
		// to register a differently-named tool, and reload must reflect the on-disk
		// state — the previous tool should not linger on the harness.
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		const extFile = join(extDir, "learned.ts");
		writeFileSync(extFile, makeToolExtension("alpha_tool"));

		fx = await buildTestHarness({ turns: [{ steps: [{ type: "text", text: "ok" }] }] });
		const created = new HarnessExtensionHost({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			configuredPaths: [extDir],
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
		});
		host = created;
		await created.load();
		expect(fx.harness.getTools().map((tool) => tool.name)).toContain("alpha_tool");

		writeFileSync(extFile, makeToolExtension("beta_tool"));
		await created.reload();

		const toolNames = fx.harness.getTools().map((tool) => tool.name);
		expect(toolNames).toContain("beta_tool");
		expect(toolNames).not.toContain("alpha_tool");
	});

	it("throws when load() is called after dispose", async () => {
		const created = await loadHost();
		await created.dispose();
		await expect(created.load()).rejects.toThrow(/disposed/);
	});

	it("ignores a second load() rather than stacking a duplicate registration", async () => {
		const created = await loadHost();
		const count = () =>
			fx!.harness.getTools().map((tool) => tool.name).filter((name) => name === "click_visual").length;
		expect(count()).toBe(1);
		await created.load();
		expect(count()).toBe(1);
	});

	it("removes its tools from the harness on dispose", async () => {
		const created = await loadHost();
		expect(fx!.harness.getTools().map((tool) => tool.name)).toContain("click_visual");
		// dispose (e.g. via an extension's ctx.shutdown) must not leave the tool
		// registered+active once its runner binding is gone.
		await created.dispose();
		const names = fx!.harness.getTools().map((tool) => tool.name);
		expect(names).not.toContain("click_visual");
	});

	it("coalesces a reload requested while another is in flight", async () => {
		const created = await loadHost();
		// reload() sets `reloading` synchronously before its first await, so a second
		// call made before the first settles must report `coalesced`, not a completed
		// reload — this is what keeps /reload from claiming false success.
		const first = created.reload();
		const second = await created.reload();
		expect(second).toBe("coalesced");
		expect(await first).toBe("reloaded");
	});

	it("waits for an in-flight queued reload before disposing", async () => {
		const created = await loadHost();
		// Put a reload in flight via a drain, then dispose concurrently: dispose must
		// await the in-flight reload rather than tear down the bridge/runner under it.
		const inFlight = created.reload();
		expect(await created.reload()).toBe("coalesced");
		await inFlight;
		const drain = created.drainPendingReload();
		const disposed = created.dispose();
		await Promise.all([drain, disposed]);
		expect(created.isDisposed()).toBe(true);
		// The tool list is coherent — not left half-applied by a reload racing teardown.
		const names = fx!.harness.getTools().map((tool) => tool.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("does not let a startup extension message consume the first-turn screenshot", async () => {
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		writeFileSync(join(extDir, "startup-msg.ts"), SEND_ON_STARTUP_EXTENSION);
		fx = await buildTestHarness({ turns: [{ steps: [{ type: "text", text: "ok" }] }] });
		let screenshotCalls = 0;
		const created = new HarnessExtensionHost({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			configuredPaths: [extDir],
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
			initialScreenshot: async () => {
				screenshotCalls += 1;
				return [{ type: "image", data: "x", mimeType: "image/png" }];
			},
		});
		host = created;
		await created.load();
		// Let the fire-and-forget startup prompt settle so an unguarded capture would
		// have happened by now.
		await new Promise((resolve) => setTimeout(resolve, 20));
		// The extension's startup sendUserMessage must not have captured the
		// first-turn screenshot — that belongs to the user's real first prompt.
		expect(screenshotCalls).toBe(0);
	});

	it("captures a failing extension sendUserMessage instead of an unhandled rejection", async () => {
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		writeFileSync(join(extDir, "startup-msg.ts"), SEND_ON_STARTUP_EXTENSION);
		fx = await buildTestHarness({ turns: [{ steps: [{ type: "text", text: "ok" }] }] });
		// Force the extension-initiated prompt to reject (models a busy/concurrent
		// harness); without a catch this would surface as an unhandled rejection.
		const realPrompt = fx.harness.prompt.bind(fx.harness);
		fx.harness.prompt = ((text: string, options?: unknown) =>
			typeof text === "string" && text.includes("ext-startup-msg")
				? Promise.reject(new Error("harness busy"))
				: realPrompt(text, options as never)) as typeof fx.harness.prompt;
		const created = new HarnessExtensionHost({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			configuredPaths: [extDir],
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
		});
		host = created;
		await created.load();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(created.loadErrors.some((e) => e.path === "<sendUserMessage>")).toBe(true);
	});

	it("drops an extension tool that shadows a built-in and keeps the built-in", async () => {
		fx = await buildTestHarness({ turns: [{ steps: [{ type: "text", text: "ok" }] }] });
		const builtin = fx.harness.getTools()[0].name;
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		writeFileSync(join(extDir, "shadow.ts"), makeToolExtension(builtin));
		const created = new HarnessExtensionHost({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			configuredPaths: [extDir],
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
		});
		host = created;
		// An extension may not shadow a built-in: the shadow would vanish the
		// built-in when the extension is later removed on reload.
		await created.load();
		const names = fx.harness.getTools().map((tool) => tool.name);
		expect(names.filter((name) => name === builtin)).toHaveLength(1);
		expect(created.loadErrors.some((e) => e.path === builtin && /built-in/.test(e.error))).toBe(true);
	});

	it("does not deadlock when an extension shuts down during a queued reload", async () => {
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		writeFileSync(join(extDir, "shutdowner.ts"), SHUTDOWN_ON_RELOAD_EXTENSION);
		fx = await buildTestHarness({
			turns: [
				{
					steps: [
						{
							type: "tool_call",
							toolName: "write_extension",
							args: { filename: "authored.ts", code: makeToolExtension("authored_tool") },
						},
					],
				},
				{ steps: [{ type: "text", text: "done" }] },
			],
		});
		const created = new HarnessExtensionHost({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			configuredPaths: [extDir],
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
			selfExtend: true,
		});
		host = created;
		await created.load();
		await fx.harness.prompt("author it");
		// The queued reload emits session_shutdown(reload); the extension calls
		// ctx.shutdown() during it, tearing the host down from inside reload(). This
		// must not deadlock — disposeNow avoids awaiting the in-flight reload from
		// within its own call stack. A hang here trips the test timeout.
		await created.drainPendingReload();
		expect(created.isDisposed()).toBe(true);
	}, 5000);
});

/** An extension that asks the host to shut down when a reload tears it down. */
const SHUTDOWN_ON_RELOAD_EXTENSION = [
	"export default function (pi) {",
	'  pi.on("session_shutdown", (event, ctx) => {',
	'    if (event.reason === "reload") ctx.shutdown();',
	"  });",
	"  pi.registerTool({",
	'    name: "shutdown_probe",',
	'    label: "shutdown probe",',
	'    description: "noop",',
	'    parameters: { type: "object", properties: {}, additionalProperties: false },',
	'    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },',
	"  });",
	"}",
	"",
].join("\n");

/** An extension that sends a user message during the startup session_start. */
const SEND_ON_STARTUP_EXTENSION = [
	"export default function (pi) {",
	'  pi.on("session_start", (event) => {',
	'    if (event.reason === "startup") pi.sendUserMessage("ext-startup-msg");',
	"  });",
	"  pi.registerTool({",
	'    name: "startup_probe",',
	'    label: "startup probe",',
	'    description: "noop",',
	'    parameters: { type: "object", properties: {}, additionalProperties: false },',
	'    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },',
	"  });",
	"}",
	"",
].join("\n");

/** A minimal, import-free extension that registers a single named tool. */
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
