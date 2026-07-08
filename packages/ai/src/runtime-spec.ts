import type { Api, Model } from "@earendil-works/pi-ai";
import type { CuaProvider } from "./models";
import { getCuaModel, providerForModel, routeCuaApi } from "./models";
import { modeForNativeTool, resolveNativeTool, type CuaNativeToolSpec } from "./native-tools";
import { providerModule as anthropic } from "./providers/anthropic/index";
import { createNativeToolOnPayload, nativeApiForToolType, nativeToolExecutors } from "./providers/anthropic/native";
import { providerModule as gemini } from "./providers/gemini/index";
import { providerModule as openai } from "./providers/openai/index";
import { providerModule as tzafon } from "./providers/tzafon/index";
import { providerModule as yutori } from "./providers/yutori/index";
import type {
	ComputerToolsOptions,
	CuaPayloadHook,
	CuaProviderModule,
	CuaRuntimeSpec,
	CuaRuntimeSpecInput,
} from "./providers/common";

const PROVIDERS = {
	openai,
	anthropic,
	google: gemini,
	tzafon,
	yutori,
} satisfies Record<CuaProvider, CuaProviderModule>;

/** Options accepted by {@link resolveCuaRuntimeSpec}. */
export interface CuaRuntimeSpecOptions extends ComputerToolsOptions {
	/**
	 * Drive the model through a provider-native tool declaration instead of
	 * CUA's canonical function tools. The native tool determines (and is
	 * validated against) the mode: `computer_20260601` requires `"os"`,
	 * `browser_20260701` requires `"dom"`. When `mode` is omitted it is
	 * inferred from the native tool.
	 */
	nativeTool?: CuaNativeToolSpec;
}

/**
 * Resolve provider defaults from either a CUA model ref or a concrete model.
 *
 * Use the returned spec to build computer-use requests without hard-coding
 * model-provider rules in your application. Pass `options` to select the
 * action plane(s) (`mode`), narrow the exposed actions (`actions`), or drive
 * an Anthropic model through its native tool schema (`nativeTool`).
 */
export function resolveCuaRuntimeSpec(input: CuaRuntimeSpecInput, options: CuaRuntimeSpecOptions = {}): CuaRuntimeSpec {
	const model = typeof input === "string" ? getCuaModel(input) : routeCuaApi(input);
	const provider = providerForModel(model);
	const mod: CuaProviderModule = PROVIDERS[provider];
	const mode = options.mode ?? (options.nativeTool ? modeForNativeTool(options.nativeTool) : "os");

	if (options.nativeTool) {
		const nativeTool = resolveNativeTool(options.nativeTool, model, mode);
		const nativeModel: Model<Api> = { ...model, api: nativeApiForToolType(nativeTool.spec.type) as Model<Api>["api"] };
		const executors = nativeToolExecutors(nativeTool);
		return {
			model: nativeModel,
			provider,
			mode,
			nativeTool,
			toolDefinitions: executors.map((executor) => executor.definition),
			toolExecutors: executors,
			defaultSystemPrompt: mod.buildSystemPrompt({ mode }),
			coordinateSystem: mod.coordinateSystem(),
			screenshot: mod.screenshot,
			onPayload: composePayloadHooks(createNativeToolOnPayload(nativeTool), mod.onPayload),
		};
	}

	const toolsOptions: ComputerToolsOptions = { ...options, mode };
	return {
		model,
		provider,
		mode,
		toolDefinitions: mod.toolDefinitions(toolsOptions),
		toolExecutors: mod.toolExecutors(toolsOptions),
		defaultSystemPrompt: mod.buildSystemPrompt({ mode }),
		coordinateSystem: mod.coordinateSystem(),
		screenshot: mod.screenshot,
		onPayload: mod.onPayload,
	};
}

function composePayloadHooks(first: CuaPayloadHook, second: CuaPayloadHook | undefined): CuaPayloadHook {
	if (!second) return first;
	return async (payload, model, context) => {
		const afterFirst = (await first(payload, model, context)) ?? payload;
		return (await second(afterFirst, model, context)) ?? afterFirst;
	};
}
