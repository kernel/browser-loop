import { describe, expect, it, vi } from "vitest";
import { type AgentTool, GOOGLE_INTERACTIONS_API } from "../src/pi/index";
import {
	callerToolIdentity,
	type KernelBrowser,
	loop,
	type LoopAgentTool,
	LoopExecutionResources,
} from "../src/index";
import type Kernel from "@onkernel/sdk";
import { LoopToolManager } from "../src/pi/tool-manager";

const browser = { session_id: "browser_123", viewport: { width: 1440, height: 900 } } as KernelBrowser;
const client = {} as Kernel;

function setup() {
	return new LoopExecutionResources({ browser, client });
}

function callerTool(name: string, execute?: AgentTool["execute"], executionMode?: AgentTool["executionMode"]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: { type: "object", properties: {}, additionalProperties: false } as never,
		...(executionMode ? { executionMode } : {}),
		execute: execute ?? (async () => ({ content: [{ type: "text", text: "ok" }], details: {} })),
	};
}

describe("LoopToolManager declaration projection", () => {
	it("projects caller AgentTools into fresh declaration-only compile inputs", () => {
		const tool = callerTool("lookup");
		const manager = new LoopToolManager(setup(), "openai:gpt-5.5", [tool]);
		const [declaration] = manager.catalog.toolDeclarations;
		expect(declaration).toEqual({ name: "lookup", description: "lookup tool", parameters: tool.parameters });
		expect(declaration).not.toBe(tool);
		expect(manager.catalog.entries[0]?.declaration).toBe(declaration);
		for (const member of ["execute", "label", "prepareArguments", "executionMode"]) {
			expect(declaration).not.toHaveProperty(member);
		}
		for (const entry of manager.catalog.entries) {
			expect(entry).not.toHaveProperty("requested");
			expect(entry).not.toHaveProperty("agentTool");
			expect(entry).not.toHaveProperty("spec");
			expect(entry).not.toHaveProperty("executorFingerprint");
		}
		expect("requested" in manager.catalog).toBe(false);
		expect("agentTools" in manager.catalog).toBe(false);
	});

});

describe("LoopToolManager identity join", () => {
	it("joins specs and caller tools strictly by identity across mixed ordering", async () => {
		const calls: string[] = [];
		const snapshot = loop.tools.browser.snapshot();
		const renamedClick = loop.tools.browser.click({ name: "page_click" });
		const alpha = callerTool("alpha", async () => {
			calls.push("alpha");
			return { content: [{ type: "text", text: "alpha" }], details: {} };
		});
		const zeta = callerTool("zeta", async () => {
			calls.push("zeta");
			return { content: [{ type: "text", text: "zeta" }], details: {} };
		});
		const manager = new LoopToolManager(setup(), "openai:gpt-5.5", [zeta, renamedClick, alpha, snapshot]);

		expect(manager.catalog.entries.map((entry) => entry.identity)).toEqual([
			callerToolIdentity("zeta"),
			"kloop.browser.click.v1",
			callerToolIdentity("alpha"),
			"kloop.browser.snapshot.v1",
		]);
		const installed = manager.agentTools();
		expect(installed.map((tool) => tool.name)).toEqual(["zeta", "page_click", "alpha", "browser_snapshot"]);

		// The original caller executors are retained across the join, and the
		// renamed spec was materialized under its model-facing alias.
		await installed[2]!.execute("call-1", {});
		expect(calls).toEqual(["alpha"]);
		await installed[0]!.execute("call-2", {});
		expect(calls).toEqual(["alpha", "zeta"]);
		expect(manager.specFor("kloop.browser.click.v1")).toBe(renamedClick);
		expect(manager.specFor(callerToolIdentity("alpha"))).toBeUndefined();
	});
});

describe("LoopToolManager transport derivation", () => {
	it("derives the compiled model's api from the tools selected with it", () => {
		const resources = setup();
		const cdp = new LoopToolManager(resources, "google:gemini-3.6-flash", [loop.tools.browser.snapshot()]);
		const native = new LoopToolManager(resources, "google:gemini-3.6-flash", loop.providers.google.toolsets.browser());

		expect(cdp.catalog.model.api).toBe("google-generative-ai");
		expect(native.catalog.model.api).toBe(GOOGLE_INTERACTIONS_API);
	});
});

describe("LoopToolManager materialization", () => {
	it("materializes each spec exactly once, however many pairs it is compiled into", () => {
		const resources = setup();
		const spy = vi.spyOn(resources, "materialize");
		const spec = loop.tools.browser.snapshot();

		new LoopToolManager<LoopAgentTool>(resources, "openai:gpt-5.5", [spec]);
		new LoopToolManager<LoopAgentTool>(resources, "openai:gpt-5.6-sol", [spec]);
		new LoopToolManager<LoopAgentTool>(resources, "openai:gpt-5.6-sol", [spec, callerTool("added")]);

		// The executable is cached per pool and per spec object, so pi sees one
		// stable implementation across every recompile.
		expect(spy.mock.calls.length).toBeGreaterThan(1);
		expect(new Set(spy.mock.results.map((result) => result.value)).size).toBe(1);
	});

	it("adapts a materialized spec to one stable pi AgentTool across recompiles", () => {
		const resources = setup();
		const spec = loop.tools.browser.snapshot();

		const [first] = new LoopToolManager<LoopAgentTool>(resources, "openai:gpt-5.5", [spec]).agentTools();
		const [second] = new LoopToolManager<LoopAgentTool>(resources, "openai:gpt-5.6-sol", [spec]).agentTools();

		expect(first).toBe(second);
		expect(first).toMatchObject({
			name: spec.name,
			label: spec.name,
			description: spec.declaration.description,
			parameters: spec.declaration.parameters,
			executionMode: "sequential",
		});
	});
});
