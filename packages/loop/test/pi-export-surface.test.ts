import { describe, expect, it } from "vitest";
import * as pi from "../src/pi/index";

// ./pi exports only loop-owned symbols. pi-agent-core is composed with, not
// re-exported: consumers construct Agent/AgentHarness from their own
// pi-agent-core install.
describe("./pi export surface", () => {
	it("exports the loop pi binding", () => {
		for (const name of ["attach", "createLoopModels", "loopModels", "getLoopModel", "listLoopModels", "loopApiKeyEnvVarsForProvider"]) {
			expect(pi, name).toHaveProperty(name);
		}
	});

	it("does not re-export pi-agent-core", () => {
		const leaked = [
			"Agent",
			"AgentHarness",
			"InMemorySessionRepo",
			"NodeExecutionEnv",
			"createBashTool",
			"createEditTool",
			"createReadTool",
			"createWriteTool",
		].filter((name) => name in pi);
		expect(leaked).toEqual([]);
	});
});
