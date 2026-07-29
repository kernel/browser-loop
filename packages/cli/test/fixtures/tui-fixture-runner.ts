/**
 * Child-process entry point for ptywright-driven TUI tests. Spawned via
 * `tsx` so the same source file the vitest harness imports gets type-checked
 * and exercised. Receives a JSON fixture path on argv[2], registers the
 * scripted provider, assembles the real {@link buildCuaHarness}, and starts
 * the interactive TUI.
 */
import { InMemorySessionRepo, type Skill } from "@onkernel/cua-agent";
import { parseCuaModelRef, type CuaModelRef } from "@onkernel/cua-ai";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildCuaHarness } from "../../src/harness";
import type { ContextFile } from "../../src/harness-skills";
import { runInteractive } from "../../src/tui/main";
import { createFakeKernelEnvironment } from "./fake-kernel";
import { createScriptedCuaModels, type ScriptedTurn } from "./scripted-provider";

interface TuiFixture {
	modelRef?: string;
	turns: ScriptedTurn[];
	skills?: Skill[];
	contextFiles?: ContextFile[];
}

async function main(): Promise<void> {
	const fixtureArg = process.argv[2];
	if (!fixtureArg) {
		throw new Error("usage: tui-fixture-runner <fixture.json>");
	}
	const fixturePath = resolve(process.cwd(), fixtureArg);
	const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as TuiFixture;

	const modelRef = fixture.modelRef ?? "openai:gpt-5.5";
	const scripted = createScriptedCuaModels(parseCuaModelRef(modelRef).provider, fixture.turns);

	const kernel = createFakeKernelEnvironment();
	const sessionRepo = new InMemorySessionRepo();
	const session = await sessionRepo.create();
	const cwd = process.cwd();
	const skills = fixture.skills ?? [];
	const contextFiles = fixture.contextFiles ?? [];
	const harness = buildCuaHarness({
		cwd,
		client: kernel.client,
		browser: kernel.browser,
		session,
		model: modelRef as CuaModelRef,
		skills,
		contextFiles,
		tools: [],
		models: scripted.models,
	});

	const code = await runInteractive({
		cwd,
		harness,
		browserHandle: {
			client: kernel.client,
			browser: kernel.browser,
			async close(): Promise<void> {},
		},
		session,
		skills,
		contextFiles,
		modelRef,
		provider: modelRef.split(":", 1)[0] ?? "openai",
		applicationTools: [],
	});
	process.exit(code);
}

main().catch((err) => {
	process.stderr.write(`fixture error: ${(err as Error).message}\n`);
	process.exit(1);
});
