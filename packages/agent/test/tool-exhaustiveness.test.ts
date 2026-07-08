import { CUA_PROVIDERS, listCuaModels, resolveCuaRuntimeSpec } from "@onkernel/cua-ai";
import type Kernel from "@onkernel/sdk";
import { describe, expect, it } from "vitest";
import { createCuaComputerTools, type KernelBrowser } from "../src/index";

const browser = { session_id: "browser_123" } as KernelBrowser;
const client = {} as Kernel;
const ANTHROPIC_BATCH_TOOL_NAME = "computer_batch";
const tinyPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
	"base64",
);

describe("Cua tool executor coverage", () => {
	it("covers every tool executor exported by cua-ai defaults", () => {
		for (const provider of CUA_PROVIDERS) {
			const model = listCuaModels(provider)[0];
			expect(model, `no CUA model for provider ${provider}`).toBeDefined();
			const runtime = resolveCuaRuntimeSpec(model!.ref);
			expect(() => createCuaComputerTools({ browser, client, toolExecutors: runtime.toolExecutors })).not.toThrow();
		}
	});

	it("instantiates one executor per provider execution adapter", () => {
		const toolExecutors = resolveCuaRuntimeSpec("openai:gpt-5.5").toolExecutors;
		const tools = createCuaComputerTools({ browser, client, toolExecutors });
		expect(tools.map((tool) => tool.name).sort()).toEqual(toolExecutors.map((tool) => tool.definition.name).sort());
	});

	it("executes Yutori local canonical action tools", async () => {
		const batches: unknown[] = [];
		const runtime = resolveCuaRuntimeSpec("yutori:n1.5-latest");
		const tools = createCuaComputerTools({
			browser: { ...browser, viewport: { width: 1920, height: 1080 } },
			client: {
				browsers: {
					computer: {
						batch: async (_id: string, body: { actions: unknown[] }) => {
							batches.push(body.actions);
						},
						captureScreenshot: async () => new Response(tinyPng),
					},
				},
			} as unknown as Kernel,
			toolExecutors: runtime.toolExecutors,
			coordinateSystem: runtime.coordinateSystem,
			screenshot: runtime.screenshot,
		});
		const click = tools.find((tool) => tool.name === "click");
		expect(click).toBeDefined();

		const result = await click!.execute("call_1", { x: 500, y: 250 });

		expect(batches).toEqual([
			[{ type: "click_mouse", click_mouse: { x: 960, y: 270, button: "left" } }],
		]);
		expect(result.content.at(-1)).toMatchObject({ type: "image", mimeType: "image/webp" });
	});

	it("executes provider-defined batch tools as canonical CUA batches", async () => {
		const batches: unknown[] = [];
		const runtime = resolveCuaRuntimeSpec("anthropic:claude-opus-4-7");
		const tools = createCuaComputerTools({
			browser,
			client: {
				browsers: {
					computer: {
						batch: async (_id: string, body: { actions: unknown[] }) => {
							batches.push(body.actions);
						},
						captureScreenshot: async () => new Response(tinyPng),
					},
				},
			} as unknown as Kernel,
			toolExecutors: runtime.toolExecutors,
			coordinateSystem: runtime.coordinateSystem,
		});
		const batch = tools.find((tool) => tool.name === ANTHROPIC_BATCH_TOOL_NAME);
		expect(batch).toBeDefined();

		const result = await batch!.execute("call_1", { actions: [{ type: "click", x: 10, y: 20 }] });

		expect(batches).toEqual([
			[{ type: "click_mouse", click_mouse: { x: 10, y: 20, button: "left" } }],
		]);
		expect(result.content.at(-1)).toMatchObject({ type: "image", mimeType: "image/png" });
	});

	it("runs computer_use_extra without auto-appending a screenshot", async () => {
		const runtime = resolveCuaRuntimeSpec("openai:gpt-5.5");
		const tools = createCuaComputerTools({
			browser,
			client: {
				browsers: {
					computer: {
						batch: async () => undefined,
						captureScreenshot: async () => new Response(tinyPng),
					},
				},
			} as unknown as Kernel,
			toolExecutors: runtime.toolExecutors,
			computerUseExtra: true,
		});
		const nav = tools.find((tool) => tool.name === "computer_use_extra");
		expect(nav).toBeDefined();

		const result = await nav!.execute("call_1", { action: "back" });

		expect(result.content).toEqual([{ type: "text", text: "back executed successfully." }]);
		expect(result.details).toMatchObject({ action: "back", statusText: "back executed successfully." });
	});

	it("runs the playwright_execute tool and returns result + stdout as tool content", async () => {
		const calls: Array<{ id: string; body: { code: string; timeout_sec?: number } }> = [];
		const runtime = resolveCuaRuntimeSpec("openai:gpt-5.5");
		const tools = createCuaComputerTools({
			browser,
			client: {
				browsers: {
					playwright: {
						execute: async (id: string, body: { code: string; timeout_sec?: number }) => {
							calls.push({ id, body });
							return { success: true, result: "Example Domain", stdout: "logged\n", stderr: "" };
						},
					},
				},
			} as unknown as Kernel,
			toolExecutors: runtime.toolExecutors,
			playwright: true,
		});
		const playwright = tools.find((tool) => tool.name === "playwright_execute");
		expect(playwright).toBeDefined();

		const result = await playwright!.execute("call_1", { code: "return await page.title();", timeout_sec: 30 });

		expect(calls).toEqual([{ id: "browser_123", body: { code: "return await page.title();", timeout_sec: 30 } }]);
		expect(result.content[0]).toMatchObject({ type: "text", text: "result: Example Domain" });
		expect(result.content.some((block) => block.type === "text" && block.text === "stdout:\nlogged")).toBe(true);
		expect(result.content.every((block) => block.type !== "image")).toBe(true);
		expect(result.details).toMatchObject({ success: true });
	});

	it("falls back to statusText for side-effect-only playwright_execute calls", async () => {
		const runtime = resolveCuaRuntimeSpec("openai:gpt-5.5");
		const tools = createCuaComputerTools({
			browser,
			client: {
				browsers: {
					playwright: { execute: async () => ({ success: true }) },
				},
			} as unknown as Kernel,
			toolExecutors: runtime.toolExecutors,
			playwright: true,
		});
		const playwright = tools.find((tool) => tool.name === "playwright_execute");
		expect(playwright).toBeDefined();

		const result = await playwright!.execute("call_1", { code: "await page.click('#submit')" });

		expect(result.content).toEqual([
			{ type: "text", text: "Playwright executed successfully." },
		]);
		expect(result.details).toMatchObject({ success: true, statusText: "Playwright executed successfully." });
	});

	it("surfaces playwright_execute failures as tool content without throwing", async () => {
		const runtime = resolveCuaRuntimeSpec("openai:gpt-5.5");
		const tools = createCuaComputerTools({
			browser,
			client: {
				browsers: {
					playwright: { execute: async () => ({ success: false, error: "boom", stderr: "stack" }) },
				},
			} as unknown as Kernel,
			toolExecutors: runtime.toolExecutors,
			playwright: true,
		});
		const playwright = tools.find((tool) => tool.name === "playwright_execute");
		expect(playwright).toBeDefined();

		const result = await playwright!.execute("call_1", { code: "await page.click('#missing')" });

		expect(result.content.some((block) => block.type === "text" && block.text.includes("error: boom"))).toBe(true);
		expect(result.content.some((block) => block.type === "text" && block.text === "stderr:\nstack")).toBe(true);
		expect(result.content.every((block) => block.type !== "image")).toBe(true);
		expect(result.details).toMatchObject({ success: false });
	});
});
