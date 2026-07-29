import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	compileCuaToolCatalog,
	type CuaModelRef,
	type CuaToolCatalogResources,
	type CuaToolSpec,
} from "@onkernel/cua-ai";
import { describe, expect, it } from "vitest";
import { toolsForModel } from "../examples/shared/tools";

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
};

/**
 * The example matrices are plain scripts: they are excluded from `tsc -b` and are
 * never executed in CI, so a provider policy that no longer compiles used to be
 * invisible until someone ran the script against a live key.
 *
 * Limited to models the registry can resolve, so Anthropic's older non-native
 * fallback branch is covered by the CLI's `defaultInteractionTools` test instead.
 */
const models: readonly CuaModelRef[] = [
	"openai:gpt-5.6-sol",
	"anthropic:claude-opus-5",
	"anthropic:claude-sonnet-5",
	"google:gemini-3.6-flash",
	"meta:muse-spark-1.1",
	"xai:grok-4.5",
	"moonshotai:kimi-k3",
	"tzafon:tzafon.northstar-cua-fast",
	"yutori:n1.5-latest",
];

describe("example provider matrix tool policy", () => {
	it("compiles a valid catalog for every model the matrices advertise", () => {
		for (const model of models) {
			expect(
				() => compileCuaToolCatalog({ model, requestedTools: toolsForModel(model), resources }),
				model,
			).not.toThrow();
		}
	});

	it("omits browser_act for Moonshot, whose API rejects its schema size", () => {
		const names = toolsForModel("moonshotai:kimi-k3").map((tool) => tool.name);
		expect(names).toContain("browser_snapshot");
		expect(names).toContain("browser_wait_for");
		expect(names).not.toContain("browser_act");
	});

	it("still advertises browser_act where the provider accepts it", () => {
		for (const model of ["openai:gpt-5.6-sol", "meta:muse-spark-1.1", "xai:grok-4.5"] as const) {
			expect(toolsForModel(model).map((tool) => tool.name), model).toContain("browser_act");
		}
	});
});
