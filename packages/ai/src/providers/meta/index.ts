import { assertComputerModeOnly, computerToolExecutors, computerTools } from "../common";
import type { ComputerToolCoordinateSystem, ComputerToolsOptions, CuaProviderModule } from "../common";

export {
	CUA_ACTION_TYPES as META_CUA_ACTION_TYPES,
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

// CUA supplies Muse Spark with its canonical function actions: click,
// double_click, mouse_down, mouse_up, type, keypress, scroll, move, drag,
// wait, screenshot, goto, back, forward, url, and cursor_position.
// Meta's computer-use reference agent uses normalized 0-1000 coordinates.
export function coordinateSystem(): ComputerToolCoordinateSystem {
	return { type: "normalized", range: [0, 1000] };
}

export const META_COMPUTER_INSTRUCTIONS = `You control a Kernel cloud browser through individual browser tools. Coordinates are normalized from 0 to 1000 relative to the most recent screenshot, with (0, 0) at the top left and (1000, 1000) at the bottom right. Base each action on the latest observed state and request a screenshot when you need a fresh view.`;

export function buildMetaSystemPrompt(opts: { suffix?: string } = {}): string {
	return [META_COMPUTER_INSTRUCTIONS, opts.suffix].filter(Boolean).join("\n\n");
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
	buildSystemPrompt: buildMetaSystemPrompt,
} satisfies CuaProviderModule;
