import { describe, expect, it } from "vitest";
import {
	formatSkillsForSystemPrompt,
	InMemorySessionRepo,
	type Skill,
} from "@onkernel/cua-agent";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { resolveCuaRuntimeSpec } from "@onkernel/cua-ai";
import { buildCuaHarness } from "../src/harness";
import { createFakeKernelEnvironment } from "./fixtures/fake-kernel";
import { createScriptedCuaModels } from "./fixtures/scripted-provider";

describe("buildCuaHarness", () => {
	it("installs createCodingTools as extraTools by default", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cua-cli-harness-"));
		const kernel = createFakeKernelEnvironment();
		const session = await new InMemorySessionRepo().create();
		const harness = buildCuaHarness({
			cwd,
			client: kernel.client,
			browser: kernel.browser,
			session,
			model: "openai:gpt-5.5",
		});
		const toolNames = harness.getTools().map((tool) => tool.name);
		const codingToolNames = createCodingTools(cwd).map((tool) => tool.name);
		for (const name of codingToolNames) {
			expect(toolNames).toContain(name);
		}
	});

	it("composes the cua-ai default system prompt with the skill block", async () => {
		const provider = createScriptedCuaModels("openai", [
			{ steps: [{ type: "text", text: "ok" }] },
		]);
		const cwd = mkdtempSync(join(tmpdir(), "cua-cli-harness-"));
		const kernel = createFakeKernelEnvironment();
		const session = await new InMemorySessionRepo().create();
		const skill: Skill = {
			name: "demo",
			description: "demo skill for tests",
			content: "Use the demo workflow.",
			filePath: join(cwd, "demo.md"),
		};
		const harness = buildCuaHarness({
			cwd,
			client: kernel.client,
			browser: kernel.browser,
			session,
			model: "openai:gpt-5.5",
			skills: [skill],
			extraTools: [],
			models: provider.models,
		});
		let capturedSystemPrompt: string | undefined;
		harness.on("before_agent_start", (event) => {
			capturedSystemPrompt = event.systemPrompt;
			return undefined;
		});
		await harness.prompt("hi");
		const runtime = resolveCuaRuntimeSpec("openai:gpt-5.5");
		const skillBlock = formatSkillsForSystemPrompt([skill]).trim();
		expect(capturedSystemPrompt).toContain(runtime.defaultSystemPrompt.trim());
		expect(capturedSystemPrompt).toContain(skillBlock);
	});

	it("injects loaded context files into the system prompt", async () => {
		const provider = createScriptedCuaModels("openai", [
			{ steps: [{ type: "text", text: "ok" }] },
		]);
		const cwd = mkdtempSync(join(tmpdir(), "cua-cli-harness-"));
		const kernel = createFakeKernelEnvironment();
		const session = await new InMemorySessionRepo().create();
		const harness = buildCuaHarness({
			cwd,
			client: kernel.client,
			browser: kernel.browser,
			session,
			model: "openai:gpt-5.5",
			contextFiles: [{ path: join(cwd, "AGENTS.md"), content: "Always prefer tabs over spaces." }],
			extraTools: [],
			models: provider.models,
		});
		let capturedSystemPrompt: string | undefined;
		harness.on("before_agent_start", (event) => {
			capturedSystemPrompt = event.systemPrompt;
			return undefined;
		});
		await harness.prompt("hi");
		expect(capturedSystemPrompt).toContain("Always prefer tabs over spaces.");
		expect(capturedSystemPrompt).toContain(join(cwd, "AGENTS.md"));
	});

	it("forwards response-threading configuration to the provider", async () => {
		const provider = createScriptedCuaModels("openai", [
			{ steps: [{ type: "text", text: "ok" }] },
		]);
		const cwd = mkdtempSync(join(tmpdir(), "cua-cli-harness-"));
		const kernel = createFakeKernelEnvironment();
		const session = await new InMemorySessionRepo().create();
		const harness = buildCuaHarness({
			cwd,
			client: kernel.client,
			browser: kernel.browser,
			session,
			model: "openai:gpt-5.5",
			extraTools: [],
			models: provider.models,
			responseThreading: false,
		});

		await harness.prompt("hi");

		expect(provider.lastStreamOptions()?.disableResponseThreading).toBe(true);
	});

	it("delivers the first prompt with an image attached via harness.prompt({ images })", async () => {
		const provider = createScriptedCuaModels("openai", [
			{ steps: [{ type: "text", text: "done" }] },
		]);

		const cwd = mkdtempSync(join(tmpdir(), "cua-cli-harness-"));
		const kernel = createFakeKernelEnvironment();
		const session = await new InMemorySessionRepo().create();
		const harness = buildCuaHarness({
			cwd,
			client: kernel.client,
			browser: kernel.browser,
			session,
			model: "openai:gpt-5.5",
			extraTools: [],
			models: provider.models,
		});

		const tinyPngBase64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
		await harness.prompt("look at this", {
			images: [{ type: "image", data: tinyPngBase64, mimeType: "image/png" }],
		});

		const entries = await session.getBranch();
		const firstUser = entries.find((e) => e.type === "message" && e.message.role === "user");
		expect(firstUser).toBeDefined();
		const content = (firstUser as { message: { content: unknown[] } }).message.content as Array<{
			type: string;
			data?: string;
		}>;
		expect(content.some((c) => c.type === "image" && c.data === tinyPngBase64)).toBe(true);
	});
});
