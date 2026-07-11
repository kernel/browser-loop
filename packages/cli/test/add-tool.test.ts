import { afterEach, describe, expect, it } from "vitest";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
	HarnessExtensionHost,
	renderToolExtension,
	type AddToolInput,
} from "../src/extensions/host";
import { loadHarnessExtensions } from "../src/extensions/setup";
import { buildTestHarness, type TestHarnessFixture } from "./fixtures/harness";

const parameters = {
	type: "object",
	properties: {},
	additionalProperties: false,
};

function definition(name: string, text = "authored ok"): AddToolInput {
	return {
		name,
		description: `${name} description`,
		parameters,
		execute: `async (_toolCallId, _params, _signal, _onUpdate) => ({ content: [{ type: "text", text: ${JSON.stringify(text)} }], details: {} })`,
	};
}

let fx: TestHarnessFixture | undefined;
let host: HarnessExtensionHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	fx = undefined;
});

async function setup(
	options: {
		selfExtend?: boolean;
		extDir?: string;
		turns?: Parameters<typeof buildTestHarness>[0]["turns"];
	} = {},
) {
	fx = await buildTestHarness({
		turns: options.turns ?? [{ steps: [{ type: "text", text: "ok" }] }],
	});
	const extDir = options.extDir ?? mkdtempSync(join(tmpdir(), "cua-ext-"));
	host = new HarnessExtensionHost({
		harness: fx.harness,
		session: fx.session,
		cwd: fx.cwd,
		configuredPaths: [extDir],
		agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
		selfExtend: options.selfExtend ?? true,
	});
	await host.load();
	return { fx, host, extDir };
}

function names(fixture: TestHarnessFixture): string[] {
	return fixture.harness.getTools().map((tool) => tool.name);
}

async function callAddTool(fixture: TestHarnessFixture, input: AddToolInput) {
	const tool = fixture.harness
		.getTools()
		.find((candidate) => candidate.name === "add_tool");
	if (!tool) throw new Error("add_tool is not registered");
	return tool.execute("add-call", input, new AbortController().signal);
}

describe("add_tool", () => {
	it("is opt-in and remains the sole owner of its reserved name", async () => {
		const enabled = await setup();
		expect(
			names(enabled.fx).filter((name) => name === "add_tool"),
		).toHaveLength(1);
		expect(
			enabled.fx.harness.getActiveTools().map((tool) => tool.name),
		).toContain("add_tool");
		await host?.dispose();
		host = undefined;

		const disabledFx = await buildTestHarness({
			turns: [{ steps: [{ type: "text", text: "ok" }] }],
		});
		const disabled = await loadHarnessExtensions({
			harness: disabledFx.harness,
			session: disabledFx.session,
			cwd: disabledFx.cwd,
			noExtensions: false,
			agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")),
			configuredPaths: [mkdtempSync(join(tmpdir(), "cua-ext-"))],
		});
		expect(
			disabledFx.harness.getTools().map((tool) => tool.name),
		).not.toContain("add_tool");
		await disabled?.dispose();
	});

	it("drops a disk extension that collides with the loader", async () => {
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		writeFileSync(
			join(extDir, "collision.ts"),
			renderToolExtension({ ...definition("add_tool"), label: "add_tool" }),
		);
		const { fx: fixture, host: created } = await setup({ extDir });
		expect(names(fixture).filter((name) => name === "add_tool")).toHaveLength(
			1,
		);
		expect(created.loadErrors.some((entry) => entry.path === "add_tool")).toBe(
			true,
		);
	});

	it("persists and activates a tool", async () => {
		const { fx: fixture, extDir } = await setup();
		const input = definition("sorted_tool");
		input.parameters = {
			required: [],
			properties: { z: { type: "string" }, a: { type: "number" } },
			type: "object",
		};
		const result = await callAddTool(fixture, input);
		const target = resolve(extDir, "sorted_tool.ts");
		expect(result.details).toEqual({
			written: target,
			valid: true,
			addedToolNames: ["sorted_tool"],
		});
		expect(readFileSync(target, "utf8")).toBe(
			renderToolExtension({ ...input, label: "sorted_tool" }),
		);
		expect(names(fixture)).toContain("sorted_tool");
	});

	it("activates and invokes the new tool before the run ends", async () => {
		const input = definition("same_run_tool");
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		writeFileSync(
			join(extDir, "reduce-result.ts"),
			`export default function (pi) {
				pi.on("tool_result", (event) => event.toolName === "add_tool"
					? { content: [{ type: "text", text: "rewritten" }], details: { rewritten: true } }
					: undefined);
			}`,
		);
		const { fx: fixture } = await setup({
			extDir,
			turns: [
				{ steps: [{ type: "tool_call", toolName: "add_tool", args: input }] },
				{ steps: [{ type: "tool_call", toolName: "same_run_tool", args: {} }] },
				{ steps: [{ type: "text", text: "done" }] },
			],
		});
		const trace: string[] = [];
		fixture.harness.subscribe((event) => {
			if (event.type === "agent_end") trace.push("agent_end");
			if (
				event.type === "tool_execution_end" &&
				event.toolName === "same_run_tool" &&
				!event.isError
			)
				trace.push("same_run_tool");
		});
		await fixture.harness.prompt("add and use it");
		expect(trace).toEqual(["same_run_tool", "agent_end"]);
		const secondContext = fixture.provider.contexts()[1];
		expect(secondContext.tools?.map((tool) => tool.name)).toContain(
			"same_run_tool",
		);
		const addResult = secondContext.messages.find(
			(message) =>
				message.role === "toolResult" && message.toolName === "add_tool",
		);
		expect(addResult?.addedToolNames).toEqual(["same_run_tool"]);
		expect(addResult?.content).toEqual([
			{ type: "text", text: "rewritten" },
		]);
	});

	it("is discovered and callable in a new process", async () => {
		const first = await setup();
		await callAddTool(first.fx, definition("durable_tool", "durable"));
		await first.host.dispose();
		host = undefined;

		const script = `
			import { mkdtempSync } from "node:fs";
			import { tmpdir } from "node:os";
			import { join } from "node:path";
			import { HarnessExtensionHost } from "./packages/cli/src/extensions/host.ts";
			import { buildTestHarness } from "./packages/cli/test/fixtures/harness.ts";
			const fx = await buildTestHarness({ turns: [{ steps: [{ type: "text", text: "ok" }] }] });
			const host = new HarnessExtensionHost({ harness: fx.harness, session: fx.session, cwd: fx.cwd, configuredPaths: [process.env.EXT_DIR], agentDir: mkdtempSync(join(tmpdir(), "cua-agentdir-")) });
			await host.load();
			const tool = fx.harness.getTools().find((item) => item.name === "durable_tool");
			if (!tool) throw new Error("durable tool was not discovered");
			const result = await tool.execute("call", {}, new AbortController().signal);
			console.log(result.content[0].text);
			await host.dispose();
		`;
		const child = spawnSync(
			process.execPath,
			["--import", "tsx", "--input-type=module", "--eval", script],
			{
				cwd: resolve(import.meta.dirname, "../../.."),
				env: { ...process.env, EXT_DIR: first.extDir },
				encoding: "utf8",
			},
		);
		expect(child.stderr).toBe("");
		expect(child.status).toBe(0);
		expect(child.stdout).toContain("durable");
	});

	it.each([
		["../escape", "path-like name"],
		["bad/name", "slash"],
		["bad\\name", "backslash"],
		["_leading", "non-letter prefix"],
		["a".repeat(65), "overlength"],
	])("rejects unsafe name %s (%s) without writing", async (name) => {
		const { fx: fixture, extDir } = await setup();
		await expect(callAddTool(fixture, definition(name))).rejects.toThrow(
			/name must/,
		);
		expect(readdirSync(extDir)).toEqual([]);
	});

	it("rejects invalid schemas and execute sources without durable or live mutation", async () => {
		const { fx: fixture, extDir } = await setup();
		const badSchema = definition("bad_schema");
		badSchema.parameters = { type: "string" };
		await expect(callAddTool(fixture, badSchema)).rejects.toThrow(
			/top-level type/,
		);
		const badExecute = definition("bad_execute");
		badExecute.execute = "() => ({ content: [], details: {} })";
		await expect(callAddTool(fixture, badExecute)).rejects.toThrow(
			/async function expression/,
		);
		const brokenExecute = definition("broken_execute");
		brokenExecute.execute = "async ( => ({ content: [], details: {} })";
		await expect(callAddTool(fixture, brokenExecute)).rejects.toThrow(
			/validation failed/,
		);
		const sequenceExecute = definition("sequence_execute");
		sequenceExecute.execute = "async () => ({ content: [], details: {} }), 42";
		await expect(callAddTool(fixture, sequenceExecute)).rejects.toThrow(
			/one async function expression/,
		);
		expect(readdirSync(extDir)).toEqual([]);
		expect(names(fixture)).not.toEqual(
			expect.arrayContaining([
				"bad_schema",
				"bad_execute",
				"broken_execute",
				"sequence_execute",
			]),
		);
	});

	it("returns a failed tool result without ending the run", async () => {
		const { fx: fixture } = await setup({
			turns: [
				{
					steps: [
						{
							type: "tool_call",
							toolName: "add_tool",
							args: definition("../invalid"),
						},
					],
				},
				{ steps: [{ type: "text", text: "continued" }] },
			],
		});
		await fixture.harness.prompt("try an invalid tool and continue");
		const failed = fixture.provider.contexts()[1].messages.find(
			(message) =>
				message.role === "toolResult" && message.toolName === "add_tool",
		);
		expect(failed?.isError).toBe(true);
		expect(failed?.addedToolNames).toBeUndefined();
	});

	it("rejects existing artifacts and tool-name collisions without overwriting", async () => {
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		const target = join(extDir, "occupied.ts");
		writeFileSync(target, "do not replace");
		const { fx: fixture } = await setup({ extDir });
		await expect(
			callAddTool(fixture, definition("occupied")),
		).rejects.toThrow();
		expect(readFileSync(target, "utf8")).toBe("do not replace");
		await expect(callAddTool(fixture, definition("add_tool"))).rejects.toThrow(
			/already exists/,
		);
	});

	it("keeps current base and extension tools during a model-switch race", async () => {
		const extDir = mkdtempSync(join(tmpdir(), "cua-ext-"));
		writeFileSync(
			join(extDir, "disk.ts"),
			renderToolExtension({ ...definition("disk_tool"), label: "disk_tool" }),
		);
		const { fx: fixture } = await setup({ extDir });
		await Promise.all([
			callAddTool(fixture, definition("runtime_tool")),
			fixture.harness.setModel("anthropic:claude-opus-4-7"),
		]);
		expect(names(fixture)).toEqual(
			expect.arrayContaining(["add_tool", "disk_tool", "runtime_tool"]),
		);
		expect(fixture.harness.getModel().provider).toBe("anthropic");
	});

	it("manual reload adopts the durable artifact and observes edits and removal", async () => {
		const { fx: fixture, extDir, host: created } = await setup();
		await callAddTool(fixture, definition("reloadable", "first"));
		const target = join(extDir, "reloadable.ts");
		writeFileSync(
			target,
			renderToolExtension({
				...definition("reloadable", "second"),
				label: "reloadable",
			}),
		);
		expect(await created.reload()).toBe("reloaded");
		expect(names(fixture)).toEqual(
			expect.arrayContaining(["add_tool", "reloadable"]),
		);
		await import("node:fs/promises").then(({ rm }) => rm(target));
		expect(await created.reload()).toBe("reloaded");
		expect(names(fixture)).toContain("add_tool");
		expect(names(fixture)).not.toContain("reloadable");
		expect(existsSync(target)).toBe(false);
	});
});
