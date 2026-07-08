import {
	InMemorySessionRepo,
	type Session,
	type Skill,
} from "@onkernel/cua-agent";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { parseCuaModelRef } from "@onkernel/cua-ai";
import { buildCuaHarness } from "../../src/harness";
import { createFakeKernelEnvironment, type FakeKernelEnvironment } from "./fake-kernel";
import type { ScriptedProviderHandle, ScriptedTurn } from "./scripted-provider";
import { createScriptedCuaModels } from "./scripted-provider";

export interface TestHarnessFixture {
	provider: ScriptedProviderHandle;
	kernel: FakeKernelEnvironment;
	session: Session;
	cwd: string;
	harness: ReturnType<typeof buildCuaHarness>;
}

export interface BuildTestHarnessOptions {
	turns: ScriptedTurn[];
	skills?: Skill[];
	/** CUA model ref. Defaults to "openai:gpt-5.5". */
	modelRef?: string;
}

export async function buildTestHarness(opts: BuildTestHarnessOptions): Promise<TestHarnessFixture> {
	const modelRef = opts.modelRef ?? "openai:gpt-5.5";
	const provider = createScriptedCuaModels(parseCuaModelRef(modelRef).provider, opts.turns);

	const kernel = createFakeKernelEnvironment();
	const cwd = mkdtempSync(join(tmpdir(), "cua-cli-test-"));

	const sessionRepo = new InMemorySessionRepo();
	const session = await sessionRepo.create();

	const harness = buildCuaHarness({
		cwd,
		client: kernel.client,
		browser: kernel.browser,
		session,
		model: modelRef as never,
		skills: opts.skills,
		extraTools: [],
		models: provider.models,
	});

	return {
		provider,
		kernel,
		session,
		cwd,
		harness,
	};
}
