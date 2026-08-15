import type { AgentEvent, AgentHarnessEvent } from "../../src/pi/index";

type AssistantLike = {
	content: Array<{ type: string; text?: string }>;
	stopReason?: string;
};

export function logAgentEvent(event: AgentEvent | AgentHarnessEvent): void {
	if (event.type === "tool_execution_start") {
		console.log(`[tool:start] ${event.toolName} args=${formatJson(event.args)}`);
		return;
	}
	if (event.type === "tool_execution_end") {
		const result = event.result as { details?: unknown } | undefined;
		console.log(`[tool:end] ${event.toolName} error=${event.isError}${formatDetails(result?.details)}`);
	}
}

export function logAssistant(assistant: AssistantLike | undefined): void {
	const text =
		assistant?.content
			.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
			.join("")
			.trim() ?? "";
	console.log("assistant stopReason:", assistant?.stopReason ?? "unknown");
	console.log("assistant text:", text || "(no text)");
}

function formatDetails(details: unknown): string {
	if (!details) return "";
	return ` details=${formatJson(details)}`;
}

function formatJson(value: unknown): string {
	const text = JSON.stringify(value, null, 2) ?? "undefined";
	return text.length > 1200 ? `${text.slice(0, 1197)}...` : text;
}
