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
});

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
