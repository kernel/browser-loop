import { cua, parseCuaModelRef, type CuaAgentTool, type CuaModelRef } from "@onkernel/cua-ai";

/** Example application policy: choose one explicit catalog for each model family. */
export function toolsForModel(model: CuaModelRef): CuaAgentTool[] {
	const { provider, model: modelId } = parseCuaModelRef(model);
	switch (provider) {
		case "openai":
			return cua.toolsets.browser();
		case "anthropic":
			return cua.providers.anthropic.supports.browser(modelId)
				? [cua.providers.anthropic.tools.browser({ version: "20260701", javascript: true })]
				: cua.toolsets.browser();
		case "google":
			return cua.providers.google.toolsets.browser();
		case "meta":
		case "xai":
		case "moonshotai":
			return cua.toolsets.browser();
		case "tzafon":
			return [cua.providers.tzafon.tools.computer()];
		case "yutori":
			return modelId.startsWith("n1.5")
				? cua.providers.yutori.toolsets.n15Core()
				: cua.providers.yutori.toolsets.n1();
	}
}
