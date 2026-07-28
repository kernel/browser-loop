import { describe, expect, it } from "vitest";
import { toolsForModel } from "../examples/shared/tools";

describe("provider-matrix example tools", () => {
	it("uses the documented browser-oriented defaults", () => {
		expect(toolsForModel("openai:gpt-5.6-sol")[0]?.name).toBe("browser_snapshot");
		expect(toolsForModel("anthropic:claude-opus-5")).toEqual([
			expect.objectContaining({ name: "browser", origin: "provider-native" }),
		]);
		expect(toolsForModel("anthropic:claude-3-7-sonnet")[0]?.name).toBe("browser_snapshot");
		expect(toolsForModel("google:gemini-3-flash-preview").map((tool) => tool.name)).toContain("take_screenshot");
		for (const model of ["meta:muse-spark-1.1", "xai:grok-4.5", "moonshotai:kimi-k3"] as const) {
			expect(toolsForModel(model)[0]).toMatchObject({ name: "browser_snapshot", origin: "cua" });
		}
		expect(toolsForModel("tzafon:tzafon.northstar-cua-fast")[0]?.name).toBe("computer");
		expect(toolsForModel("yutori:n1.5-latest")[0]?.name).toBe("left_click");
	});
});
