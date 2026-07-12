import { assertComputerModeOnly, buildDefaultComputerSystemPrompt, computerToolExecutors, computerTools } from "../common";
import type { ComputerToolCoordinateSystem, ComputerToolsOptions, CuaProviderModule } from "../common";

export {
	buildDefaultComputerSystemPrompt as buildMetaSystemPrompt,
	CUA_ACTION_TYPES as META_CUA_ACTION_TYPES,
	DEFAULT_COMPUTER_INSTRUCTIONS as META_COMPUTER_INSTRUCTIONS,
	computerToolExecutors,
	computerTools,
	createCuaActionSchema as createActionSchema,
} from "../common";
export type {
	CuaAction as MetaAction,
	ComputerToolsOptions,
} from "../common";
export {
	META_RESPONSES_API,
	streamMetaResponses,
	streamSimpleMetaResponses,
	threadMetaRequest,
} from "./provider";
export type { MetaResponsesOptions } from "./provider";

// Muse Spark reports screenshot positions on a normalized 0-1000 grid.
// Source: https://dev.meta.ai/docs/features/image-understanding#coordinate-system
export function coordinateSystem(): ComputerToolCoordinateSystem {
	return { type: "normalized", range: [0, 1000] };
}

export const providerModule = {
	toolDefinitions: (options?: ComputerToolsOptions) => {
		assertComputerModeOnly("meta", options);
		return computerTools(options);
	},
	toolExecutors: (options?: ComputerToolsOptions) => {
		assertComputerModeOnly("meta", options);
		return computerToolExecutors(options);
	},
	coordinateSystem,
	buildSystemPrompt: buildDefaultComputerSystemPrompt,
} satisfies CuaProviderModule;
