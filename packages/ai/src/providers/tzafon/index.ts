import {
	assertOsModeOnly,
	computerToolExecutors,
	computerTools,
	type ComputerToolCoordinateSystem,
	type ComputerToolsOptions,
	type CuaProviderModule,
} from "../common";
import { tzafonComputerUseOnPayload } from "./provider";

export {
	CUA_ACTION_TYPES as TZAFON_CUA_ACTION_TYPES,
	computerToolExecutors,
	computerTools,
	createCuaActionSchema as createActionSchema,
} from "../common";
export type {
	CuaAction as TzafonAction,
	ComputerToolsOptions,
} from "../common";
export {
	buildTzafonRequestInput,
	TZAFON_RESPONSES_API,
	streamSimpleTzafonResponses,
	streamTzafonResponses,
	toCanonicalActions,
	tzafonComputerUseOnPayload,
	tzafonToolCallId,
} from "./provider";
export type { TzafonCanonicalAction, TzafonRequestBody, TzafonRequestOptions, TzafonResponsesOptions } from "./provider";

// Provider-native action vocabulary. The model card lists supported actions;
// the Responses API loop dispatches on `action.type` and adds terminal control
// types (`answer`, `done`).
//   Model actions: click, double_click, triple_click, right_click, drag, type,
//                  key, scroll, hscroll, navigate, wait, terminate
//   Responses API `action.type` also includes: keypress, answer, done
// Sources:
//   https://huggingface.co/Tzafon/Northstar-CUA-Fast
//   https://docs.lightcone.ai/guides/cua-protocol/
//   https://docs.lightcone.ai/guides/coordinates/
export function coordinateSystem(): ComputerToolCoordinateSystem {
	return { type: "normalized", range: [0, 999] };
}

export const TZAFON_COMPUTER_INSTRUCTIONS = `You control a Kernel cloud browser through individual browser tools. Include screenshot or URL reads when you need updated state.`;

/** Build the default system prompt used with Tzafon CUA models. */
export function buildTzafonSystemPrompt(opts: { suffix?: string } = {}): string {
	return [TZAFON_COMPUTER_INSTRUCTIONS, opts.suffix].filter(Boolean).join("\n\n");
}

export const providerModule = {
	toolDefinitions: (options?: ComputerToolsOptions) => {
		assertOsModeOnly("tzafon", options);
		return computerTools(options);
	},
	toolExecutors: (options?: ComputerToolsOptions) => {
		assertOsModeOnly("tzafon", options);
		return computerToolExecutors(options);
	},
	coordinateSystem,
	buildSystemPrompt: buildTzafonSystemPrompt,
	onPayload: tzafonComputerUseOnPayload,
} satisfies CuaProviderModule;
