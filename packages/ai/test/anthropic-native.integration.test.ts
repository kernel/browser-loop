import { describe, expect, it } from "vitest";
import { createCuaModels, resolveCuaRuntimeSpec, type CuaNativeToolSpec } from "../src/index";

const apiKey = process.env.ANTHROPIC_API_KEY;
const liveIt = apiKey ? it : it.skip;

const cases: Array<{
	name: string;
	nativeTool: CuaNativeToolSpec;
	prompt: string;
	expectedAction: string;
}> = [
	{
		name: "computer_20260701",
		nativeTool: { type: "computer_20260701", enable_zoom: true },
		prompt: "Use the computer tool to take one screenshot.",
		expectedAction: "screenshot",
	},
	{
		name: "browser_20260701",
		nativeTool: { type: "browser_20260701", enable_javascript_exec: true },
		prompt: "Use the browser tool to navigate to example.com.",
		expectedAction: "navigate",
	},
];

describe("Anthropic early-access native tools", () => {
	for (const current of cases) {
		liveIt(`${current.name} survives CUA's pi-ai serialization`, async () => {
			const spec = resolveCuaRuntimeSpec("anthropic:claude-opus-5", { nativeTool: current.nativeTool });
			const response = await createCuaModels().complete(
				spec.model,
				{
					systemPrompt: spec.defaultSystemPrompt,
					messages: [{ role: "user", content: current.prompt, timestamp: Date.now() }],
					tools: spec.toolDefinitions,
				},
				{
					apiKey,
					maxTokens: 96,
					onPayload: spec.onPayload,
				},
			);

			expect(response.stopReason, response.errorMessage).toBe("toolUse");
			expect(response.content).toContainEqual(
				expect.objectContaining({
					type: "toolCall",
					name: current.name.startsWith("computer") ? "computer" : "browser",
					arguments: expect.objectContaining({ action: current.expectedAction }),
				}),
			);
		}, 60_000);
	}
});
