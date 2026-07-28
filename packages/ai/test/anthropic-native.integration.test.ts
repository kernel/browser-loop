import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	compileCuaToolCatalog,
	createCuaModels,
	cua,
	type CuaToolSpec,
} from "../src/index";

const apiKey = process.env.ANTHROPIC_API_KEY;
const liveIt = apiKey ? it : it.skip;

const resources = {
	viewport: { width: 1440, height: 900 },
	materialize(spec: CuaToolSpec): AgentTool {
		return {
			...spec.declaration,
			label: spec.name,
			async execute() {
				return { content: [{ type: "text" as const, text: "not executed in catalog smoke test" }], details: {} };
			},
		};
	},
	async osScreenshot() { return { data: Buffer.from("image"), mimeType: "image/png" }; },
};

const cases = [
	{
		name: "computer",
		tool: cua.providers.anthropic.tools.computer({ version: "20260701", enableZoom: true }),
		prompt: "Use the computer tool to take one screenshot.",
		expectedAction: "screenshot",
	},
	{
		name: "browser",
		tool: cua.providers.anthropic.tools.browser({ version: "20260701", javascript: true }),
		prompt: "Use the browser tool to navigate to example.com.",
		expectedAction: "navigate",
	},
] as const;

describe("Anthropic early-access native tools", () => {
	for (const current of cases) {
		liveIt(`${current.name} survives catalog and pi-ai serialization`, async () => {
			const catalog = compileCuaToolCatalog({
				model: "anthropic:claude-opus-5",
				requestedTools: [current.tool],
				resources,
			});
			const response = await createCuaModels().complete(
				catalog.model,
				{
					systemPrompt: "Use only the explicitly supplied tool.",
					messages: [{ role: "user", content: current.prompt, timestamp: Date.now() }],
					tools: [...catalog.agentTools],
				},
				{
					apiKey,
					maxTokens: 1_024,
					headers: catalog.headers.merge(),
					cuaIncomingToolPlan: catalog.incoming,
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
