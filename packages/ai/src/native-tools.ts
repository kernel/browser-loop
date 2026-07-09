import type { Api, Model } from "@earendil-works/pi-ai";
import type { CuaMode } from "./modes";

/**
 * Anthropic's native computer-use tool (`anthropic-beta:
 * computer-use-2026-07-01`). Server-defined: the declaration below is sent
 * verbatim in `tools[]` and Anthropic fixes the input schema. Maps to CUA's
 * `computer` mode — actions arrive as OS-level input in screenshot-pixel
 * coordinates.
 */
export interface AnthropicComputerNativeTool {
	type: "computer_20260701";
	/** Tool name in the request; defaults to "computer". */
	name?: string;
	/** Adds a `zoom` action returning a cropped screenshot region. Default false. */
	enable_zoom?: boolean;
	/** X11 display number for multi-display environments. */
	display_number?: number;
	/** Prompt-caching breakpoint. */
	cache_control?: { type: "ephemeral" };
}

/**
 * Anthropic's native browser tool (`anthropic-beta: browser-use-2026-07-01`,
 * proposed — the tool version and schema may change before release). Maps to
 * CUA's `browser` mode — page reads by element reference plus pointer actions in
 * viewport-pixel coordinates.
 */
export interface AnthropicBrowserNativeTool {
	type: "browser_20260701";
	/** Tool name in the request; defaults to "browser". */
	name?: string;
	/** Adds a `javascript_exec` action running arbitrary JS in the page. Default false. */
	enable_javascript_exec?: boolean;
	/** Prompt-caching breakpoint. */
	cache_control?: { type: "ephemeral" };
}

/**
 * A provider-native computer-use tool declaration.
 *
 * Pass one to `resolveCuaRuntimeSpec` (or `CuaAgent`/`CuaAgentHarness`) to
 * drive the model through its provider-defined tool schema instead of CUA's
 * canonical function tools. Each native tool pairs with exactly one
 * {@link CuaMode}; execution is identical either way — native tool calls are
 * translated to the same canonical actions the mode uses.
 */
export type CuaNativeToolSpec = AnthropicComputerNativeTool | AnthropicBrowserNativeTool;

export type CuaNativeToolType = CuaNativeToolSpec["type"];

interface NativeToolInfo {
	mode: Extract<CuaMode, "computer" | "browser">;
	provider: "anthropic";
	betaHeader: string;
	defaultName: string;
}

const NATIVE_TOOL_INFO: Record<CuaNativeToolType, NativeToolInfo> = {
	computer_20260701: { mode: "computer", provider: "anthropic", betaHeader: "computer-use-2026-07-01", defaultName: "computer" },
	browser_20260701: { mode: "browser", provider: "anthropic", betaHeader: "browser-use-2026-07-01", defaultName: "browser" },
};

/** The {@link CuaMode} a native tool requires. */
export function modeForNativeTool(spec: CuaNativeToolSpec): CuaMode {
	return NATIVE_TOOL_INFO[spec.type].mode;
}

/** The `anthropic-beta` header value a native tool requires. */
export function betaHeaderForNativeTool(spec: CuaNativeToolSpec): string {
	return NATIVE_TOOL_INFO[spec.type].betaHeader;
}

/** The tool name a native tool declares, defaulting per tool type. */
export function nativeToolName(spec: CuaNativeToolSpec): string {
	return spec.name ?? NATIVE_TOOL_INFO[spec.type].defaultName;
}

/** A validated native tool: the spec plus everything derived from it. */
export interface ResolvedCuaNativeTool {
	spec: CuaNativeToolSpec;
	/** The declaration sent verbatim in the provider `tools[]` array. */
	declaration: Record<string, unknown>;
	/** Tool name the model's tool_use blocks arrive under. */
	name: string;
	/** Required `anthropic-beta` header value. */
	betaHeader: string;
	mode: CuaMode;
}

/**
 * Validate a native tool spec against the resolved model and mode, and
 * derive the request-facing pieces. Throws when the model's provider does
 * not serve the tool or the mode conflicts with the tool's plane (mirroring
 * the API, which rejects e.g. `browser_20260701` outside a one-frame
 * browser-only request).
 */
export function resolveNativeTool(spec: CuaNativeToolSpec, model: Model<Api>, mode: CuaMode): ResolvedCuaNativeTool {
	const info = NATIVE_TOOL_INFO[spec.type];
	if (!info) throw new Error(`unknown native tool type "${(spec as { type: string }).type}"`);
	if (model.provider !== info.provider) {
		throw new Error(`native tool "${spec.type}" requires an ${info.provider} model paired with mode "${info.mode}"; got provider "${model.provider}"`);
	}
	if (mode !== info.mode) {
		throw new Error(`native tool "${spec.type}" requires mode "${info.mode}"; got "${mode}"`);
	}
	const name = nativeToolName(spec);
	return {
		spec,
		declaration: { ...spec, name },
		name,
		betaHeader: info.betaHeader,
		mode,
	};
}
