import type { Api, Model } from "@earendil-works/pi-ai";
import { loopToolMenu as coreLoopToolMenu, type LoopToolMenuEntry } from "../core/menu";
import {
	compileLoopToolCatalog as compileCatalog,
	type LoopCatalogToolInput,
	type LoopPayloadTransform,
	type LoopToolCatalog,
	type LoopToolSpec,
} from "../core/tool-catalog";
import { getLoopModel, loopModelFacts, type LoopModelRef } from "./models";
import { anthropicAdaptiveThinkingOnPayload } from "./providers/anthropic/adaptive-thinking";

/**
 * `model-preparation` payload transforms the pi binding contributes for a
 * model. Provider-specific request preparation lives here, on the pi side of
 * the boundary; the neutral compiler only orders and validates the transforms
 * it is handed.
 */
export function loopModelPreparationTransforms(model: Model<Api>): LoopPayloadTransform[] {
	if (model.provider !== "anthropic") return [];
	return [{
		identity: "provider.anthropic.model-preparation",
		phase: "model-preparation",
		writes: ["thinking", "output_config.effort"],
		apply(payload, selectedModel) {
			return anthropicAdaptiveThinkingOnPayload(payload, selectedModel) ?? payload;
		},
	}];
}

/**
 * {@link compileCatalog} with pi model resolution: a provider-qualified ref is
 * resolved through pi-ai's registry and compiled together with pi's
 * availability facts and model-preparation transforms.
 */
export function compileLoopToolCatalog(options: {
	model: LoopModelRef | Model<Api>;
	requestedTools: readonly LoopCatalogToolInput[];
}): LoopToolCatalog<Model<Api>> {
	const model = typeof options.model === "string" ? getLoopModel(options.model) : options.model;
	return compileCatalog({
		model,
		requestedTools: options.requestedTools,
		facts: loopModelFacts(model),
		preparation: loopModelPreparationTransforms(model),
	});
}

/** {@link coreLoopToolMenu} with pi model resolution and availability facts. */
export function loopToolMenu(
	model: LoopModelRef | Model<Api>,
	selected: readonly LoopToolSpec[] = [],
): LoopToolMenuEntry[] {
	const resolved = typeof model === "string" ? getLoopModel(model) : model;
	return coreLoopToolMenu(resolved, selected, loopModelFacts(resolved));
}
