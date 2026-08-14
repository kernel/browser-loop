import { loop, type LoopAgentTool } from "../../src/index";
import {
	getLoopModel,
	loopModelCapabilities,
	type LoopModelRef,
	parseLoopModelRef,
} from "../../src/pi/index";

function structuredBrowserTools(): LoopAgentTool[] {
	return [...loop.toolsets.browser(), loop.tools.browser.act()];
}

/**
 * Interaction policy shared by the agent and harness provider matrices. Both
 * examples read it from here so the two cannot drift apart.
 */
export function toolsForModel(model: LoopModelRef): LoopAgentTool[] {
	const { provider, model: modelId } = parseLoopModelRef(model);
	switch (provider) {
		case "openai":
			// Favor refs, semantic reads, and verified plans over coordinate-only computer use.
			return structuredBrowserTools();
		case "anthropic":
			// Claude 5 can use Anthropic's native browser tool; older models use portable
			// Loop tools plus the explicit semantic action-plan surface.
			return loop.providers.anthropic.supports.browser(modelId)
				? [loop.providers.anthropic.tools.browser({ version: "20260701", javascript: true })]
				: structuredBrowserTools();
		case "google":
			// Current Gemini computer-use models expect Google's predefined browser actions.
			return loop.providers.google.toolsets.browser();
		case "xai":
			// No first-party native browser surface exists, so use Loop browser primitives
			// plus verified dependent plans.
			return structuredBrowserTools();
		case "moonshotai":
		case "openrouter":
			// Same as xai, minus browser_act where the model rejects that tool's
			// oversized schema. OpenRouter fronts several model families, so ask
			// the model rather than the provider.
			return loopModelCapabilities(getLoopModel(model)).acceptsLargeSchemas
				? structuredBrowserTools()
				: loop.toolsets.browser();
	}
}
