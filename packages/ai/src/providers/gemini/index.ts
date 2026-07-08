import { assertOsModeOnly, computerToolExecutors, computerTools } from "../common";
import type { ComputerToolCoordinateSystem, ComputerToolsOptions, CuaProviderModule } from "../common";

export {
	CUA_ACTION_TYPES as GEMINI_CUA_ACTION_TYPES,
	computerToolExecutors,
	computerTools,
	createCuaActionSchema as createActionSchema,
} from "../common";
export type {
	CuaAction as GeminiAction,
	ComputerToolsOptions,
} from "../common";

// Provider-native function names emitted on `functionCall.name` (PREDEFINED_COMPUTER_USE_FUNCTIONS):
//   open_web_browser, click_at, hover_at, type_text_at, scroll_document,
//   scroll_at, wait_5_seconds, go_back, go_forward, search, navigate,
//   key_combination, drag_and_drop
// Coordinates are normalized to 0-999 regardless of input image size.
// Source: https://github.com/google/computer-use-preview/blob/main/agent.py
// Docs: https://ai.google.dev/gemini-api/docs/computer-use
export function coordinateSystem(): ComputerToolCoordinateSystem {
	return { type: "normalized", range: [0, 999] };
}

export const GEMINI_COMPUTER_INSTRUCTIONS = `You control a Kernel cloud browser through individual browser tools. Use the provider coordinate system for tool calls, and request screenshots or URL reads when state changes.`;

export function buildGeminiSystemPrompt(opts: { suffix?: string } = {}): string {
	return [GEMINI_COMPUTER_INSTRUCTIONS, opts.suffix].filter(Boolean).join("\n\n");
}

export const providerModule = {
	// Gemini's computer-use coordinate convention is normalized 0-999, which
	// only maps onto the OS plane today; DOM-plane viewport coordinates are
	// unvalidated for it.
	toolDefinitions: (options?: ComputerToolsOptions) => {
		assertOsModeOnly("google", options);
		return computerTools(options);
	},
	toolExecutors: (options?: ComputerToolsOptions) => {
		assertOsModeOnly("google", options);
		return computerToolExecutors(options);
	},
	coordinateSystem,
	buildSystemPrompt: buildGeminiSystemPrompt,
} satisfies CuaProviderModule;
