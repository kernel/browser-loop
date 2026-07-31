import { describe, expect, it, vi } from "vitest";
import { callerToolIdentity, cua } from "@onkernel/cua-ai";
import type Kernel from "@onkernel/sdk";
import {
	CuaExecutionResources,
	type AgentTool,
	type KernelBrowser,
} from "../src/index";
import { CuaToolManager } from "../src/tool-manager";

const browser = { session_id: "browser_123", viewport: { width: 1440, height: 900 } } as KernelBrowser;
const client = {} as Kernel;

function setup() {
	return new CuaExecutionResources({ browser, client });
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

describe("CuaToolManager declaration projection", () => {
	it("projects caller AgentTools into fresh declaration-only compile inputs", () => {
		const tool = callerTool("lookup");
		const manager = new CuaToolManager(setup(), "openai:gpt-5.5", [tool]);
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

	it("keeps the caller list as the sole owner of requested objects", () => {
		const spec = cua.tools.browser.snapshot();
		const tool = callerTool("lookup");
		const manager = new CuaToolManager(setup(), "openai:gpt-5.5", [spec, tool]);
		expect(manager.getTools()[0]).toBe(spec);
		expect(manager.getTools()[1]).toBe(tool);
	});
});

describe("CuaToolManager identity join", () => {
	it("joins specs and caller tools strictly by identity across mixed ordering", async () => {
		const calls: string[] = [];
		const snapshot = cua.tools.browser.snapshot();
		const renamedClick = cua.tools.browser.click({ name: "page_click" });
		const alpha = callerTool("alpha", async () => {
			calls.push("alpha");
			return { content: [{ type: "text", text: "alpha" }], details: {} };
		});
		const zeta = callerTool("zeta", async () => {
			calls.push("zeta");
			return { content: [{ type: "text", text: "zeta" }], details: {} };
		});
		const manager = new CuaToolManager(setup(), "openai:gpt-5.5", [zeta, renamedClick, alpha, snapshot]);

		expect(manager.catalog.entries.map((entry) => entry.identity)).toEqual([
			callerToolIdentity("zeta"),
			"cua.browser.click.v1",
			callerToolIdentity("alpha"),
			"cua.browser.snapshot.v1",
		]);
		const installed = manager.agentTools();
		expect(installed.map((tool) => tool.name)).toEqual(["zeta", "page_click", "alpha", "browser_snapshot"]);

		// The original caller executors are retained across the join, and the
		// renamed spec was materialized under its model-facing alias.
		await installed[2]!.execute("call-1", {});
		expect(calls).toEqual(["alpha"]);
		await installed[0]!.execute("call-2", {});
		expect(calls).toEqual(["alpha", "zeta"]);
		expect(manager.specFor("cua.browser.click.v1")).toBe(renamedClick);
		expect(manager.specFor(callerToolIdentity("alpha"))).toBeUndefined();
	});
});

describe("CuaToolManager implementation identity", () => {
	it("materializes each spec exactly once across model and tool recompilation", () => {
		const resources = setup();
		const spy = vi.spyOn(resources, "materialize");
		const spec = cua.tools.browser.snapshot();
		const manager = new CuaToolManager(resources, "openai:gpt-5.5", [spec]);

		manager.commit(manager.prepareModel("openai:gpt-5.6-sol"));
		manager.commit(manager.prepareTools([...manager.getTools(), callerTool("added")]));

		// Every materialization for the same spec object returned one identical executable.
		expect(spy.mock.calls.length).toBeGreaterThan(1);
		expect(new Set(spy.mock.results.map((result) => result.value)).size).toBe(1);
	});

	it("keeps the same spec object stable across model recompilation", () => {
		const manager = new CuaToolManager(setup(), "openai:gpt-5.5", [cua.tools.browser.snapshot()]);
		const first = manager.prepareModel("openai:gpt-5.6-sol");
		const second = manager.prepareModel("openai:gpt-5.6-sol");
		expect(second.fingerprints).toEqual(first.fingerprints);
	});

	it("treats a freshly created spec object as a conservative replacement", () => {
		const manager = new CuaToolManager(setup(), "openai:gpt-5.5", [cua.tools.browser.snapshot()]);
		const stable = manager.prepareModel("openai:gpt-5.6-sol");
		const replaced = manager.prepareTools([cua.tools.browser.snapshot()]);
		expect(replaced.catalog.entries[0]?.fingerprint).toBe(stable.catalog.entries[0]?.fingerprint);
		expect(replaced.fingerprints[0]).not.toBe(stable.fingerprints[0]);
	});

	it("retains implementation identity for a new wrapper reusing the same execute function", () => {
		const sharedExecute: AgentTool["execute"] = async () => ({ content: [{ type: "text", text: "ok" }], details: {} });
		const original = callerTool("worker", sharedExecute);
		const manager = new CuaToolManager(setup(), "openai:gpt-5.5", [original]);
		const baseline = manager.prepareModel("openai:gpt-5.6-sol");

		const rewrapped = { ...original };
		expect(rewrapped).not.toBe(original);
		expect(manager.prepareTools([rewrapped]).fingerprints).toEqual(baseline.fingerprints);

		const freshExecute = manager.prepareTools([callerTool("worker")]);
		expect(freshExecute.catalog.entries[0]?.fingerprint).toBe(baseline.catalog.entries[0]?.fingerprint);
		expect(freshExecute.fingerprints[0]).not.toBe(baseline.fingerprints[0]);
	});
});
