import { assertComputerModeOnly, computerToolExecutors, computerTools } from "../common";
import type { ComputerToolCoordinateSystem, ComputerToolsOptions, CuaProviderModule } from "../common";

export {
	CUA_ACTION_TYPES as XAI_CUA_ACTION_TYPES,
	computerToolExecutors,
	computerTools,
	createCuaActionSchema as createActionSchema,
} from "../common";
export type {
	CuaAction as XaiAction,
	ComputerToolsOptions,
} from "../common";
export {
	streamSimpleXaiResponses,
	streamXaiResponses,
	threadXaiRequest,
	XAI_CUA_RESPONSES_API,
} from "./provider";
export type { XaiResponsesOptions } from "./provider";

/**
 * Instructions for driving Grok through CUA's custom function tools.
 *
 * xAI documents {@link https://docs.x.ai/developers/model-capabilities/images/understanding | image input}
 * and {@link https://docs.x.ai/developers/tools/function-calling | function calling},
 * but does not define a native computer tool or coordinate space.
 */
export const XAI_COMPUTER_INSTRUCTIONS = `You control a Kernel cloud browser through individual browser tools. Coordinates are normalized from 0 to 1000 relative to the most recent screenshot, with (0, 0) at the top left and (1000, 1000) at the bottom right. Base each action on the latest observed state and request a screenshot when you need a fresh view.`;

/**
 * Build xAI's default system prompt for computer-use runs.
 */
export function buildXaiSystemPrompt(opts: { suffix?: string } = {}): string {
	return [XAI_COMPUTER_INSTRUCTIONS, opts.suffix].filter(Boolean).join("\n\n");
}

/**
 * Return the normalized coordinate contract CUA supplies to Grok function tools.
 *
 * This is a CUA-defined contract because xAI's documented
 * {@link https://docs.x.ai/developers/tools/function-calling | function tools}
 * do not prescribe browser coordinates.
 */
export function coordinateSystem(): ComputerToolCoordinateSystem {
	return { type: "normalized", range: [0, 1000] };
}

export const providerModule = {
	toolDefinitions: (options?: ComputerToolsOptions) => {
		assertComputerModeOnly("xai", options);
		return computerTools(options);
	},
	toolExecutors: (options?: ComputerToolsOptions) => {
		assertComputerModeOnly("xai", options);
		return computerToolExecutors(options);
	},
	coordinateSystem,
	buildSystemPrompt: buildXaiSystemPrompt,
} satisfies CuaProviderModule;
