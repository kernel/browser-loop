import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Context,
	type ImageContent,
	type Message,
	type Model,
	type StreamFunction,
	type StreamOptions,
	type TextContent,
	type Tool,
	type ToolCall,
} from "@earendil-works/pi-ai";
import Lightcone from "@tzafon/lightcone";
import type { CuaAction } from "../../actions/index";
import {
	canonicalToolCallArguments,
	canonicalToolCallName,
	type CuaSimpleStreamOptions,
	responseThreadingDelta,
	responseThreadingEnabled,
	type ResponseThreadingOptions,
} from "../common";
import type { CuaIncomingToolPlan } from "../../tool-catalog";

export const TZAFON_RESPONSES_API = "tzafon-responses";

/** Stream options accepted by {@link streamTzafonResponses}. */
export interface TzafonResponsesOptions extends StreamOptions, ResponseThreadingOptions {
	/** @internal Identity-addressed native dispatch compiled from selected tools. */
	cuaIncomingToolPlan?: CuaIncomingToolPlan;
}

/** Inputs {@link buildTzafonRequestInput} reads to shape the Responses API request body. */
export interface TzafonRequestOptions extends ResponseThreadingOptions {
	temperature?: number;
	maxTokens?: number;
	cuaIncomingToolPlan?: CuaIncomingToolPlan;
}

/** Responses API request body for {@link Lightcone.responses.create}, including optional threading fields. */
export interface TzafonRequestBody {
	model: string;
	input: Array<Record<string, unknown>>;
	tools: Array<Record<string, unknown>>;
	instructions?: string;
	temperature: number;
	max_output_tokens?: number;
	previous_response_id?: string;
	store?: boolean;
}

/**
 * Build the Tzafon Responses API request body from a context.
 *
 * Pure and network-free. When response threading is enabled and a prior
 * assistant `responseId` exists, the body chains via `previous_response_id`
 * with `store: true` and sends only the delta messages; otherwise it replays
 * the full message history.
 */
export function buildTzafonRequestInput(model: Model<Api>, context: Context, options?: TzafonRequestOptions): TzafonRequestBody {
	const body: TzafonRequestBody = {
		model: model.id,
		input: convertMessages(context.messages, options?.cuaIncomingToolPlan?.tzafonComputerName),
		tools: convertTools(context.tools ?? []),
		instructions: context.systemPrompt,
		temperature: options?.temperature ?? 0,
		max_output_tokens: options?.maxTokens ?? model.maxTokens,
	};
	if (!responseThreadingEnabled(options)) return body;
	const { previousResponseId, deltaMessages } = responseThreadingDelta(context.messages, TZAFON_RESPONSES_API);
	if (!previousResponseId) return body;
	return { ...body, input: convertMessages(deltaMessages, options?.cuaIncomingToolPlan?.tzafonComputerName), previous_response_id: previousResponseId, store: true };
}

export const streamSimpleTzafonResponses: StreamFunction<typeof TZAFON_RESPONSES_API, CuaSimpleStreamOptions> = (model, context, options) => {
	return streamTzafonResponses(model, context, options);
};

export const streamTzafonResponses: StreamFunction<typeof TZAFON_RESPONSES_API, TzafonResponsesOptions> = (model, context, options) => {
	const stream = createAssistantMessageEventStream();
	const output = initialAssistantMessage(model);

	void (async () => {
		try {
			const apiKey = options?.apiKey || process.env.TZAFON_API_KEY;
			if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
			const client = new Lightcone({
				apiKey,
				baseURL: model.baseUrl,
				defaultHeaders: { ...model.headers, ...options?.headers },
			});
			const payload = buildTzafonRequestInput(model as Model<Api>, context, options);
			const nextPayload = await options?.onPayload?.(payload, model as Model<Api>);
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			const response = await client.responses.create((nextPayload ?? payload) as never, {
				signal: options?.signal,
			});
			if (options?.signal?.aborted) throw new Error("Request was aborted");

			stream.push({ type: "start", partial: output });
			output.responseId = getString(response, "id") || undefined;
			output.usage = usageFromTzafon(getValue(response, "usage"));
			for (const item of getArray(response, "output")) {
				const type = getString(item, "type");
				if (type === "message") {
					const text = extractMessageText(item);
					if (text) emitText(stream, output, text);
					continue;
				}
				if (type === "function_call") {
					emitToolCall(stream, output, {
						type: "toolCall",
						id: getString(item, "call_id"),
						name: getString(item, "name"),
						arguments: parseArguments(getValue(item, "arguments")),
					});
					continue;
				}
				if (type === "computer_call") {
					const callId = getString(item, "call_id") || getString(item, "id") || `computer_call_${output.content.length}`;
					const rawAction = getValue(item, "action");
					const canonical = toCanonicalActions(rawAction);
					for (const action of canonical) if (action.type === "answer") emitText(stream, output, action.text);
					const executable = canonical.filter((action): action is CuaAction => action.type !== "answer");
					const nativeName = options?.cuaIncomingToolPlan?.tzafonComputerName;
					const textOnlyAction = executable.find((action) => action.type !== "screenshot");
					if (nativeName && textOnlyAction) {
						throw new Error(
							`Tzafon native computer action "${textOnlyAction.type}" is unsupported: its action loop requires an automatic post-action screenshot, and CUA returns screenshots only when explicitly requested.`,
						);
					}
					if (nativeName && executable.length > 0) {
						emitToolCall(stream, output, { type: "toolCall", id: callId, name: nativeName, arguments: { action: rawAction } });
						continue;
					}
					for (let actionIndex = 0; actionIndex < executable.length; actionIndex += 1) {
						const action = executable[actionIndex]!;
						emitToolCall(stream, output, {
							type: "toolCall",
							id: tzafonToolCallId(callId, actionIndex),
							name: canonicalToolCallName(action),
							arguments: canonicalToolCallArguments(action),
						});
					}
				}
			}

			output.stopReason = output.content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (err) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = err instanceof Error ? err.message : String(err);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/** Derive a unique canonical tool-call id for a Tzafon computer action. */
export function tzafonToolCallId(callId: string, actionIndex: number): string {
	return actionIndex === 0 ? callId : `${callId}:${actionIndex}`;
}

function initialAssistantMessage(model: Model<string>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function emitText(stream: ReturnType<typeof createAssistantMessageEventStream>, output: AssistantMessage, text: string): void {
	const contentIndex = output.content.length;
	const content: TextContent = { type: "text", text };
	output.content.push(content);
	stream.push({ type: "text_start", contentIndex, partial: output });
	stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
	stream.push({ type: "text_end", contentIndex, content: text, partial: output });
}

function emitToolCall(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	output: AssistantMessage,
	toolCall: ToolCall,
): void {
	const contentIndex = output.content.length;
	output.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex, partial: output });
	stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
}

/** A canonical CUA action, or the terminal `answer` text Tzafon emits when it is done. */
export type TzafonCanonicalAction = CuaAction | { type: "answer"; text: string };

/** Normalize one Tzafon `computer_call.action` payload into canonical CUA actions. */
export function toCanonicalActions(action: unknown): TzafonCanonicalAction[] {
	if (!action || typeof action !== "object") return [];
	const current = action as Record<string, unknown>;
	const type = getString(current, "type");
	const x = readOptionalNumber(current, "x");
	const y = readOptionalNumber(current, "y");
	switch (type) {
		case "click":
		case "left_click":
			return x !== undefined && y !== undefined ? [{ type: "click", x, y }] : [];
		case "right_click":
			return x !== undefined && y !== undefined ? [{ type: "click", x, y, button: "right" }] : [];
		case "double_click":
			return x !== undefined && y !== undefined ? [{ type: "double_click", x, y }] : [];
		case "triple_click":
			return x !== undefined && y !== undefined ? [{ type: "double_click", x, y }, { type: "click", x, y }] : [];
		case "move":
		case "hover":
			return x !== undefined && y !== undefined ? [{ type: "move", x, y }] : [];
		case "drag":
			return toDragAction(current);
		case "type":
			return [{ type: "type", text: getString(current, "text") }];
		case "keypress":
		case "key":
			return toKeypressAction(current);
		case "scroll":
			return [toScrollAction(current)];
		case "hscroll":
			return [{ type: "scroll", scroll_x: readOptionalNumber(current, "scroll_x") ?? readOptionalNumber(current, "amount") ?? 0 }];
		case "navigate":
			return [{ type: "goto", url: getString(current, "url") }];
		case "wait":
			return [{ type: "wait", ms: readOptionalNumber(current, "ms") ?? secondsToMs(readOptionalNumber(current, "seconds")) }];
		case "screenshot":
			return [{ type: "screenshot" }];
		case "answer":
		case "done":
		case "terminate":
			return [{ type: "answer", text: getString(current, "result") || getString(current, "text") || getString(current, "status") }];
		default:
			return [];
	}
}

function toDragAction(action: Record<string, unknown>): CuaAction[] {
	const path = getArray(action, "path")
		.map((point) => {
			if (!point || typeof point !== "object") return undefined;
			const x = readOptionalNumber(point, "x");
			const y = readOptionalNumber(point, "y");
			return x !== undefined && y !== undefined ? { x, y } : undefined;
		})
		.filter((point): point is { x: number; y: number } => Boolean(point));
	if (path.length >= 2) return [{ type: "drag", path }];

	const x = readOptionalNumber(action, "x");
	const y = readOptionalNumber(action, "y");
	const endX = readOptionalNumber(action, "end_x") ?? readOptionalNumber(action, "x2");
	const endY = readOptionalNumber(action, "end_y") ?? readOptionalNumber(action, "y2");
	if (x === undefined || y === undefined || endX === undefined || endY === undefined) return [];
	return [{ type: "drag", path: [{ x, y }, { x: endX, y: endY }] }];
}

function toKeypressAction(action: Record<string, unknown>): CuaAction[] {
	const keys = getArray(action, "keys")
		.map((key) => (typeof key === "string" ? key : undefined))
		.filter((key): key is string => Boolean(key));
	const key = getString(action, "key");
	const text = getString(action, "text");
	const value = keys.length > 0 ? keys : key ? [key] : text ? [text] : [];
	return value.length > 0 ? [{ type: "keypress", keys: value }] : [];
}

function toScrollAction(action: Record<string, unknown>): CuaAction {
	return {
		type: "scroll",
		x: readOptionalNumber(action, "x"),
		y: readOptionalNumber(action, "y"),
		scroll_x: readOptionalNumber(action, "scroll_x"),
		scroll_y: readOptionalNumber(action, "scroll_y") ?? readOptionalNumber(action, "amount"),
	};
}

function secondsToMs(seconds: number | undefined): number | undefined {
	return seconds === undefined ? undefined : seconds * 1000;
}

function convertTools(tools: Tool[]): Array<Record<string, unknown>> {
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
}

function convertMessages(messages: readonly Message[], nativeComputerName?: string): Array<Record<string, unknown>> {
	const items: Array<Record<string, unknown>> = [];
	for (const message of messages) {
		if (message.role === "user") {
			items.push({ role: "user", content: convertUserContent(message.content) });
			continue;
		}
		if (message.role === "assistant") {
			const text = message.content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();
			if (text) items.push({ role: "assistant", content: text });
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				if (nativeComputerName && part.name === nativeComputerName) {
					items.push({ type: "computer_call", call_id: part.id, action: getValue(part.arguments, "action") });
				} else {
					items.push({
						type: "function_call",
						call_id: part.id,
						name: part.name,
						arguments: JSON.stringify(part.arguments ?? {}),
					});
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			const text = message.content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();
			const image = [...message.content].reverse().find((part): part is ImageContent => part.type === "image");
			if (nativeComputerName && message.toolName === nativeComputerName) {
				items.push({
					type: "computer_call_output",
					call_id: message.toolCallId,
					output: image
						? { type: "computer_screenshot", image_url: `data:${image.mimeType};base64,${image.data}` }
						: { type: "computer_screenshot", error: message.isError ? text || "tool execution failed" : text || "no screenshot" },
				});
				continue;
			}
			items.push({
				type: "function_call_output",
				call_id: message.toolCallId,
				output: message.isError ? `Error: ${text || "tool execution failed"}` : text || "ok",
			});
			if (image) {
				items.push({
					role: "user",
					content: [
						{ type: "input_text", text: "screenshot" },
						{ type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}`, detail: "auto" },
					],
				});
			}
		}
	}
	return items;
}

function convertUserContent(content: string | (TextContent | ImageContent)[]): unknown {
	if (typeof content === "string") return [{ type: "input_text", text: content }];
	return content.map((part) => {
		if (part.type === "text") return { type: "input_text", text: part.text };
		return { type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}`, detail: "auto" };
	});
}

function extractMessageText(item: unknown): string {
	return getArray(item, "content")
		.map((block) => getString(block, "text"))
		.filter(Boolean)
		.join("\n")
		.trim();
}

function parseArguments(value: unknown): Record<string, unknown> {
	const top =
		typeof value === "string" && value.trim()
			? safeJsonParse(value)
			: value && typeof value === "object"
				? (value as Record<string, unknown>)
				: {};
	if (!top || typeof top !== "object") return {};
	// Tzafon sometimes nests JSON-encoded arrays/objects inside the top-level argument object
	// (observed: { "actions": "[{...}]" }). Unwrap one level so consumers get real values.
	const out: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(top)) {
		out[key] = normalizeArgumentValue(key, val);
	}
	return out;
}

const NUMERIC_ARGUMENT_KEYS = new Set(["x", "y", "scroll_x", "scroll_y", "ms", "duration"]);

function normalizeArgumentValue(key: string, value: unknown): unknown {
	const parsed = typeof value === "string" && looksLikeJson(value) ? safeJsonParse(value) ?? value : value;
	if (typeof parsed === "string" && NUMERIC_ARGUMENT_KEYS.has(key)) {
		const number = Number.parseFloat(parsed);
		return Number.isFinite(number) ? number : parsed;
	}
	if (Array.isArray(parsed)) {
		return parsed.map((item) => normalizeArgumentValue(key, item));
	}
	if (parsed && typeof parsed === "object") {
		return Object.fromEntries(
			Object.entries(parsed).map(([childKey, childValue]) => [childKey, normalizeArgumentValue(childKey, childValue)]),
		);
	}
	return parsed;
}

function safeJsonParse(value: string): Record<string, unknown> | unknown[] | null {
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function looksLikeJson(value: string): boolean {
	const trimmed = value.trim();
	return trimmed.startsWith("[") || trimmed.startsWith("{");
}

function usageFromTzafon(usage: unknown): AssistantMessage["usage"] {
	const input = readUsageNumber(usage, "input_tokens");
	const output = readUsageNumber(usage, "output_tokens");
	const cacheRead = readUsageNumber(getValue(usage, "input_tokens_details"), "cached_tokens");
	const totalTokens = readUsageNumber(usage, "total_tokens") || input + output;
	return {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function readUsageNumber(obj: unknown, key: string): number {
	return readOptionalNumber(obj, key) ?? 0;
}

function readOptionalNumber(obj: unknown, key: string): number | undefined {
	if (!obj || typeof obj !== "object") return undefined;
	const value = (obj as Record<string, unknown>)[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const number = Number(value);
		return Number.isFinite(number) ? number : undefined;
	}
	return undefined;
}

function getArray(obj: unknown, key: string): unknown[] {
	const value = getValue(obj, key);
	return Array.isArray(value) ? value : [];
}

function getString(obj: unknown, key: string): string {
	const value = getValue(obj, key);
	return typeof value === "string" ? value : "";
}

function getValue(obj: unknown, key: string): unknown {
	if (!obj || typeof obj !== "object") return undefined;
	return (obj as Record<string, unknown>)[key];
}
