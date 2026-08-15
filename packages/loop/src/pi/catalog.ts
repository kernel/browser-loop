import type { Api, Model } from "@earendil-works/pi-ai";
import { loopToolMenu as coreLoopToolMenu, type LoopToolMenuEntry } from "../core/menu";
import {
	compileLoopToolCatalog as compileCatalog,
	type LoopCatalogToolInput,
	type LoopToolCatalog,
	type LoopToolSpec,
} from "../core/tool-catalog";
import { getLoopModel, type LoopModelRef } from "./models";

/**
 * {@link compileCatalog} with pi model resolution: a provider-qualified ref is
 * resolved through pi-ai's registry before the neutral compiler runs.
 */
export function compileLoopToolCatalog(options: {
	model: LoopModelRef | Model<Api>;
	requestedTools: readonly LoopCatalogToolInput[];
}): LoopToolCatalog<Model<Api>> {
	return compileCatalog({
		model: typeof options.model === "string" ? getLoopModel(options.model) : options.model,
		requestedTools: options.requestedTools,
	});
}

/** {@link coreLoopToolMenu} with pi model resolution. */
export function loopToolMenu(
	model: LoopModelRef | Model<Api>,
	selected: readonly LoopToolSpec[] = [],
): LoopToolMenuEntry[] {
	return coreLoopToolMenu(typeof model === "string" ? getLoopModel(model) : model, selected);
}
