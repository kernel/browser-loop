import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	CUA_ACTION_TYPES,
	CUA_BROWSER_ACTION_TYPES,
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

	it("browser mode defaults to every browser action plus wait", () => {
		const actions = defaultActionsForMode("browser");
		expect(actions).toContain("browser_snapshot");
		expect(actions).toContain("wait");
		expect(actions).toContain("browser_evaluate");
		expect(actions).not.toContain("click");
	});

	it("hybrid mode dedupes to one tool per capability", () => {
		const actions = defaultActionsForMode("hybrid");
		// Navigation lives on the browser plane.
		expect(actions).not.toContain("goto");
		expect(actions).not.toContain("url");
		expect(actions).toContain("browser_navigate");
		// One screenshot: the OS display.
		expect(actions).toContain("screenshot");
		expect(actions).toContain("zoom");
		expect(actions).not.toContain("browser_screenshot");
		// Pointer/keyboard stays OS-level.
		expect(actions).not.toContain("browser_type");
		expect(actions).not.toContain("browser_scroll");
		expect(actions).toEqual([...CUA_HYBRID_COMPUTER_ACTION_TYPES, ...CUA_HYBRID_BROWSER_ACTION_TYPES]);
	});
});

describe("mode tool naming", () => {
	it("computer mode keeps canonical action ids", () => {
		expect(cuaToolNameForAction("click", "computer")).toBe("click");
	});

	it("browser mode strips the browser_ prefix", () => {
		expect(cuaToolNameForAction("browser_snapshot", "browser")).toBe("snapshot");
		expect(cuaToolNameForAction("browser_click", "browser")).toBe("click");
		expect(cuaToolNameForAction("wait", "browser")).toBe("wait");
	});

	it("hybrid mode prefixes computer actions and keeps browser_ names", () => {
		expect(cuaToolNameForAction("click", "hybrid")).toBe("computer_click");
		expect(cuaToolNameForAction("browser_click", "hybrid")).toBe("browser_click");
	});

	it("computer mode rejects browser actions", () => {
		expect(() => cuaToolNameForAction("browser_click", "computer")).toThrow(/not available in computer mode/);
	});
});

describe("mode tool schemas", () => {
	it("browser mode click accepts refs or viewport coordinates and bounds click count", () => {
		const tools = computerTools({ mode: "browser" });
		const click = tools.find((tool) => tool.name === "click")!;
		expect(click.parameters.properties.ref).toBeDefined();
		expect(click.parameters.properties.x).toBeDefined();
		expect(click.parameters.properties.num_clicks).toMatchObject({ type: "integer", minimum: 1, maximum: 3 });
		for (const num_clicks of [0, 4]) expect(() => validateToolArguments(click, { type: "toolCall", id: "1", name: "click", arguments: { ref: "e1", num_clicks } })).toThrow();
	});

	it("hybrid mode browser_click is ref-only, keeping one coordinate frame", () => {
		const tools = computerTools({ mode: "hybrid" });
		const pageClick = tools.find((tool) => tool.name === "browser_click")!;
		expect(pageClick.parameters.properties.ref).toBeDefined();
		expect(pageClick.parameters.properties.x).toBeUndefined();
		expect(pageClick.parameters.required).toContain("ref");
	});

	it("browser mode exposes every default browser action under its unprefixed name", () => {
		const tools = computerTools({ mode: "browser" });
		const names = tools.map((tool) => tool.name);
		for (const action of CUA_BROWSER_ACTION_TYPES) {
			expect(names).toContain(action.slice("browser_".length));
		}
		expect(names).toContain("wait_for");
	});

	it("exposes dependent action plans with bounded steps", () => {
		const browserAct = computerTools({ mode: "browser" }).find((tool) => tool.name === "act")!;
		const hybridAct = computerTools({ mode: "hybrid" }).find((tool) => tool.name === "browser_act")!;
		expect(browserAct.description).toContain("call snapshot or find to obtain current element refs");
		expect(browserAct.description).toContain("Never invent refs");
		expect(browserAct.parameters.properties.steps).toMatchObject({ minItems: 1, maxItems: 20 });
		expect(browserAct.parameters.properties.timeout_ms).toMatchObject({ minimum: 1, maximum: 30_000 });
		expect(browserAct.parameters.properties.poll_ms).toMatchObject({ minimum: 10, maximum: 1_000 });
		const clickStep = (browserAct.parameters.properties.steps.items as { anyOf: Array<{ properties: Record<string, unknown> }> }).anyOf[0]!;
		expect(clickStep.properties.num_clicks).toMatchObject({ type: "integer", minimum: 1, maximum: 3 });
		expect(clickStep.properties.timeout_ms).toMatchObject({ minimum: 1, maximum: 30_000 });
		expect(hybridAct).toBeDefined();
		for (const arguments_ of [
			{ steps: [] },
			{ steps: [{ type: "wait" }], timeout_ms: 0 },
			{ steps: [{ type: "wait", timeout_ms: 0 }] },
			{ steps: [{ type: "wait", ms: 30_001 }] },
			{ steps: [{ type: "click", ref: "e1", num_clicks: 0 }] },
			{ steps: [{ type: "click", ref: "e1", num_clicks: 4 }] },
		]) expect(() => validateToolArguments(browserAct, { type: "toolCall", id: "1", name: "act", arguments: arguments_ })).toThrow();
		for (const arguments_ of [
			{ steps: [{ type: "click", ref: "e1", timeout_ms: 1_000, expect: { type: "text", text: "Done" } }] },
			{ steps: [{ type: "wait" }], expect: { all: [{ type: "url", changed: true }] } },
		]) expect(() => validateToolArguments(browserAct, { type: "toolCall", id: "1", name: "act", arguments: arguments_ })).not.toThrow();
	});

	it("registers semantic waits in hybrid mode with bounded polling", () => {
		const wait = computerTools({ mode: "hybrid" }).find((tool) => tool.name === "browser_wait_for")!;
		expect(wait.parameters.properties.timeout_ms).toMatchObject({ minimum: 1, maximum: 30_000 });
		expect(wait.parameters.properties.poll_ms).toMatchObject({ minimum: 10, maximum: 1_000 });
	});

	it.each([
		{ type: "text", text: "Ready" },
		{ type: "role_name", role: "button" },
		{ type: "ref", ref: "e1", checked: true },
		{ type: "url", changed: true },
		{ all: [{ type: "text", text: "Ready" }] },
		{ any: [{ type: "title", contains: "Done" }] },
	])("accepts semantic expectation %#", (condition) => {
		const tool = computerTools({ mode: "hybrid" }).find((candidate) => candidate.name === "browser_wait_for")!;
		expect(() => validateToolArguments(tool, { type: "toolCall", id: "1", name: tool.name, arguments: { expect: condition } })).not.toThrow();
	});

	it("rejects a zero semantic wait timeout", () => {
		const tool = computerTools({ mode: "hybrid" }).find((candidate) => candidate.name === "browser_wait_for")!;
		expect(() => validateToolArguments(tool, {
			type: "toolCall",
			id: "1",
			name: tool.name,
			arguments: { expect: { type: "text", text: "Ready" }, timeout_ms: 0 },
		})).toThrow();
	});

	it.each([
		{},
		{ type: "text" },
		{ type: "role_name" },
		{ type: "ref", ref: "e1" },
		{ type: "url" },
		{ all: [] },
		{ all: [{ any: [{ type: "text", text: "nested" }] }] },
	])("rejects malformed semantic expectation %#", (condition) => {
		const tool = computerTools({ mode: "hybrid" }).find((candidate) => candidate.name === "browser_wait_for")!;
		expect(() => validateToolArguments(tool, { type: "toolCall", id: "1", name: tool.name, arguments: { expect: condition } })).toThrow();
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
		expect(names).toContain("browser_snapshot");
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
