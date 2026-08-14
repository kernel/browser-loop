import type { LoopModelRef } from "../src/pi/index";
import { compileLoopToolCatalog } from "../src/index";
import { describe, expect, it } from "vitest";
import { toolsForModel } from "../examples/shared/tools";

/**
 * The example matrices are plain scripts: they are excluded from `tsc -b` and are
 * never executed in CI, so a provider policy that no longer compiles used to be
 * invisible until someone ran the script against a live key.
 *
 * Limited to models the registry can resolve, so Anthropic's older non-native
 * fallback branch is covered by the tool menu's availability tests instead.
 */
const models: readonly LoopModelRef[] = [
	"openai:gpt-5.6-sol",
	"anthropic:claude-opus-5",
	"anthropic:claude-sonnet-5",
	"google:gemini-3.6-flash",
	"openrouter:meta/muse-spark-1.1",
	"xai:grok-4.5",
	"moonshotai:kimi-k3",
	"openrouter:moonshotai/kimi-k3",
];

describe("example provider matrix tool policy", () => {
	it("compiles a valid catalog for every model the matrices advertise", () => {
		for (const model of models) {
			expect(
				() => compileLoopToolCatalog({ model, requestedTools: toolsForModel(model) }),
				model,
			).not.toThrow();
		}
	});

	it.each(["moonshotai:kimi-k3", "openrouter:moonshotai/kimi-k3"] as const)(
		"omits browser_act for Kimi, whose API rejects its schema size (%s)",
		(model) => {
			const names = toolsForModel(model).map((tool) => tool.name);
			expect(names).toContain("browser_snapshot");
			expect(names).toContain("browser_wait_for");
			expect(names).not.toContain("browser_act");
		},
	);

	it("still advertises browser_act where the provider accepts it", () => {
		for (const model of ["openai:gpt-5.6-sol", "xai:grok-4.5", "openrouter:meta/muse-spark-1.1"] as const) {
			expect(toolsForModel(model).map((tool) => tool.name), model).toContain("browser_act");
		}
	});
});
