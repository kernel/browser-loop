import {
	cua,
	cuaModelCapabilities,
	getCuaModel,
	parseCuaModelRef,
	type CuaModelRef,
} from "@onkernel/cua-ai";
import type { CuaAgentTool } from "../../src/index";

function structuredBrowserTools(): CuaAgentTool[] {
	return [...cua.toolsets.browser(), cua.tools.browser.act()];
}

/**
 * Interaction policy shared by the agent and harness provider matrices. Both
 * examples read it from here so the two cannot drift apart.
 */
export function toolsForModel(model: CuaModelRef): CuaAgentTool[] {
	const { provider, model: modelId } = parseCuaModelRef(model);
	switch (provider) {
		case "openai":
			// Favor refs, semantic reads, and verified plans over coordinate-only computer use.
			return structuredBrowserTools();
		case "anthropic":
			// Claude 5 can use Anthropic's native browser tool; older models use portable
			// CUA tools plus the explicit semantic action-plan surface.
			return cua.providers.anthropic.supports.browser(modelId)
				? [cua.providers.anthropic.tools.browser({ version: "20260701", javascript: true })]
				: structuredBrowserTools();
		case "google":
			// Current Gemini computer-use models expect Google's predefined browser actions.
			return cua.providers.google.toolsets.browser();
		case "xai":
			// No first-party native browser surface exists, so use CUA browser primitives
			// plus verified dependent plans.
			return structuredBrowserTools();
		case "moonshotai":
		case "openrouter":
			// Same as xai, minus browser_act where the model rejects that tool's
			// oversized schema. OpenRouter fronts several model families, so ask
			// the model rather than the provider.
			return cuaModelCapabilities(getCuaModel(model)).acceptsLargeSchemas
				? structuredBrowserTools()
				: cua.toolsets.browser();
	}
}
