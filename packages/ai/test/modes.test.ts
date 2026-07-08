import { describe, expect, it } from "vitest";
import {
	CUA_ACTION_TYPES,
	CUA_DEFAULT_BROWSER_ACTION_TYPES,
	CUA_HYBRID_BROWSER_ACTION_TYPES,
	CUA_HYBRID_COMPUTER_ACTION_TYPES,
	anthropic,
	computerTools,
	cuaToolNameForAction,
	defaultActionsForMode,
	openai,
	resolveCuaRuntimeSpec,
} from "../src/index";

describe("mode action sets", () => {
	it("computer mode defaults to the legacy action set", () => {
		expect(defaultActionsForMode("computer")).toEqual(CUA_ACTION_TYPES);
	});

	it("browser mode defaults to DOM actions plus wait, without page_evaluate", () => {
		const actions = defaultActionsForMode("browser");
		expect(actions).toContain("page_snapshot");
		expect(actions).toContain("wait");
		expect(actions).not.toContain("page_evaluate");
		expect(actions).not.toContain("click");
	});

	it("browser mode exposes page_evaluate only with javascriptExec", () => {
		expect(defaultActionsForMode("browser", { javascriptExec: true })).toContain("page_evaluate");
	});

	it("hybrid mode dedupes to one tool per capability", () => {
		const actions = defaultActionsForMode("hybrid");
		// Navigation lives on the DOM plane.
		expect(actions).not.toContain("goto");
		expect(actions).not.toContain("url");
		expect(actions).toContain("page_navigate");
		// One screenshot: the OS display.
		expect(actions).toContain("screenshot");
		expect(actions).toContain("zoom");
		expect(actions).not.toContain("page_screenshot");
		// Pointer/keyboard stays OS-level.
		expect(actions).not.toContain("page_type");
		expect(actions).not.toContain("page_scroll");
		expect(actions).toEqual([...CUA_HYBRID_COMPUTER_ACTION_TYPES, ...CUA_HYBRID_BROWSER_ACTION_TYPES]);
	});
});

describe("mode tool naming", () => {
	it("computer mode keeps canonical action ids", () => {
		expect(cuaToolNameForAction("click", "computer")).toBe("click");
	});

	it("browser mode strips the page_ prefix", () => {
		expect(cuaToolNameForAction("page_snapshot", "browser")).toBe("snapshot");
		expect(cuaToolNameForAction("page_click", "browser")).toBe("click");
		expect(cuaToolNameForAction("wait", "browser")).toBe("wait");
	});

	it("hybrid mode prefixes computer actions and keeps page_ names", () => {
		expect(cuaToolNameForAction("click", "hybrid")).toBe("computer_click");
		expect(cuaToolNameForAction("page_click", "hybrid")).toBe("page_click");
	});

	it("computer mode rejects DOM actions", () => {
		expect(() => cuaToolNameForAction("page_click", "computer")).toThrow(/not available in computer mode/);
	});
});

describe("mode tool schemas", () => {
	it("browser mode click accepts refs or viewport coordinates", () => {
		const tools = computerTools({ mode: "browser" });
		const click = tools.find((tool) => tool.name === "click")!;
		expect(click.parameters.properties.ref).toBeDefined();
		expect(click.parameters.properties.x).toBeDefined();
	});

	it("hybrid mode page_click is ref-only, keeping one coordinate frame", () => {
		const tools = computerTools({ mode: "hybrid" });
		const pageClick = tools.find((tool) => tool.name === "page_click")!;
		expect(pageClick.parameters.properties.ref).toBeDefined();
		expect(pageClick.parameters.properties.x).toBeUndefined();
		expect(pageClick.parameters.required).toContain("ref");
	});

	it("browser mode exposes every default DOM action under its unprefixed name", () => {
		const tools = computerTools({ mode: "browser" });
		const names = tools.map((tool) => tool.name);
		for (const action of CUA_DEFAULT_BROWSER_ACTION_TYPES) {
			expect(names).toContain(action.slice("page_".length));
		}
	});
});

describe("mode runtime specs", () => {
	it("resolves browser mode for anthropic with mode-specific prompt and tools", () => {
		const spec = resolveCuaRuntimeSpec("anthropic:claude-opus-4-5", { mode: "browser" });
		expect(spec.mode).toBe("browser");
		expect(spec.toolDefinitions.map((tool) => tool.name)).toContain("snapshot");
		expect(spec.defaultSystemPrompt).toBe(anthropic.buildAnthropicSystemPrompt({ mode: "browser" }));
	});

	it("resolves hybrid mode for openai", () => {
		const spec = resolveCuaRuntimeSpec("openai:gpt-5.5", { mode: "hybrid" });
		expect(spec.mode).toBe("hybrid");
		const names = spec.toolDefinitions.map((tool) => tool.name);
		expect(names).toContain("computer_click");
		expect(names).toContain("page_snapshot");
		expect(spec.defaultSystemPrompt).toBe(openai.buildOpenAISystemPrompt({ mode: "hybrid" }));
	});

	it("rejects non-computer modes for computer-only providers", () => {
		expect(() => resolveCuaRuntimeSpec("yutori:n1.5-latest", { mode: "browser" })).toThrow(/computer only/);
		expect(() => resolveCuaRuntimeSpec("google:gemini-3-flash-preview", { mode: "hybrid" })).toThrow(/computer only/);
	});

	it("keeps computer mode byte-compatible with the pre-modes default", () => {
		const before = resolveCuaRuntimeSpec("anthropic:claude-opus-4-5");
		const after = resolveCuaRuntimeSpec("anthropic:claude-opus-4-5", { mode: "computer" });
		expect(after.toolDefinitions.map((tool) => tool.name)).toEqual(before.toolDefinitions.map((tool) => tool.name));
	});
});
