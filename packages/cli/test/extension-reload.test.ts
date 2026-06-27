import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHarnessExtensions } from "../src/extensions/setup";
import { buildTestHarness, type TestHarnessFixture } from "./fixtures/harness";
import type { HarnessExtensionHost } from "../src/extensions/host";

let fx: TestHarnessFixture | undefined;
let host: HarnessExtensionHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	await fx?.dispose();
	fx = undefined;
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

describe("/reload path via the real host", () => {
	it("hot-swaps an edited extension and reports a clean reload", async () => {
		fx = await buildTestHarness({ turns: [{ steps: [{ type: "text", text: "ok" }] }] });
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		const extFile = join(extDir, "learned.ts");
		writeFileSync(extFile, makeToolExtension("alpha_tool"));

		host = await loadHarnessExtensions({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			noExtensions: false,
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
			configuredPaths: [extDir],
		});
		expect(host).toBeDefined();
		expect(fx.harness.getTools().map((t) => t.name)).toContain("alpha_tool");

		writeFileSync(extFile, makeToolExtension("beta_tool"));
		await host!.reload();

		const toolNames = fx.harness.getTools().map((t) => t.name);
		expect(toolNames).toContain("beta_tool");
		expect(toolNames).not.toContain("alpha_tool");
		expect(host!.loadErrors).toHaveLength(0);
	});

	it("surfaces loadErrors when an edited extension is broken", async () => {
		fx = await buildTestHarness({ turns: [{ steps: [{ type: "text", text: "ok" }] }] });
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		const extFile = join(extDir, "learned.ts");
		writeFileSync(extFile, makeToolExtension("alpha_tool"));

		host = await loadHarnessExtensions({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			noExtensions: false,
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
			configuredPaths: [extDir],
		});
		expect(host).toBeDefined();

		writeFileSync(extFile, "export default function ( {  // syntactically broken\n");
		await host!.reload();

		expect(host!.loadErrors.length).toBeGreaterThan(0);
	});
});
