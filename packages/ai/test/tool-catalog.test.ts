import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	compileCuaToolCatalog,
	cua,
	getCuaModel,
	type CuaToolCatalogResources,
	type CuaToolSpec,
} from "../src/index";

const resources: CuaToolCatalogResources = {
	viewport: { width: 1440, height: 900 },
	materialize(spec: CuaToolSpec): AgentTool {
		return {
			...spec.declaration,
			label: spec.name,
			executionMode: "sequential",
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
	},
	async osScreenshot() {
		return { data: Buffer.from("image"), mimeType: "image/webp" };
	},
};

function compile(model: Parameters<typeof compileCuaToolCatalog>[0]["model"], requestedTools: Parameters<typeof compileCuaToolCatalog>[0]["requestedTools"]) {
	return compileCuaToolCatalog({ model, requestedTools, resources });
}

function callerTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: "caller",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
}

interface TestSchema {
	additionalProperties?: boolean;
	anyOf?: TestSchema[];
	const?: unknown;
	items?: TestSchema;
	properties?: Record<string, TestSchema>;
	required?: string[];
}

function anthropicRequiredFields(spec: CuaToolSpec, batch: boolean): Record<string, string[]> {
	const parameters = spec.declaration.parameters as TestSchema;
	const actionSchema = batch ? parameters.properties?.actions?.items : parameters;
	if (!actionSchema) throw new Error(`missing action schema for ${spec.name}`);
	const variants = actionSchema.anyOf ?? [actionSchema];
	return Object.fromEntries(variants.map((variant) => {
		expect(variant.additionalProperties).toBe(false);
		const action = variant.properties?.action?.const;
		if (typeof action !== "string") throw new Error(`missing action discriminator for ${spec.name}`);
		return [action, variant.required ?? []];
	}));
}

describe("cua tool namespace", () => {
	it("is frozen and exposes exact CUA toolset members", () => {
		expect(Object.isFrozen(cua)).toBe(true);
		expect(cua.toolsets.browser().map((tool) => tool.name)).toEqual([
			"browser_snapshot", "browser_text", "browser_find", "browser_click", "browser_hover", "browser_drag",
			"browser_fill", "browser_scroll_to", "browser_scroll", "browser_type", "browser_key", "browser_navigate",
			"browser_list_tabs", "browser_new_tab", "browser_screenshot", "browser_evaluate", "browser_wait_for",
		]);
		expect(cua.toolsets.computer().map((tool) => tool.name)).toEqual([
			"computer_click", "computer_double_click", "computer_mouse_down", "computer_mouse_up", "computer_type",
			"computer_keypress", "computer_scroll", "computer_move", "computer_drag", "computer_wait",
			"computer_screenshot", "computer_goto", "computer_back", "computer_forward", "computer_url",
			"computer_cursor_position",
		]);
		expect(cua.toolsets.mixed().map((tool) => tool.name)).toEqual([
			...cua.toolsets.computer().map((tool) => tool.name),
			...cua.toolsets.browser().map((tool) => tool.name),
		]);
	});

	it("applies deterministic namespaces without changing identity", () => {
		const [plain] = cua.toolsets.browser();
		const [namespaced] = cua.toolsets.browser({ namespace: "page" });
		expect(namespaced.name).toBe("page_browser_snapshot");
		expect(namespaced.identity).toBe(plain.identity);
	});

	it("requires explicit non-empty batch action lists", () => {
		expect(() => cua.tools.computer.batch({ actions: [] })).toThrow(/non-empty/);
		expect(() => cua.tools.browser.batch({ actions: [] })).toThrow(/non-empty/);
		expect(cua.tools.computer.batch({ actions: ["click", "screenshot"] }).declaration.parameters).toMatchObject({
			type: "object",
		});
		const browserBatch = cua.tools.browser.batch({ actions: ["snapshot", "click", "wait_for", "text"] });
		expect(browserBatch.name).toBe("browser_batch");
		expect(JSON.stringify(browserBatch.declaration.parameters)).not.toMatch(/saveAs|\$ref|workflow|branch/i);
	});

	it("exposes Google's exact current and legacy predefined browser action sets", () => {
		expect(cua.providers.google.toolsets.browser().map((tool) => tool.name)).toEqual([
			"click", "double_click", "triple_click", "middle_click", "right_click", "mouse_down", "mouse_up", "move",
			"type", "drag_and_drop", "wait", "press_key", "key_down", "key_up", "hotkey", "take_screenshot",
			"scroll", "go_back", "navigate", "go_forward",
		]);
		const legacy = cua.providers.google.toolsets.legacyBrowser();
		expect(legacy.map((tool) => tool.name)).toEqual([
			"open_web_browser", "wait_5_seconds", "go_back", "go_forward", "search", "navigate", "click_at",
			"hover_at", "type_text_at", "key_combination", "scroll_document", "scroll_at", "drag_and_drop",
		]);
		const legacyType = legacy.find((tool) => tool.name === "type_text_at")!;
		if (legacyType.execution.kind !== "actions") throw new Error("expected Google action tool");
		expect(legacyType.execution.toActions({ x: 10, y: 20, text: "hello" }).map((action) => action.type)).toEqual([
			"click", "keypress", "type", "keypress",
		]);
	});

	it("gives every Anthropic recommended computer action its full required fields", () => {
		const [single, batch] = cua.providers.anthropic.toolsets.computer();
		const expected = {
			screenshot: ["action"],
			left_click: ["action", "coordinate"],
			right_click: ["action", "coordinate"],
			middle_click: ["action", "coordinate"],
			double_click: ["action", "coordinate"],
			triple_click: ["action", "coordinate"],
			left_click_drag: ["action", "start_coordinate", "coordinate"],
			mouse_move: ["action", "coordinate"],
			left_mouse_down: ["action"],
			left_mouse_up: ["action"],
			scroll: ["action", "coordinate", "scroll_direction"],
			type: ["action", "text"],
			key: ["action", "text"],
			hold_key: ["action", "text", "duration"],
			wait: ["action", "duration"],
			cursor_position: ["action"],
			zoom: ["action", "region"],
		};
		expect(anthropicRequiredFields(single!, false)).toEqual(expected);
		expect(anthropicRequiredFields(batch!, true)).toEqual(expected);
	});

	it("gives every Anthropic recommended browser action its full required fields", () => {
		const [single, batch] = cua.providers.anthropic.toolsets.browser();
		const expected = {
			navigate: ["action", "url"],
			list_tabs: ["action"],
			new_tab: ["action"],
			read_page: ["action"],
			get_page_text: ["action"],
			find: ["action", "query"],
			form_input: ["action", "target", "value"],
			scroll_to: ["action", "target"],
			screenshot: ["action"],
			zoom: ["action", "region"],
			left_click: ["action", "target"],
			right_click: ["action", "target"],
			double_click: ["action", "target"],
			triple_click: ["action", "target"],
			hover: ["action", "target"],
			left_click_drag: ["action", "from", "target"],
			scroll: ["action", "target", "scroll_direction"],
			type: ["action", "text"],
			key: ["action", "text"],
			wait: ["action", "duration"],
			javascript_exec: ["action", "text"],
		};
		expect(anthropicRequiredFields(single!, false)).toEqual(expected);
		expect(anthropicRequiredFields(batch!, true)).toEqual(expected);
	});

	it("uses the same CUA-authored browser toolset with custom-function providers", () => {
		for (const model of ["meta:muse-spark-1.1", "xai:grok-4.5", "moonshotai:kimi-k3"] as const) {
			const catalog = compile(model, cua.toolsets.browser());
			expect(catalog.entries[0]).toMatchObject({
				identity: "cua.browser.snapshot.v1",
				name: "browser_snapshot",
				origin: "cua",
			});
			expect(catalog.entries.at(-1)?.name).toBe("browser_wait_for");
		}
	});
});

describe("compileCuaToolCatalog", () => {
	it("accepts an exact empty catalog", () => {
		const catalog = compile("openai:gpt-5.5", []);
		expect(catalog.requested).toEqual([]);
		expect(catalog.entries).toEqual([]);
		expect(catalog.agentTools).toEqual([]);
	});

	it("preserves exact requested order and inspectable identities", () => {
		const custom = callerTool("customer_lookup");
		const catalog = compile("anthropic:claude-opus-5", [cua.tools.browser.snapshot(), custom]);
		expect(catalog.entries.map((entry) => [entry.identity, entry.name, entry.origin])).toEqual([
			["cua.browser.snapshot.v1", "browser_snapshot", "cua"],
			["caller.customer_lookup", "customer_lookup", "caller"],
		]);
		expect(catalog.agentTools.map((tool) => tool.name)).toEqual(["browser_snapshot", "customer_lookup"]);
	});

	it("rejects duplicate identities and exact name collisions", () => {
		expect(() => compile("openai:gpt-5.5", [
			cua.tools.browser.snapshot(),
			cua.tools.browser.snapshot({ name: "page_snapshot" }),
		])).toThrow(/identity "cua\.browser\.snapshot\.v1"/);
		expect(() => compile("openai:gpt-5.5", [
			cua.tools.browser.act(),
			callerTool("browser_act"),
		])).toThrow('tool name "browser_act" is requested by both "cua.browser.act.v1" and "caller.browser_act"');
	});

	it("rejects Anthropic OAuth-normalized name collisions case-insensitively", () => {
		expect(() => compile("anthropic:claude-opus-5", [callerTool("Read"), callerTool("read")])).toThrow(/after anthropic name normalization/);
	});

	it("rejects unsafe names and incompatible native tools", () => {
		expect(() => compile("openai:gpt-5.5", [callerTool("bad name")])).toThrow(/must match/);
		expect(() => compile("openai:gpt-5.5", [cua.providers.anthropic.tools.computer()])).toThrow(/requires a anthropic model/);
	});

	it("replaces only the selected Tzafon identity placeholder", async () => {
		const catalog = compile("tzafon:tzafon.northstar-cua-fast", [
			cua.providers.tzafon.tools.computer(),
			callerTool("click"),
			cua.tools.browser.click(),
		]);
		const payload = {
			tools: [
				{ type: "function", name: "computer" },
				{ type: "function", name: "click" },
				{ type: "function", name: "browser_click" },
			],
		};
		const next = await catalog.payload.apply(payload, catalog.model) as { tools: Array<Record<string, unknown>> };
		expect(next.tools).toEqual([
			{ type: "computer_use", display_width: 1440, display_height: 900, environment: "browser" },
			{ type: "function", name: "click" },
			{ type: "function", name: "browser_click" },
		]);
		expect(catalog.incoming.tzafonComputerName).toBe("computer");
	});

	it("composes Anthropic native browser declarations, access fallback, and ordinary functions", async () => {
		const catalog = compile("anthropic:claude-opus-5", [
			cua.providers.anthropic.tools.browser(),
			cua.tools.browser.snapshot(),
		]);
		expect(catalog.headers.merge({ "anthropic-beta": "other-beta" })).toEqual({
			"anthropic-beta": "other-beta,browser-use-2026-07-01",
		});
		const next = await catalog.payload.apply({ tools: [
			{ name: "browser", input_schema: {} },
			{ name: "browser_snapshot", input_schema: {} },
		] }, catalog.model) as { tools: Array<Record<string, unknown>> };
		expect(next.tools[0]).toMatchObject({ type: "browser_20260701", name: "browser" });
		expect(next.tools[1]).toMatchObject({ name: "browser_snapshot" });
		expect(catalog.incoming.anthropicBrowserFallback).toMatchObject({
			beta: "browser-use-2026-07-01",
			nativeType: "browser_20260701",
			declaration: { name: "browser", input_schema: { anyOf: expect.any(Array) } },
		});
		expect(catalog.entries[0]?.dynamicLoading).toBe("eager-only");
	});

	it("serializes Google's current native declaration and rejects generation/model mismatches", async () => {
		const selected = cua.providers.google.toolsets.browser({ exclude: ["right_click", "triple_click"] });
		const catalog = compile("google:gemini-3-flash-preview", selected);
		const next = await catalog.payload.apply({ tools: selected.map((tool) => ({ type: "function", name: tool.name })) }, catalog.model) as { tools: unknown[] };
		expect(next.tools).toEqual([{
			type: "computer_use",
			environment: "browser",
			excluded_predefined_functions: [
				"triple_click", "right_click", "open_web_browser", "wait_5_seconds", "search", "click_at",
				"hover_at", "type_text_at", "key_combination", "scroll_document", "scroll_at",
			],
		}]);
		expect(catalog.entries[0]?.declaration).toEqual(next.tools[0]);
		expect(catalog.entries[0]?.coordinates).toEqual({ type: "normalized", range: [0, 999] });
		expect(() => compile("google:gemini-3-flash-preview", cua.providers.google.toolsets.legacyBrowser())).toThrow(/requires a Gemini 2\.5/);
		const click = selected.find((tool) => tool.name === "click")!;
		if (click.execution.kind !== "actions") throw new Error("expected Google action tool");
		expect(() => click.execution.toActions({ x: 1, y: 2, safety_decision: { decision: "require_confirmation" } })).toThrow(/was not executed/);
	});

	it("excludes every other live Google predefined function from a take_screenshot-only catalog", async () => {
		const current = cua.providers.google.toolsets.browser();
		const legacy = cua.providers.google.toolsets.legacyBrowser();
		const screenshot = current.find((tool) => tool.name === "take_screenshot")!;
		const allPublishedNames = [...new Set([...current, ...legacy].map((tool) => tool.name))];
		const expectedExcludedNames = allPublishedNames.filter((name) => name !== screenshot.name);
		const catalog = compile("google:gemini-3-flash-preview", [screenshot]);
		const next = await catalog.payload.apply({
			tools: [{ type: "function", name: screenshot.name }],
		}, catalog.model) as { tools: Array<{ excluded_predefined_functions: string[] }> };

		expect(next.tools).toEqual([{
			type: "computer_use",
			environment: "browser",
			excluded_predefined_functions: expectedExcludedNames,
		}]);
		expect(next.tools[0]!.excluded_predefined_functions).toContain("open_web_browser");
		expect(next.tools[0]!.excluded_predefined_functions).not.toContain("take_screenshot");
		expect(catalog.incoming.googleNames).toEqual({ take_screenshot: "take_screenshot" });
		expect(catalog.incoming.googleExcludedNames).toEqual(expectedExcludedNames);
	});

	it("serializes state-mutating Meta/xAI/Moonshot catalogs with serial tool calls", async () => {
		for (const model of ["meta:muse-spark-1.1", "xai:grok-4.5", "moonshotai:kimi-k3"] as const) {
			const catalog = compile(model, cua.toolsets.browser());
			await expect(catalog.payload.apply({ parallel_tool_calls: true }, catalog.model)).resolves.toMatchObject({ parallel_tool_calls: false });
		}
	});

	it("uses selected Yutori identities for disable_tools and keeps custom functions", async () => {
		const selected = cua.providers.yutori.toolsets.n15Core().slice(0, 2);
		const catalog = compile("yutori:n1.5-latest", [...selected, callerTool("custom")]);
		const payload = { messages: [{ role: "user", content: "go" }], tools: [
			...selected.map((tool) => ({ type: "function", function: { name: tool.name } })),
			{ type: "function", function: { name: "custom" } },
		] };
		const next = await catalog.payload.apply(payload, catalog.model) as {
			tool_set: string;
			disable_tools: string[];
			tools: Array<{ function: { name: string } }>;
			messages: Array<{ content: unknown[] }>;
		};
		expect(next.tool_set).toBe("browser_tools_core-20260403");
		expect(next.disable_tools).not.toContain(selected[0]?.name);
		expect(next.disable_tools).toContain("right_click");
		expect(next.tools.map((tool) => tool.function.name)).toEqual(["custom"]);
		expect(next.messages[0]?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url" })]));
	});

	it("rejects partial n1 selection and incompatible model changes", () => {
		expect(() => compile("yutori:n1-latest", cua.providers.yutori.toolsets.n1().slice(0, 1))).toThrow(/complete .*n1\(\)/);
		const requested = [cua.providers.anthropic.tools.browser()];
		expect(() => compile("openai:gpt-5.5", requested)).toThrow(/requires a anthropic model/);
	});

	it("fingerprints coordinate replacements independently from name and schema", () => {
		const pixels = compile("openai:gpt-5.5", [cua.tools.computer.click()]);
		const normalized = compile("openai:gpt-5.5", [cua.tools.computer.click({ coordinates: cua.coordinates.normalized([0, 1000]) })]);
		expect(pixels.entries[0]?.schemaFingerprint).toBe(normalized.entries[0]?.schemaFingerprint);
		expect(pixels.entries[0]?.fingerprint).not.toBe(normalized.entries[0]?.fingerprint);
	});

	it("fingerprints caller executor replacements independently from schema", () => {
		const first = compile("openai:gpt-5.5", [callerTool("custom")]);
		const second = compile("openai:gpt-5.5", [callerTool("custom")]);
		expect(first.entries[0]?.schemaFingerprint).toBe(second.entries[0]?.schemaFingerprint);
		expect(first.entries[0]?.fingerprint).not.toBe(second.entries[0]?.fingerprint);
	});
});
