import { describe, expect, it } from "vitest";
import { getLoopModel } from "../src/pi/models";
import { anthropicAdaptiveThinkingOnPayload } from "../src/pi/providers/anthropic/adaptive-thinking";
import { compileLoopToolCatalog, loop } from "../src/index";

describe("anthropicAdaptiveThinkingOnPayload", () => {
	it("converts Sonnet 5 manual thinking to adaptive thinking with effort", () => {
		const payload = {
			thinking: { type: "enabled", budget_tokens: 8_192 },
			output_config: { other: true },
			messages: [],
		};

		expect(anthropicAdaptiveThinkingOnPayload(payload, getLoopModel("anthropic:claude-sonnet-5"))).toEqual({
			thinking: { type: "adaptive" },
			output_config: { other: true, effort: "medium" },
			messages: [],
		});
	});

	it("converts adaptive-thinking Anthropic Loop models", () => {
		const payload = { thinking: { type: "enabled", budget_tokens: 8_192 } };

		for (const ref of [
			"anthropic:claude-opus-5",
			"anthropic:claude-sonnet-5",
			"anthropic:claude-sonnet-4-6",
			"anthropic:claude-opus-4-8",
			"anthropic:claude-opus-4-7",
			"anthropic:claude-fable-5",
		] as const) {
			expect(anthropicAdaptiveThinkingOnPayload(payload, getLoopModel(ref))).toMatchObject({
				thinking: { type: "adaptive" },
				output_config: { effort: "medium" },
			});
		}
	});

	it("leaves older manual-thinking Anthropic Loop models unchanged", () => {
		const payload = { thinking: { type: "enabled", budget_tokens: 8_192 } };

		expect(anthropicAdaptiveThinkingOnPayload(payload, getLoopModel("anthropic:claude-sonnet-4-5"))).toBeUndefined();
	});

	it("maps old budget levels to supported Sonnet 5 effort levels", () => {
		const model = getLoopModel("anthropic:claude-sonnet-5");
		const effortFor = (budget_tokens: number) =>
			(anthropicAdaptiveThinkingOnPayload({ thinking: { type: "enabled", budget_tokens } }, model) as { output_config: { effort: string } })
				.output_config.effort;

		expect(effortFor(1_024)).toBe("low");
		expect(effortFor(4_096)).toBe("low");
		expect(effortFor(8_192)).toBe("medium");
		expect(effortFor(16_384)).toBe("high");
		expect(effortFor(32_768)).toBe("xhigh");
	});
});

describe("model preparation through the compiled catalog", () => {
	it("compiles pi's Anthropic preparation transform into the payload plan", async () => {
		const catalog = compileLoopToolCatalog({ model: "anthropic:claude-sonnet-5", requestedTools: [loop.tools.browser.snapshot()] });

		expect(catalog.payload.transforms.map((transform) => transform.identity))
			.toContain("provider.anthropic.model-preparation");
		await expect(catalog.payload.apply({ thinking: { type: "enabled", budget_tokens: 8_192 } }, catalog.model))
			.resolves.toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "medium" } });
	});

	it("compiles no preparation transform for other providers", () => {
		const catalog = compileLoopToolCatalog({ model: "openai:gpt-5.5", requestedTools: [loop.tools.browser.snapshot()] });

		expect(catalog.payload.transforms.map((transform) => transform.identity))
			.not.toContain("provider.anthropic.model-preparation");
	});
});
