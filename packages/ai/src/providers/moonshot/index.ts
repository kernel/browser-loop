import { assertComputerModeOnly, computerToolExecutors, computerTools } from "../common";
import type { ComputerToolCoordinateSystem, ComputerToolsOptions, CuaPayloadHook, CuaProviderModule } from "../common";

export {
	CUA_ACTION_TYPES as MOONSHOT_CUA_ACTION_TYPES,
	computerToolExecutors,
	computerTools,
	createCuaActionSchema as createActionSchema,
} from "../common";
export type {
	CuaAction as MoonshotAction,
	ComputerToolsOptions,
} from "../common";

/**
 * Instructions for driving Kimi through CUA's custom function tools.
 *
 * Moonshot documents {@link https://platform.moonshot.ai/docs/guide/use-kimi-vision-model | image input}
 * and {@link https://platform.moonshot.ai/docs/api/tool-use | tool calling} on its
 * OpenAI-compatible API, but does not define a native computer tool or
 * coordinate space.
 */
export const MOONSHOT_COMPUTER_INSTRUCTIONS = `You control a Kernel cloud browser through individual browser tools. Coordinates are fractions of the most recent screenshot, normalized from 0 to 1, with (0, 0) at the top left and (1, 1) at the bottom right. Base each action on the latest observed state and request a screenshot when you need a fresh view.`;

/**
 * Build Moonshot's default system prompt for computer-use runs.
 */
export function buildMoonshotSystemPrompt(opts: { suffix?: string } = {}): string {
	return [MOONSHOT_COMPUTER_INSTRUCTIONS, opts.suffix].filter(Boolean).join("\n\n");
}

/**
 * Return the normalized coordinate contract CUA supplies to Kimi function tools.
 *
 * Kimi's visual grounding natively emits width/height fractions: probed with
 * real screenshots, Kimi answers 0-1 fractional coordinates regardless of
 * whether the prompt or tool schema asks for pixels or a 0-1000 grid (e.g.
 * (0.927, 0.293) for a link whose center is at that exact fraction). CUA
 * declares the contract the model actually honors and scales at execution.
 */
export function coordinateSystem(): ComputerToolCoordinateSystem {
	return { type: "normalized", range: [0, 1] };
}

// Browser actions mutate shared state, so ask the API for serial tool calls.
const onPayload: CuaPayloadHook = (payload) => {
	if (!payload || typeof payload !== "object") return undefined;
	return { ...(payload as Record<string, unknown>), parallel_tool_calls: false };
};

export const providerModule = {
	toolDefinitions: (options?: ComputerToolsOptions) => {
		assertComputerModeOnly("moonshotai", options);
		return computerTools(options);
	},
	toolExecutors: (options?: ComputerToolsOptions) => {
		assertComputerModeOnly("moonshotai", options);
		return computerToolExecutors(options);
	},
	coordinateSystem,
	buildSystemPrompt: buildMoonshotSystemPrompt,
	onPayload,
} satisfies CuaProviderModule;
