import { describe, expect, it } from "vitest";
import {
	formatSkillsForSystemPrompt,
	InMemorySessionRepo,
	type Skill,
} from "@onkernel/cua-agent";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { buildCuaHarness, defaultInteractionTools } from "../src/harness";
import { createFakeKernelEnvironment } from "./fixtures/fake-kernel";
import { createScriptedCuaModels } from "./fixtures/scripted-provider";

describe("buildCuaHarness", () => {
	it("chooses explicit model-specific interaction catalogs", () => {
		const openaiNames = defaultInteractionTools("openai:gpt-5.6-sol").map((tool) => tool.name);
		expect(openaiNames[0]).toBe("browser_snapshot");
		expect(openaiNames.at(-1)).toBe("browser_act");
		expect(defaultInteractionTools("anthropic:claude-opus-5")).toEqual([
			expect.objectContaining({ name: "browser", origin: "provider-native" }),
		]);
		expect(defaultInteractionTools("anthropic:claude-3-7-sonnet").map((tool) => tool.name).at(-1)).toBe("browser_act");
		const googleNames = defaultInteractionTools("google:gemini-3.6-flash").map((tool) => tool.name);
		expect(googleNames).toContain("take_screenshot");
		expect(googleNames).not.toContain("browser_act");
		for (const model of ["xai:grok-4.5", "openrouter:meta/muse-spark-1.1"] as const) {
			const tools = defaultInteractionTools(model);
			expect(tools[0]).toMatchObject({ name: "browser_snapshot", origin: "cua" });
			expect(tools.at(-1)?.name).toBe("browser_act");
		}
		// Kimi's API rejects the request once browser_act's schema is attached.
		for (const model of ["moonshotai:kimi-k3", "openrouter:moonshotai/kimi-k3"] as const) {
			const kimiNames = defaultInteractionTools(model).map((tool) => tool.name);
			expect(kimiNames[0]).toBe("browser_snapshot");
			expect(kimiNames).not.toContain("browser_act");
			expect(kimiNames).toContain("browser_wait_for");
		}
	});

	it("installs interaction and coding tools in one explicit default list", async () => {
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
		expect(toolNames).toContain("browser_click");
		expect(toolNames).toContain("browser_screenshot");
		expect(toolNames).toContain("browser_act");
		// pi's native read/bash/edit/write coding tools close the list, in order.
		expect(toolNames.slice(-4)).toEqual(["read", "bash", "edit", "write"]);
	});

	it("uses only the caller-owned skill block as its system prompt", async () => {
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
			tools: [],
			models: provider.models,
		});
		let capturedSystemPrompt: string | undefined;
		harness.on("before_agent_start", (event) => {
			capturedSystemPrompt = event.systemPrompt;
			return undefined;
		});
		await harness.prompt("hi");
		const skillBlock = formatSkillsForSystemPrompt([skill]).trim();
		expect(capturedSystemPrompt?.trim()).toBe(skillBlock);
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
			tools: [],
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
			tools: [],
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
			tools: [],
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
