import {
	InMemorySessionRepo,
	type Session,
	type Skill,
} from "@onkernel/cua-agent";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { parseCuaModelRef } from "@onkernel/cua-ai";
import { buildCuaHarness, type CuaCliTool, defaultInteractionTools } from "../../src/harness";
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
	/** CUA model ref. Defaults to the CLI's OpenAI default. */
	modelRef?: string;
	tools?: CuaCliTool[];
	retry?: Parameters<typeof buildCuaHarness>[0]["retry"];
}

export async function buildTestHarness(opts: BuildTestHarnessOptions): Promise<TestHarnessFixture> {
	const modelRef = opts.modelRef ?? "openai:gpt-5.6-sol";
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
		tools: opts.tools ?? defaultInteractionTools(modelRef as never),
		models: provider.models,
		retry: opts.retry,
	});

	return {
		provider,
		kernel,
		session,
		cwd,
		harness,
	};
}
