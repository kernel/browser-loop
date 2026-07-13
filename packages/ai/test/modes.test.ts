import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	CUA_ACTION_TYPES,
	CUA_BROWSER_ACTION_TYPES,
	CUA_HYBRID_BROWSER_ACTION_TYPES,
	CUA_HYBRID_COMPUTER_ACTION_TYPES,
	anthropic,
	computerTools,
	createCuaActionSchema,
	createCuaBatchSchema,
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
		expect(actions).toContain("browser_act");
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
		expect(actions).toContain("browser_act");
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
		expect(cuaToolNameForAction("browser_act", "browser")).toBe("act");
		expect(cuaToolNameForAction("wait", "browser")).toBe("wait");
	});

	it("hybrid mode prefixes computer actions and keeps browser_ names", () => {
		expect(cuaToolNameForAction("click", "hybrid")).toBe("computer_click");
		expect(cuaToolNameForAction("browser_click", "hybrid")).toBe("browser_click");
		expect(cuaToolNameForAction("browser_act", "hybrid")).toBe("browser_act");
	});

	it("computer mode rejects browser actions", () => {
		expect(() => cuaToolNameForAction("browser_click", "computer")).toThrow(/not available in computer mode/);
	});
});

describe("mode tool schemas", () => {
	it("browser mode click accepts refs or viewport coordinates", () => {
		const tools = computerTools({ mode: "browser" });
		const click = tools.find((tool) => tool.name === "click")!;
		expect(click.parameters.properties.ref).toBeDefined();
		expect(click.parameters.properties.x).toBeDefined();
	});

	it("hybrid mode browser_click is ref-only, keeping one coordinate frame", () => {
		const tools = computerTools({ mode: "hybrid" });
		const pageClick = tools.find((tool) => tool.name === "browser_click")!;
		expect(pageClick.parameters.properties.ref).toBeDefined();
		expect(pageClick.parameters.properties.x).toBeUndefined();
		expect(pageClick.parameters.required).toContain("ref");
	});

	it("exposes browser_act as a ref-only dependent action schema", () => {
		const browserAct = computerTools({ mode: "browser" }).find((tool) => tool.name === "act")!;
		const hybridAct = computerTools({ mode: "hybrid" }).find((tool) => tool.name === "browser_act")!;
		for (const tool of [browserAct, hybridAct]) {
			expect(tool.parameters.properties.steps).toBeDefined();
			expect(tool.parameters.properties.expect).toBeDefined();
			expect(tool.parameters.properties.successor).toBeDefined();
			expect(JSON.stringify(tool.parameters.properties.steps)).not.toContain('"x"');
			expect(JSON.stringify(tool.parameters).length).toBeLessThan(10_000);
		}
	});

	it("keeps browser_act definitions resolvable in action unions and batches", () => {
		const union = {
			name: "action",
			description: "action",
			parameters: createCuaActionSchema(defaultActionsForMode("browser"), "browser"),
		};
		expect(union.parameters.$defs).toBeDefined();
		expect(() =>
			validateToolArguments(union, {
				id: "call_0",
				name: "action",
				arguments: { type: "browser_act", steps: [{ type: "wait", ms: 0, expect: { type: "url", changed: true } }] },
			}),
		).not.toThrow();

		const batch = {
			name: "batch",
			description: "batch",
			parameters: createCuaBatchSchema(defaultActionsForMode("browser"), "browser"),
		};
		expect(batch.parameters.$defs).toBeDefined();
		expect(() =>
			validateToolArguments(batch, {
				id: "call_1",
				name: "batch",
				arguments: {
					actions: [{ type: "browser_act", steps: [{ type: "wait", ms: 0, expect: { type: "url", changed: true } }] }],
				},
			}),
		).not.toThrow();
	});

	it("rejects semantic leaves without a predicate", () => {
		const act = computerTools({ mode: "browser" }).find((tool) => tool.name === "act")!;
		for (const predicate of [
			{ type: "role_name" },
			{ type: "ref", ref: "e1" },
			{ type: "url" },
			{ type: "title" },
		]) {
			expect(() =>
				validateToolArguments(act, {
					id: "call_1",
					name: "act",
					arguments: { steps: [{ type: "wait", ms: 0, expect: predicate }] },
				}),
			).toThrow(/Validation failed/);
		}
		expect(() =>
			validateToolArguments(act, {
				id: "call_2",
				name: "act",
				arguments: { steps: [{ type: "wait", ms: 0, expect: { type: "url", changed: true } }] },
			}),
		).not.toThrow();
	});

	it("browser mode exposes every default browser action under its unprefixed name", () => {
		const tools = computerTools({ mode: "browser" });
		const names = tools.map((tool) => tool.name);
		for (const action of CUA_BROWSER_ACTION_TYPES) {
			expect(names).toContain(action.slice("browser_".length));
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
