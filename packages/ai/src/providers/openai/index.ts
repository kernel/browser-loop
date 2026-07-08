import type { ComputerToolCoordinateSystem, CuaMode, CuaProviderModule } from "../common";
import { computerToolExecutors, computerTools } from "../common";

export {
	CUA_ACTION_TYPES as OPENAI_CUA_ACTION_TYPES,
	CUA_NAVIGATION_TOOL_DESCRIPTION as OPENAI_EXTRA_TOOL_DESCRIPTION,
	CUA_NAVIGATION_TOOL_NAME as OPENAI_EXTRA_TOOL_NAME,
	computerToolExecutors,
	computerTools,
	createCuaActionSchema as createActionSchema,
	CuaNavigationSchema as OpenAIExtraSchema,
} from "../common";
export type {
	CuaAction as OpenAIAction,
	ComputerToolsOptions,
	CuaNavigationInput as OpenAIExtraInput,
} from "../common";
export {
	OPENAI_CUA_RESPONSES_API,
	streamOpenAIResponses,
	streamSimpleOpenAIResponses,
} from "./provider";
export type { OpenAIResponsesOptions } from "./provider";

// Provider-native action vocabulary emitted on `computer_call.action.type`:
//   click, double_click, drag, move, scroll, type, keypress, wait, screenshot
// Source: https://github.com/openai/openai-cua-sample-app/blob/main/packages/runner-core/src/responses-loop.ts
export function coordinateSystem(): ComputerToolCoordinateSystem {
	return { type: "pixel" };
}

export const OPENAI_COMPUTER_INSTRUCTIONS = `You control a Kernel cloud browser through individual browser tools. Use the available tools for browser interaction and request explicit url, cursor_position, or screenshot reads when you need updated state.`;

export const OPENAI_DOM_INSTRUCTIONS = `You control a Kernel cloud browser through page tools. Prefer reading the page with snapshot or find and targeting elements by reference; use screenshots when you need to inspect visual state. Element references go stale when the page changes — re-snapshot when told so.`;

export const OPENAI_HYBRID_INSTRUCTIONS = `You control a Kernel cloud browser through two kinds of tools: computer_* tools perform real OS-level input (coordinates are pixels in the most recent computer_screenshot), and page_* tools read and act on the page itself by element reference. Prefer page_snapshot/page_find for reading and locating, and computer_* input for interaction; use page_* interaction for elements that are hard to hit by coordinate.`;

export function buildOpenAISystemPrompt(opts: { suffix?: string; mode?: CuaMode } = {}): string {
	const base =
		opts.mode === "dom" ? OPENAI_DOM_INSTRUCTIONS : opts.mode === "hybrid" ? OPENAI_HYBRID_INSTRUCTIONS : OPENAI_COMPUTER_INSTRUCTIONS;
	return [base, opts.suffix].filter(Boolean).join("\n\n");
}

export const providerModule = {
	toolDefinitions: computerTools,
	toolExecutors: computerToolExecutors,
	coordinateSystem,
	buildSystemPrompt: buildOpenAISystemPrompt,
} satisfies CuaProviderModule;
