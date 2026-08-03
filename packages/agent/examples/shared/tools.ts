import {
	cua,
	parseCuaModelRef,
	type CuaModelRef,
} from "@onkernel/cua-ai";
import type { CuaAgentTool } from "../../src/index";

function structuredBrowserTools(): CuaAgentTool[] {
	return [...cua.toolsets.browser(), cua.tools.browser.act()];
}

/**
 * Interaction policy shared by the agent and harness provider matrices, mirroring
 * the CLI defaults in `packages/cli/src/harness.ts`. Both examples read it from
 * here so the two cannot drift apart.
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
		case "meta":
		case "xai":
			// No first-party native browser surface exists, so use CUA browser primitives
			// plus verified dependent plans.
			return structuredBrowserTools();
		case "moonshotai":
		case "openrouter":
			// Same as meta/xai, minus browser_act: Kimi's API rejects that tool's
			// oversized schema, so Kimi gets the browser primitives only.
			return cua.toolsets.browser();
		case "tzafon":
			// Northstar's documented native computer schema is its supported interaction contract.
			return [cua.providers.tzafon.tools.computer()];
		case "yutori":
			// Match Yutori's documented model generation and add explicit visual access.
			return [
				...(modelId.startsWith("n1.5")
					? cua.providers.yutori.toolsets.n15Core()
					: cua.providers.yutori.toolsets.n1()),
				cua.tools.computer.screenshot(),
			];
	}
}
