import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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

function tempAgentDir(): string {
	return mkdtempSync(join(tmpdir(), "cua-agentdir-"));
}

describe("loadHarnessExtensions", () => {
	it("loads a configured extension onto the harness", async () => {
		fx = await buildTestHarness({ turns: [{ steps: [{ type: "text", text: "ok" }] }] });
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		writeFileSync(join(extDir, "probe.ts"), makeToolExtension("loader_probe"));

		host = await loadHarnessExtensions({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			noExtensions: false,
			agentDir: tempAgentDir(),
			configuredPaths: [extDir],
		});

		expect(host).toBeDefined();
		expect(fx.harness.getTools().map((t) => t.name)).toContain("loader_probe");
	});

	it("returns undefined when extensions are disabled", async () => {
		fx = await buildTestHarness({ turns: [{ steps: [{ type: "text", text: "ok" }] }] });
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		writeFileSync(join(extDir, "probe.ts"), makeToolExtension("loader_probe"));

		host = await loadHarnessExtensions({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			noExtensions: true,
			agentDir: tempAgentDir(),
			configuredPaths: [extDir],
		});

		expect(host).toBeUndefined();
		expect(fx.harness.getTools().map((t) => t.name)).not.toContain("loader_probe");
	});

	it("does not load project-local <cwd>/.pi/extensions when untrusted", async () => {
		fx = await buildTestHarness({ turns: [{ steps: [{ type: "text", text: "ok" }] }] });
		// Unique per run so the whole-harness "tool absent" assertion can never be
		// confused by another worker registering the same name — the security
		// guarantee must hold regardless of test order or pool concurrency.
		const probe = `untrusted_probe_${randomUUID().replace(/-/g, "")}`;
		const projectExtDir = join(fx.cwd, ".pi", "extensions");
		mkdirSync(projectExtDir, { recursive: true });
		writeFileSync(join(projectExtDir, "probe.ts"), makeToolExtension(probe));

		host = await loadHarnessExtensions({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			noExtensions: false,
			agentDir: tempAgentDir(),
		});

		expect(host).toBeDefined();
		expect(fx.harness.getTools().map((t) => t.name)).not.toContain(probe);
	});

	it("loads project-local <cwd>/.pi/extensions when trustProject is true", async () => {
		fx = await buildTestHarness({ turns: [{ steps: [{ type: "text", text: "ok" }] }] });
		const probe = `trusted_probe_${randomUUID().replace(/-/g, "")}`;
		const projectExtDir = join(fx.cwd, ".pi", "extensions");
		mkdirSync(projectExtDir, { recursive: true });
		writeFileSync(join(projectExtDir, "probe.ts"), makeToolExtension(probe));

		host = await loadHarnessExtensions({
			harness: fx.harness,
			session: fx.session,
			cwd: fx.cwd,
			noExtensions: false,
			trustProject: true,
			agentDir: tempAgentDir(),
		});

		expect(host).toBeDefined();
		expect(fx.harness.getTools().map((t) => t.name)).toContain(probe);
	});
});
