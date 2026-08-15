import { type Tool, Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { getLoopModel, GOOGLE_INTERACTIONS_API, OPENAI_COMPUTER_USE_API } from "../src/pi/index";
import { callerToolIdentity, compileLoopToolCatalog, loop, type LoopToolSpec } from "../src/index";

function compile(model: Parameters<typeof compileLoopToolCatalog>[0]["model"], requestedTools: Parameters<typeof compileLoopToolCatalog>[0]["requestedTools"]) {
	return compileLoopToolCatalog({ model, requestedTools });
}

/** Sanitized caller declaration: the compiler never receives executable members. */
function callerTool(name: string): Tool {
	return {
		name,
		description: "caller",
		parameters: Type.Object({}),
	};
}

describe("loop tool namespace", () => {
	it("is frozen and exposes exact Loop toolset members", () => {
		expect(Object.isFrozen(loop)).toBe(true);
		expect(loop.toolsets.browser().map((tool) => tool.name)).toEqual([
			"browser_snapshot", "browser_text", "browser_find", "browser_click", "browser_hover", "browser_drag",
			"browser_fill", "browser_scroll_to", "browser_scroll", "browser_type", "browser_key", "browser_navigate",
			"browser_list_tabs", "browser_new_tab", "browser_screenshot", "browser_evaluate", "browser_wait_for",
		]);
		expect(loop.toolsets.computer().map((tool) => tool.name)).toEqual([
			"computer_click", "computer_double_click", "computer_mouse_down", "computer_mouse_up", "computer_type",
			"computer_keypress", "computer_scroll", "computer_move", "computer_drag", "computer_wait",
			"computer_screenshot", "computer_goto", "computer_back", "computer_forward", "computer_url",
			"computer_cursor_position",
		]);
		expect(loop.toolsets.mixed().map((tool) => tool.name)).toEqual([
			...loop.toolsets.computer().map((tool) => tool.name),
			...loop.toolsets.browser().map((tool) => tool.name),
		]);
	});

	it("applies deterministic namespaces without changing identity", () => {
		const [plain] = loop.toolsets.browser();
		const [namespaced] = loop.toolsets.browser({ namespace: "page" });
		expect(namespaced.name).toBe("page_browser_snapshot");
		expect(namespaced.identity).toBe(plain.identity);
	});

	it("requires explicit non-empty batch action lists", () => {
		expect(() => loop.tools.computer.batch({ actions: [] })).toThrow(/non-empty/);
		expect(() => loop.tools.browser.batch({ actions: [] })).toThrow(/non-empty/);
		expect(loop.tools.computer.batch({ actions: ["click", "screenshot"] }).declaration.parameters).toMatchObject({
			type: "object",
		});
		const browserBatch = loop.tools.browser.batch({ actions: ["snapshot", "click", "wait_for", "text"] });
		expect(browserBatch.name).toBe("browser_batch");
		expect(JSON.stringify(browserBatch.declaration.parameters)).not.toMatch(/saveAs|\$ref|workflow|branch/i);
	});

	it("exposes Google's exact current predefined browser action set", () => {
		expect(loop.providers.google.toolsets.browser().map((tool) => tool.name)).toEqual([
			"click", "double_click", "triple_click", "middle_click", "right_click", "mouse_down", "mouse_up", "move",
			"type", "drag_and_drop", "wait", "press_key", "key_down", "key_up", "hotkey", "take_screenshot",
			"scroll", "go_back", "navigate", "go_forward",
		]);
	});

	it("cites first-party documentation for every provider tool surface", () => {
		expect("toolsets" in loop.providers.anthropic).toBe(false);
		expect("legacyBrowser" in loop.providers.google.toolsets).toBe(false);
		const surfaces: Array<[string, LoopToolSpec[]]> = [
			[loop.providers.openai.source, [loop.providers.openai.tools.computer()]],
			[loop.providers.anthropic.source, [
				loop.providers.anthropic.tools.browser(),
				loop.providers.anthropic.tools.computer(),
			]],
			[loop.providers.google.source, loop.providers.google.toolsets.browser()],
		];
		for (const [source, tools] of surfaces) {
			expect(source).toMatch(/^https:\/\//);
			expect(tools.length).toBeGreaterThan(0);
			expect(tools.every((tool) => tool.source === source)).toBe(true);
		}
	});

	it("uses the same Loop-authored browser toolset with custom-function providers", () => {
		for (const model of ["xai:grok-4.5", "moonshotai:kimi-k3", "openrouter:meta/muse-spark-1.1"] as const) {
			const catalog = compile(model, loop.toolsets.browser());
			expect(catalog.entries[0]).toMatchObject({
				identity: "kloop.browser.snapshot.v1",
				name: "browser_snapshot",
				origin: "loop",
			});
			expect(catalog.entries.at(-1)?.name).toBe("browser_wait_for");
		}
	});
});

describe("compileLoopToolCatalog", () => {
	it("accepts an exact empty catalog", () => {
		const catalog = compile("openai:gpt-5.5", []);
		expect(catalog.entries).toEqual([]);
		expect(catalog.toolDeclarations).toEqual([]);
	});

	it("never exposes requested, executable, spec, or executor state", () => {
		const catalog = compile("openai:gpt-5.5", [loop.tools.browser.snapshot(), callerTool("custom")]);
		expect("requested" in catalog).toBe(false);
		expect("agentTools" in catalog).toBe(false);
		for (const entry of catalog.entries) {
			expect(entry).not.toHaveProperty("requested");
			expect(entry).not.toHaveProperty("agentTool");
			expect(entry).not.toHaveProperty("spec");
			expect(entry).not.toHaveProperty("executorFingerprint");
		}
		for (const declaration of catalog.toolDeclarations) {
			for (const member of ["execute", "label", "prepareArguments", "executionMode"]) {
				expect(declaration).not.toHaveProperty(member);
			}
		}
	});

	it("sanitizes even executable-shaped caller inputs into fresh declarations", () => {
		const executable = {
			name: "custom",
			label: "custom",
			description: "caller",
			parameters: Type.Object({}),
			executionMode: "sequential",
			async execute() {
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		};
		const catalog = compile("openai:gpt-5.5", [executable]);
		const [declaration] = catalog.toolDeclarations;
		expect(declaration).toEqual({ name: "custom", description: "caller", parameters: Type.Object({}) });
		expect(declaration).not.toBe(executable);
		expect(catalog.entries[0]?.declaration).toBe(declaration);
		expect(catalog.entries[0]?.declaration).not.toBe(executable);
	});

	it("preserves exact requested order and inspectable identities", () => {
		const custom = callerTool("customer_lookup");
		const catalog = compile("anthropic:claude-opus-5", [loop.tools.browser.snapshot(), custom]);
		expect(catalog.entries.map((entry) => [entry.identity, entry.name, entry.origin])).toEqual([
			["kloop.browser.snapshot.v1", "browser_snapshot", "loop"],
			["caller.customer_lookup", "customer_lookup", "caller"],
		]);
		expect(catalog.toolDeclarations.map((tool) => tool.name)).toEqual(["browser_snapshot", "customer_lookup"]);
	});

	it("exposes one canonical caller-tool identity scheme", () => {
		expect(callerToolIdentity("customer_lookup")).toBe("caller.customer_lookup");
		const catalog = compile("openai:gpt-5.5", [callerTool("customer_lookup")]);
		expect(catalog.entries[0]?.identity).toBe(callerToolIdentity("customer_lookup"));
	});

	it("rejects duplicate identities and exact name collisions", () => {
		expect(() => compile("openai:gpt-5.5", [
			loop.tools.browser.snapshot(),
			loop.tools.browser.snapshot({ name: "page_snapshot" }),
		])).toThrow(/identity "kloop\.browser\.snapshot\.v1"/);
		expect(() => compile("openai:gpt-5.5", [
			loop.tools.browser.act(),
			callerTool("browser_act"),
		])).toThrow('tool name "browser_act" is requested by both "kloop.browser.act.v1" and "caller.browser_act"');
	});

	it("rejects Anthropic OAuth-normalized name collisions case-insensitively", () => {
		expect(() => compile("anthropic:claude-opus-5", [callerTool("Read"), callerTool("read")])).toThrow(/after anthropic name normalization/);
	});

	it("rejects browser_act on Moonshot while keeping the complex wait_for schema", () => {
		// Moonshot's API accepts browser_wait_for (~15KB) but rejects the request
		// outright once browser_act's (~124KB) schema is attached, so the oversized
		// schema is gated separately from merely-complex ones.
		expect(() => compile("moonshotai:kimi-k3", [loop.tools.browser.act()]))
			.toThrow('provider moonshotai does not accept the schema size of "browser_act" (kloop.browser.act.v1)');
		expect(() => compile("moonshotai:kimi-k3", [loop.tools.browser.waitFor()])).not.toThrow();
		expect(() => compile("moonshotai:kimi-k3", loop.toolsets.browser())).not.toThrow();
	});

	it("still accepts browser_act on providers that take its schema size", () => {
		for (const model of ["openai:gpt-5.5", "anthropic:claude-opus-5", "xai:grok-4.5", "openrouter:meta/muse-spark-1.1"] as const) {
			expect(() => compile(model, [loop.tools.browser.act()]), model).not.toThrow();
		}
	});

	it("rejects unsafe names and incompatible native tools", () => {
		expect(() => compile("openai:gpt-5.5", [callerTool("bad name")])).toThrow(/must match/);
		expect(() => compile("openai:gpt-5.5", [loop.providers.anthropic.tools.computer()])).toThrow(/requires a anthropic model/);
	});

	it("gates OpenAI and Google native surfaces on the model, not just the provider", () => {
		expect(() => compile("openai:gpt-5.5", [loop.providers.openai.tools.computer()])).not.toThrow();
		expect(() => compile("google:gemini-3.6-flash", loop.providers.google.toolsets.browser())).not.toThrow();
		// Both providers answer 400 for a model the surface is not enabled for.
		expect(() => compile("openai:gpt-4.1", [loop.providers.openai.tools.computer()]))
			.toThrow(/does not offer a native computer surface/);
		expect(() => compile("google:gemini-2.5-flash", loop.providers.google.toolsets.browser()))
			.toThrow(/does not offer a native browser surface/);
	});

	it("replaces only the selected OpenAI identity placeholder", async () => {
		const catalog = compile("openai:gpt-5.5", [
			loop.providers.openai.tools.computer(),
			callerTool("click"),
			loop.tools.browser.click(),
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
			{ type: "computer" },
			{ type: "function", name: "click" },
			{ type: "function", name: "browser_click" },
		]);
		expect(catalog.incoming.openaiComputerName).toBe("computer");
	});

	it("composes Anthropic native browser declarations, access fallback, and ordinary functions", async () => {
		const catalog = compile("anthropic:claude-opus-5", [
			loop.providers.anthropic.tools.browser(),
			loop.tools.browser.snapshot(),
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

	it("serializes Google's current native declaration and keeps custom functions", async () => {
		const selected = loop.providers.google.toolsets.browser({ exclude: ["right_click", "triple_click"] });
		const catalog = compile("google:gemini-3.6-flash", [...selected, callerTool("custom")]);
		const next = await catalog.payload.apply({ tools: [
			...selected.map((tool) => ({ type: "function", name: tool.name })),
			{ type: "function", name: "custom" },
		] }, catalog.model) as { tools: unknown[] };
		expect(next.tools).toEqual([
			{
				type: "computer_use",
				environment: "browser",
				excluded_predefined_functions: ["triple_click", "right_click"],
			},
			{ type: "function", name: "custom" },
		]);
		expect(catalog.entries[0]?.declaration).toEqual(next.tools[0]);
		expect(catalog.entries[0]?.coordinates).toEqual({ type: "normalized", range: [0, 999] });
		const click = selected.find((tool) => tool.name === "click")!;
		if (click.execution.kind !== "actions") throw new Error("expected Google action tool");
		expect(() => click.execution.toActions({ x: 1, y: 2, safety_decision: { decision: "require_confirmation" } })).toThrow(/was not executed/);
		const scroll = selected.find((tool) => tool.name === "scroll")!;
		if (scroll.execution.kind !== "actions") throw new Error("expected Google scroll tool");
		expect(scroll.execution.toActions({ x: 500, y: 500, direction: "up", magnitude_in_pixels: 250 })).toEqual([
			{ type: "scroll", x: 500, y: 500, scroll_x: 0, scroll_y: -250 },
		]);
	});

	it("excludes every other Google browser function from a take_screenshot-only catalog", async () => {
		const current = loop.providers.google.toolsets.browser();
		const screenshot = current.find((tool) => tool.name === "take_screenshot")!;
		const expectedExcludedNames = current.map((tool) => tool.name).filter((name) => name !== screenshot.name);
		const catalog = compile("google:gemini-3.6-flash", [screenshot]);
		const next = await catalog.payload.apply({
			tools: [{ type: "function", name: screenshot.name }],
		}, catalog.model) as { tools: Array<{ excluded_predefined_functions: string[] }> };

		expect(next.tools).toEqual([{
			type: "computer_use",
			environment: "browser",
			excluded_predefined_functions: expectedExcludedNames,
		}]);
		expect(next.tools[0]!.excluded_predefined_functions).toContain("click");
		expect(next.tools[0]!.excluded_predefined_functions).not.toContain("take_screenshot");
		expect(catalog.incoming.googleNames).toEqual({ take_screenshot: "take_screenshot" });
		expect(catalog.incoming.googleExcludedNames).toEqual(expectedExcludedNames);
	});

	it("rejects browser_act but accepts browser primitives for both Kimi transports", () => {
		for (const model of ["moonshotai:kimi-k3", "openrouter:moonshotai/kimi-k3"] as const) {
			expect(() => compile(model, [loop.tools.browser.act()])).toThrow(/schema size/);
			expect(() => compile(model, loop.toolsets.browser())).not.toThrow();
		}
	});

	it("serializes state-mutating catalogs with serial tool calls", async () => {
		for (const model of ["xai:grok-4.5", "moonshotai:kimi-k3", "openrouter:moonshotai/kimi-k3", "openrouter:meta/muse-spark-1.1"] as const) {
			const catalog = compile(model, loop.toolsets.browser());
			await expect(catalog.payload.apply({ parallel_tool_calls: true }, catalog.model)).resolves.toMatchObject({ parallel_tool_calls: false });
		}
	});

	it("rejects incompatible model changes", () => {
		const nativeTools: Array<[LoopToolSpec[], string]> = [
			[[loop.providers.anthropic.tools.browser()], "anthropic"],
			[[loop.providers.openai.tools.computer()], "openai"],
			[[loop.providers.google.toolsets.browser()[0]!], "google"],
		];
		for (const [tools, provider] of nativeTools) {
			expect(() => compile("openrouter:moonshotai/kimi-k3", tools)).toThrow(new RegExp(`requires a ${provider} model`));
		}
		const requested = [loop.providers.anthropic.tools.browser()];
		expect(() => compile("openai:gpt-5.5", requested)).toThrow(/requires a anthropic model/);
	});

	it("fingerprints coordinate replacements independently from name and schema", () => {
		const pixels = compile("openai:gpt-5.5", [loop.tools.computer.click()]);
		const normalized = compile("openai:gpt-5.5", [loop.tools.computer.click({ coordinates: loop.coordinates.normalized([0, 1000]) })]);
		expect(pixels.entries[0]?.schemaFingerprint).toBe(normalized.entries[0]?.schemaFingerprint);
		expect(pixels.entries[0]?.fingerprint).not.toBe(normalized.entries[0]?.fingerprint);
	});

	it("produces deterministic fingerprints for identical declaration and model inputs", () => {
		const compileInputs = () => [loop.tools.browser.snapshot(), loop.tools.computer.click(), callerTool("custom")];
		const first = compile("openai:gpt-5.5", compileInputs());
		const second = compile("openai:gpt-5.5", compileInputs());
		expect(second.fingerprint).toBe(first.fingerprint);
		expect(second.entries.map((entry) => entry.fingerprint)).toEqual(first.entries.map((entry) => entry.fingerprint));
		expect(second.toolDeclarations.map((tool) => tool.name)).toEqual(first.toolDeclarations.map((tool) => tool.name));
	});
});

describe("transport derivation", () => {
	it("keeps an OpenAI model on its registry api when only Loop browser tools are selected", () => {
		const catalog = compile("openai:gpt-5.5", loop.toolsets.browser());
		expect(catalog.model.api).toBe("openai-responses");
	});

	it("derives OPENAI_COMPUTER_USE_API when OpenAI's native computer tool is selected", () => {
		const catalog = compile("openai:gpt-5.5", [loop.providers.openai.tools.computer()]);
		expect(catalog.model.api).toBe(OPENAI_COMPUTER_USE_API);
	});

	it("keeps a Google model on pi's builtin transport when only CDP browser tools are selected", () => {
		const catalog = compile("google:gemini-3.6-flash", [loop.tools.browser.snapshot(), loop.tools.browser.click()]);
		expect(catalog.model.api).toBe("google-generative-ai");
	});

	it("derives GOOGLE_INTERACTIONS_API when Google's native browser toolset is selected", () => {
		const catalog = compile("google:gemini-3.6-flash", loop.providers.google.toolsets.browser());
		expect(catalog.model.api).toBe(GOOGLE_INTERACTIONS_API);
	});

	it("rejects a catalog whose selected tools require conflicting transports", () => {
		const [click, scroll] = loop.providers.google.toolsets.browser();
		const conflicting: LoopToolSpec = {
			...scroll!,
			identity: "test.conflicting-transport.v1",
			providerBinding: { kind: "google-native", nativeName: "conflict", allNativeNames: ["conflict"], requiresApi: OPENAI_COMPUTER_USE_API },
		};
		expect(() => compile("google:gemini-3.6-flash", [click!, conflicting])).toThrow(/incompatible provider transports/);
	});

	it("re-derives from a model object that already carries a stale derived api, instead of pinning it", () => {
		const nativeCatalog = compile("google:gemini-3.6-flash", loop.providers.google.toolsets.browser());
		expect(nativeCatalog.model.api).toBe(GOOGLE_INTERACTIONS_API);

		const recompiled = compile(nativeCatalog.model, [loop.tools.browser.snapshot(), loop.tools.browser.click()]);
		expect(recompiled.model.api).toBe("google-generative-ai");

		const reselected = compile(recompiled.model, loop.providers.google.toolsets.browser());
		expect(reselected.model.api).toBe(GOOGLE_INTERACTIONS_API);
	});

	it("re-derives an OpenAI model object that already carries a stale derived api, instead of pinning it", () => {
		const nativeCatalog = compile("openai:gpt-5.5", [loop.providers.openai.tools.computer()]);
		expect(nativeCatalog.model.api).toBe(OPENAI_COMPUTER_USE_API);

		const recompiled = compile(nativeCatalog.model, loop.toolsets.browser());
		expect(recompiled.model.api).toBe("openai-responses");
	});

});
describe("Gemini function-declaration schema", () => {
	it("rewrites the two keywords the Gemini API rejects", async () => {
		const catalog = compileLoopToolCatalog({
			model: getLoopModel("google:gemini-3.6-flash"),
			requestedTools: [loop.tools.browser.waitFor()],
		});
		const raw = {
			tools: [
				{
					functionDeclarations: catalog.toolDeclarations.map((tool) => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					})),
				},
			],
		};
		const sent = JSON.stringify(await catalog.payload.apply(raw, catalog.model));

		// Verified live: the Gemini API answers 400 `Unknown name "const"` and the
		// same for additionalProperties, rather than ignoring what it does not know.
		expect(JSON.stringify(raw)).toContain('"const"');
		expect(sent).not.toContain('"const"');
		expect(sent).not.toContain('"additionalProperties"');
		// `const: x` becomes a single-value enum, which means the same thing.
		expect(sent).toContain('"enum":["text"]');
	});

	it("narrows the nested config.tools shape the Generative Language SDK builds", async () => {
		// pi-ai hands `@google/genai` params to onPayload, which carry the function
		// declarations under `config.tools` rather than at the top level.
		const catalog = compileLoopToolCatalog({
			model: getLoopModel("google:gemini-3.6-flash"),
			requestedTools: [loop.tools.browser.waitFor()],
		});
		const params = {
			model: "gemini-3.6-flash",
			config: { tools: [{ functionDeclarations: catalog.toolDeclarations.map((tool) => ({ name: tool.name, parameters: tool.parameters })) }] },
		};
		const sent = JSON.stringify(await catalog.payload.apply(params, catalog.model));
		expect(JSON.stringify(params)).toContain('"const"');
		expect(sent).not.toContain('"const"');
		expect(sent).not.toContain('"additionalProperties"');
		expect(sent).toContain('"enum":["text"]');
	});

	it("narrows the flat tool shape the Interactions transport emits", async () => {
		// Selecting a native surface alongside a function tool derives the Interactions
		// transport, which serializes tools flat instead of under functionDeclarations.
		const catalog = compileLoopToolCatalog({
			model: getLoopModel("google:gemini-3.6-flash"),
			requestedTools: [...loop.providers.google.toolsets.browser(), loop.tools.browser.waitFor()],
		});
		const flat = {
			tools: [{ type: "function", name: "browser_wait_for", parameters: loop.tools.browser.waitFor().declaration.parameters }],
		};
		const sent = JSON.stringify(await catalog.payload.apply(flat, catalog.model));
		expect(JSON.stringify(flat)).toContain('"const"');
		expect(sent).not.toContain('"const"');
		expect(sent).not.toContain('"additionalProperties"');
	});

	it("leaves other providers' declarations untouched", async () => {
		const catalog = compileLoopToolCatalog({
			model: getLoopModel("openai:gpt-5.6-sol"),
			requestedTools: [loop.tools.browser.waitFor()],
		});
		const raw = { tools: [{ functionDeclarations: [{ name: "browser_wait_for", parameters: catalog.toolDeclarations[0]!.parameters }] }] };
		const sent = JSON.stringify(await catalog.payload.apply(raw, catalog.model));
		expect(sent).toContain('"const"');
	});
});
