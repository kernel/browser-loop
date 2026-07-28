import type { Api, Model } from "@earendil-works/pi-ai";
import type { CuaPayloadHook } from "../common";

/** Convert manual thinking budgets to Anthropic adaptive-thinking effort. */
export const anthropicAdaptiveThinkingOnPayload: CuaPayloadHook = (payload, model) => {
	if (!isAdaptiveThinkingModel(model) || !isRecord(payload)) return undefined;
	const thinking = payload.thinking;
	if (!isRecord(thinking) || thinking.type !== "enabled") return undefined;
	const outputConfig = isRecord(payload.output_config) ? { ...payload.output_config } : {};
	outputConfig.effort = effortFromBudgetTokens(thinking.budget_tokens);
	return { ...payload, thinking: { type: "adaptive" }, output_config: outputConfig };
};

function isAdaptiveThinkingModel(model: Model<Api>): boolean {
	if (model.provider !== "anthropic") return false;
	const id = model.id.toLowerCase();
	return [
		"claude-fable-5",
		"claude-mythos-5",
		"claude-mythos-preview",
		"claude-sonnet-5",
		"claude-sonnet-4-6",
		"claude-opus-5",
		"claude-opus-4-8",
		"claude-opus-4-7",
		"claude-opus-4-6",
	].some((prefix) => id.startsWith(prefix));
}

function effortFromBudgetTokens(value: unknown): "low" | "medium" | "high" | "xhigh" {
	if (typeof value !== "number" || !Number.isFinite(value)) return "high";
	if (value <= 4_096) return "low";
	if (value <= 8_192) return "medium";
	if (value <= 20_000) return "high";
	return "xhigh";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
