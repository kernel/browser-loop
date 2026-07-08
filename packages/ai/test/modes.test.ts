import { describe, expect, it } from "vitest";
import {
	CUA_ACTION_TYPES,
	CUA_DEFAULT_DOM_ACTION_TYPES,
	CUA_HYBRID_DOM_ACTION_TYPES,
	CUA_HYBRID_OS_ACTION_TYPES,
	anthropic,
	computerTools,
	cuaToolNameForAction,
	defaultActionsForMode,
	openai,
	resolveCuaRuntimeSpec,
} from "../src/index";

describe("mode action sets", () => {
	it("os mode defaults to the legacy action set", () => {
		expect(defaultActionsForMode("os")).toEqual(CUA_ACTION_TYPES);
	});

	it("dom mode defaults to DOM actions plus wait, without page_evaluate", () => {
		const actions = defaultActionsForMode("dom");
		expect(actions).toContain("page_snapshot");
		expect(actions).toContain("wait");
		expect(actions).not.toContain("page_evaluate");
		expect(actions).not.toContain("click");
	});

	it("dom mode exposes page_evaluate only with javascriptExec", () => {
		expect(defaultActionsForMode("dom", { javascriptExec: true })).toContain("page_evaluate");
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
		expect(actions).toEqual([...CUA_HYBRID_OS_ACTION_TYPES, ...CUA_HYBRID_DOM_ACTION_TYPES]);
	});
});

describe("mode tool naming", () => {
	it("os mode keeps canonical action ids", () => {
		expect(cuaToolNameForAction("click", "os")).toBe("click");
	});

	it("dom mode strips the page_ prefix", () => {
		expect(cuaToolNameForAction("page_snapshot", "dom")).toBe("snapshot");
		expect(cuaToolNameForAction("page_click", "dom")).toBe("click");
		expect(cuaToolNameForAction("wait", "dom")).toBe("wait");
	});

	it("hybrid mode prefixes OS actions and keeps page_ names", () => {
		expect(cuaToolNameForAction("click", "hybrid")).toBe("computer_click");
		expect(cuaToolNameForAction("page_click", "hybrid")).toBe("page_click");
	});

	it("os mode rejects DOM actions", () => {
		expect(() => cuaToolNameForAction("page_click", "os")).toThrow(/not available in os mode/);
	});
});

describe("mode tool schemas", () => {
	it("dom mode click accepts refs or viewport coordinates", () => {
		const tools = computerTools({ mode: "dom" });
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

	it("dom mode exposes every default DOM action under its unprefixed name", () => {
		const tools = computerTools({ mode: "dom" });
		const names = tools.map((tool) => tool.name);
		for (const action of CUA_DEFAULT_DOM_ACTION_TYPES) {
			expect(names).toContain(action.slice("page_".length));
		}
	});
});

describe("mode runtime specs", () => {
	it("resolves dom mode for anthropic with mode-specific prompt and tools", () => {
		const spec = resolveCuaRuntimeSpec("anthropic:claude-opus-4-5", { mode: "dom" });
		expect(spec.mode).toBe("dom");
		expect(spec.toolDefinitions.map((tool) => tool.name)).toContain("snapshot");
		expect(spec.defaultSystemPrompt).toBe(anthropic.buildAnthropicSystemPrompt({ mode: "dom" }));
	});

	it("resolves hybrid mode for openai", () => {
		const spec = resolveCuaRuntimeSpec("openai:gpt-5.5", { mode: "hybrid" });
		expect(spec.mode).toBe("hybrid");
		const names = spec.toolDefinitions.map((tool) => tool.name);
		expect(names).toContain("computer_click");
		expect(names).toContain("page_snapshot");
		expect(spec.defaultSystemPrompt).toBe(openai.buildOpenAISystemPrompt({ mode: "hybrid" }));
	});

	it("rejects non-os modes for os-only providers", () => {
		expect(() => resolveCuaRuntimeSpec("yutori:n1.5-latest", { mode: "dom" })).toThrow(/os only/);
		expect(() => resolveCuaRuntimeSpec("google:gemini-3-flash-preview", { mode: "hybrid" })).toThrow(/os only/);
	});

	it("keeps os mode byte-compatible with the pre-modes default", () => {
		const before = resolveCuaRuntimeSpec("anthropic:claude-opus-4-5");
		const after = resolveCuaRuntimeSpec("anthropic:claude-opus-4-5", { mode: "os" });
		expect(after.toolDefinitions.map((tool) => tool.name)).toEqual(before.toolDefinitions.map((tool) => tool.name));
	});
});
