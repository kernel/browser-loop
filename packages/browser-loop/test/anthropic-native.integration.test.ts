import { describe, expect, it } from "vitest";
import { createLoopModels } from "../src/pi/index";
import { compileLoopToolCatalog, loop } from "../src/index";

const apiKey = process.env.ANTHROPIC_API_KEY;
const liveIt = apiKey ? it : it.skip;

const cases = [
	{
		name: "computer",
		tool: loop.providers.anthropic.tools.computer({ version: "20260801", zoom: true }),
		prompt: "Use the computer tool to take one screenshot.",
		expectedAction: "screenshot",
	},
	{
		name: "browser",
		tool: loop.providers.anthropic.tools.browser({ version: "20260801", javascript: true }),
		prompt: "Use the browser tool to navigate to example.com.",
		expectedAction: "navigate",
	},
] as const;

describe("Anthropic client toolsets", () => {
	for (const current of cases) {
		liveIt(`${current.name} survives catalog and pi-ai serialization`, async () => {
			const catalog = compileLoopToolCatalog({
				model: "anthropic:claude-opus-5",
				requestedTools: [current.tool],
			});
			const response = await createLoopModels().complete(
				catalog.model,
				{
					systemPrompt: "Use only the explicitly supplied tool.",
					messages: [{ role: "user", content: current.prompt, timestamp: Date.now() }],
					tools: [...catalog.toolDeclarations],
				},
				{
					apiKey,
					maxTokens: 1_024,
					headers: catalog.headers.merge(),
					loopIncomingToolPlan: catalog.incoming,
					onPayload: (payload, model) => catalog.payload.apply(payload, model),
				},
			);

			expect(response.stopReason, response.errorMessage).toBe("toolUse");
			expect(response.content).toContainEqual(expect.objectContaining({
				type: "toolCall",
				name: current.name,
				arguments: expect.objectContaining({ action: current.expectedAction }),
			}));
		}, 60_000);
	}
});
