import OpenAI from "openai";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import {
	clampThinkingLevel,
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	type ImageContent,
	type Model,
	type OpenAIResponsesOptions as PiOpenAIResponsesOptions,
	type StreamFunction,
	type TextContent,
	type Tool,
	type ToolCall,
} from "@earendil-works/pi-ai";
import {
	convertResponsesMessages,
	convertResponsesTools,
	processResponsesStream,
} from "@earendil-works/pi-ai/api/openai-responses-shared";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import type { LoopIncomingToolPlan } from "../../../core/tool-catalog";
import type { LoopSimpleStreamOptions } from "../common";

/** Loop-owned api id for OpenAI's native computer tool, derived onto the model by compileLoopToolCatalog when that tool is selected. */
export const OPENAI_COMPUTER_USE_API = "openai-computer-use";

/**
 * 64x64 black PNG, used when a computer action produced no screenshot so the
 * `computer_screenshot` output stays valid. A 1x1 image is rejected by the
 * Responses API even though the vision endpoint accepts it.
 */
const BLANK_SCREENSHOT_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAIklEQVR4nO3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAA8G4wQAABiwCo9wAAAABJRU5ErkJggg==";

export interface OpenAIResponsesOptions extends PiOpenAIResponsesOptions {
	/** @internal Identity-addressed native dispatch compiled from selected tools. */
	loopIncomingToolPlan?: LoopIncomingToolPlan;
}

/** The request fields both the function-tool and native-computer paths read, whichever option shape the caller passed. */
type OpenAIRequestOptions = Pick<OpenAIResponsesOptions, "apiKey" | "cacheRetention" | "env" | "headers" | "sessionId">;

/**
 * The one dispatch the OpenAI provider wrapper cannot derive from the
 * model's `api`: whether the transcript carries state (a deferred tool-search
 * addition, or a replayed function-call namespace) that only this adapter
 * round-trips, because pi-ai's builtin `openai-responses` transport does not
 * parse or replay `function_call`'s `namespace` field. Every other dispatch —
 * including OpenAI's native computer tool — is decided by `model.api` instead.
 */
export function requiresOpenAINamespaceAdapter(context: Context): boolean {
	for (const message of context.messages) {
		if (message.role === "toolResult" && (message.addedToolNames?.length ?? 0) > 0) return true;
		if (message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && toolCallNamespace(part))) return true;
	}
	return false;
}

export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (model, context, options) =>
	streamOpenAIFunctionTools(model, context, options);

export const streamSimpleOpenAIResponses: StreamFunction<"openai-responses", LoopSimpleStreamOptions> = (model, context, options) => {
	const base = buildBaseOptions(model, context, options, options?.apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	return streamOpenAIFunctionTools(model, context, {
		...base,
		reasoningEffort: clampedReasoning === "off" ? undefined : clampedReasoning,
		loopIncomingToolPlan: options?.loopIncomingToolPlan,
	});
};

/**
 * Pi-ai 0.83.0's Responses fallback still omits function-call namespaces in
 * both stream parsing and transcript replay. Keep using its conversion/stream
 * machinery, but own the SDK boundary so the namespace survives both.
 */
function streamOpenAIFunctionTools(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
) {
	const stream = createAssistantMessageEventStream();
	const output = initialAssistantMessage(model);
	void (async () => {
		try {
			const apiKey = openAIApiKey(options);
			const placement = splitDeferredTools(context, model.compat?.supportsToolSearch === true);
			const grammarToolInputProperties = createGrammarToolInputProperties(context.tools, model.compat?.supportsOpenAIGrammarTools === true);
			let payload = buildFunctionPayload(model, context, options, placement, grammarToolInputProperties);
			payload = ((await options?.onPayload?.(payload, model)) ?? payload) as Record<string, unknown>;
			const client = createOpenAIClient(model, options, apiKey);
			const request = client.responses.create(payload as never, {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: options?.maxRetries ?? 0,
			});
			const { data, response } = await request.withResponse();
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

			const namespaces = new Map<string, string>();
			const namespaceStream = {
				push(event: AssistantMessageEvent) {
					applyToolCallNamespaces(output, namespaces);
					stream.push(event);
				},
			} as unknown as ReturnType<typeof createAssistantMessageEventStream>;
			stream.push({ type: "start", partial: output });
			await processResponsesStream(
				captureResponseNamespaces(data as unknown as AsyncIterable<ResponseStreamEvent>, namespaces),
				output,
				namespaceStream,
				model,
				{
					serviceTier: options?.serviceTier,
					applyServiceTierPricing: (usage, tier) => applyServiceTierPricing(usage, tier, model),
					grammarToolInputProperties,
				},
			);
			applyToolCallNamespaces(output, namespaces);
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "error" || output.stopReason === "aborted") throw new Error("OpenAI response ended unsuccessfully");
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end(output);
		} catch (error) {
			for (const block of output.content) delete (block as ToolCall & { partialJson?: string }).partialJson;
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end(output);
		}
	})();
	return stream;
}

function buildFunctionPayload(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
	placement: { immediate: Tool[]; deferred: Map<string, Tool> },
	grammarToolInputProperties: ReadonlyMap<string, string>,
): Record<string, unknown> {
	const compat = model.compat;
	const toolOptions = { supportsStrictMode: compat?.supportsStrictMode, supportsOpenAIGrammarTools: compat?.supportsOpenAIGrammarTools };
	const input = convertResponsesMessages(model, context, new Set(["openai"]), {
		deferredTools: placement.deferred,
		toolOptions,
		grammarToolInputProperties,
	});
	applyTranscriptNamespaces(input as unknown as Array<Record<string, unknown>>, context.messages);
	const payload: Record<string, unknown> = {
		model: model.id,
		input,
		stream: true,
		...promptCacheFields(model, options),
		store: false,
	};
	if (options?.maxTokens) payload.max_output_tokens = Math.max(options.maxTokens, 16);
	if (options?.temperature !== undefined) payload.temperature = options.temperature;
	if (options?.serviceTier !== undefined) payload.service_tier = options.serviceTier;
	if (placement.immediate.length > 0) payload.tools = convertResponsesTools(placement.immediate, toolOptions);
	if (options?.toolChoice !== undefined) payload.tool_choice = options.toolChoice;
	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			const effort = options.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: "medium";
			payload.reasoning = { effort, summary: options.reasoningSummary || "auto" };
			payload.include = ["reasoning.encrypted_content"];
		} else if (model.thinkingLevelMap?.off !== null) {
			payload.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
		}
	}
	return payload;
}

/** Prompt-cache request fields, matching what pi's builtin Responses transport sends. */
function promptCacheFields(model: Model<"openai-responses">, options: OpenAIRequestOptions | undefined): Record<string, unknown> {
	const compat = model.compat;
	const retention = cacheRetention(options);
	return {
		prompt_cache_key: retention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: retention === "long" && compat?.supportsLongCacheRetention !== false ? "24h" : undefined,
		prompt_cache_options: retention === "none" && compat?.supportsExplicitPromptCacheMode ? { mode: "explicit" } : undefined,
	};
}

function createOpenAIClient(
	model: Model<"openai-responses">,
	options: OpenAIRequestOptions | undefined,
	apiKey: string,
): OpenAI {
	const headers: Record<string, string | null> = { ...model.headers, ...options?.headers };
	if (cacheRetention(options) !== "none" && options?.sessionId) {
		headers.session_id = options.sessionId;
		headers["x-client-request-id"] = options.sessionId;
	}
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl || "https://api.openai.com/v1",
		defaultHeaders: headers,
	});
}

function openAIApiKey(options: OpenAIRequestOptions | undefined): string {
	const apiKey = options?.apiKey || options?.env?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
	if (apiKey) return apiKey;
	const hasAuthorization = Object.entries(options?.headers ?? {}).some(([name, value]) =>
		(name.toLowerCase() === "authorization" || name.toLowerCase() === "cf-aig-authorization") && typeof value === "string" && value.trim(),
	);
	if (hasAuthorization) return "unused";
	throw new Error("No API key for provider: openai");
}

function cacheRetention(options: OpenAIRequestOptions | undefined): "none" | "short" | "long" {
	if (options?.cacheRetention) return options.cacheRetention;
	return (options?.env?.PI_CACHE_RETENTION ?? process.env.PI_CACHE_RETENTION) === "long" ? "long" : "short";
}

function applyTranscriptNamespaces(input: Array<Record<string, unknown>>, messages: readonly Context["messages"][number][]): void {
	const namespaces = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			const namespace = toolCallNamespace(part);
			if (!namespace) continue;
			const callId = part.id.split("|", 1)[0]!;
			namespaces.set(callId, namespace);
		}
	}
	for (const item of input) {
		if (item.type !== "function_call" || typeof item.call_id !== "string") continue;
		const namespace = namespaces.get(item.call_id);
		if (namespace) item.namespace = namespace;
	}
}

async function* captureResponseNamespaces(
	events: AsyncIterable<ResponseStreamEvent>,
	namespaces: Map<string, string>,
): AsyncIterable<ResponseStreamEvent> {
	for await (const event of events) {
		if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
			captureResponseItemNamespace(event.item, namespaces);
		} else if (event.type === "response.completed" || event.type === "response.incomplete") {
			for (const item of event.response.output ?? []) captureResponseItemNamespace(item, namespaces);
		}
		yield event;
	}
}

function captureResponseItemNamespace(item: unknown, namespaces: Map<string, string>): void {
	if (!item || typeof item !== "object") return;
	const call = item as { type?: unknown; call_id?: unknown; namespace?: unknown };
	if (call.type === "function_call" && typeof call.call_id === "string" && typeof call.namespace === "string" && call.namespace) {
		namespaces.set(call.call_id, call.namespace);
	}
}

function applyToolCallNamespaces(output: AssistantMessage, namespaces: ReadonlyMap<string, string>): void {
	for (const part of output.content) {
		if (part.type !== "toolCall") continue;
		const namespace = namespaces.get(part.id.split("|", 1)[0]!);
		if (namespace) (part as ToolCall & { namespace?: string }).namespace = namespace;
	}
}

function toolCallNamespace(call: ToolCall | undefined): string | undefined {
	const namespace = (call as ToolCall & { namespace?: unknown } | undefined)?.namespace;
	return typeof namespace === "string" && namespace ? namespace : undefined;
}

function applyServiceTierPricing(
	usage: AssistantMessage["usage"],
	serviceTier: OpenAIResponsesOptions["serviceTier"],
	model: Model<"openai-responses">,
): void {
	const multiplier = serviceTier === "flex" ? 0.5 : serviceTier === "priority" ? (model.id === "gpt-5.5" ? 2.5 : 2) : 1;
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

/** Responses adapter for models the catalog compiled onto {@link OPENAI_COMPUTER_USE_API}, i.e. those whose selected tools include OpenAI's native computer. */
export const streamOpenAIComputerUse: StreamFunction<typeof OPENAI_COMPUTER_USE_API, OpenAIResponsesOptions | LoopSimpleStreamOptions> = (model, context, options) =>
	streamOpenAINativeComputer(model as unknown as Model<"openai-responses">, context, options);

function streamOpenAINativeComputer(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | LoopSimpleStreamOptions | undefined,
) {
	const stream = createAssistantMessageEventStream();
	const output = initialAssistantMessage(model);
	void (async () => {
		try {
			const apiKey = openAIApiKey(options);
			const nativeName = options?.loopIncomingToolPlan?.openaiComputerName;
			if (!nativeName) throw new Error("OpenAI native computer incoming plan is missing");
			const placement = splitDeferredTools(context);
			let payload: Record<string, unknown> = {
				model: model.id,
				instructions: context.systemPrompt,
				input: convertMessages(context.messages, nativeName, placement.deferred),
				tools: convertTools(placement.immediate),
				max_output_tokens: options?.maxTokens ?? model.maxTokens,
				...promptCacheFields(model, options),
				store: false,
			};
			payload = ((await options?.onPayload?.(payload, model)) ?? payload) as Record<string, unknown>;
			const client = createOpenAIClient(model, options, apiKey);
			const request = client.responses.create(payload as never, { signal: options?.signal });
			const { data: response, response: rawResponse } = await request.withResponse();
			await options?.onResponse?.({ status: rawResponse.status, headers: headersToRecord(rawResponse.headers) }, model);
			if (options?.signal?.aborted) throw new Error("Request was aborted");

			output.responseId = readString(response, "id") || undefined;
			output.usage = usageFromResponse(readValue(response, "usage"));
			stream.push({ type: "start", partial: output });
			for (const item of readArray(response, "output")) {
				const type = readString(item, "type");
				if (type === "message") {
					for (const block of readArray(item, "content")) {
						const text = readString(block, "text");
						if (text) emitText(stream, output, text);
					}
					continue;
				}
				if (type === "function_call") {
					const namespace = readString(item, "namespace");
					emitToolCall(stream, output, {
						type: "toolCall",
						id: readString(item, "call_id") || readString(item, "id"),
						name: readString(item, "name"),
						arguments: parseArguments(readValue(item, "arguments")),
						...(namespace ? { namespace } : {}),
					} as ToolCall);
					continue;
				}
				if (type === "computer_call") {
					const action = readValue(item, "action");
					const actions = readArray(item, "actions");
					const pendingSafetyChecks = readArray(item, "pending_safety_checks");
					emitToolCall(stream, output, {
						type: "toolCall",
						id: readString(item, "call_id") || readString(item, "id"),
						name: nativeName,
						arguments: {
							...(actions.length > 0 ? { actions } : { action }),
							...(pendingSafetyChecks.length > 0 ? { pending_safety_checks: pendingSafetyChecks } : {}),
						},
					});
				}
			}
			output.stopReason = output.content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end(output);
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end(output);
		}
	})();
	return stream;
}

function splitDeferredTools(context: Context, enabled = true): { immediate: Tool[]; deferred: Map<string, Tool> } {
	const uniqueTools = new Map((context.tools ?? []).map((tool) => [tool.name, tool]));
	if (!enabled) return { immediate: [...uniqueTools.values()], deferred: new Map() };
	const deferredNames = new Set<string>();
	const usedNames = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") usedNames.add(block.name);
		} else if (message.role === "toolResult") {
			for (const name of message.addedToolNames ?? []) if (!usedNames.has(name)) deferredNames.add(name);
		}
	}
	const immediate: Tool[] = [];
	const deferred = new Map<string, Tool>();
	for (const [name, tool] of uniqueTools) {
		if (deferredNames.has(name)) deferred.set(name, tool);
		else immediate.push(tool);
	}
	return { immediate, deferred };
}

function convertMessages(messages: readonly Context["messages"][number][], nativeName: string, deferred: ReadonlyMap<string, Tool>): Record<string, unknown>[] {
	const input: Record<string, unknown>[] = [];
	const loaded = new Set<string>();
	for (const message of messages) {
		if (message.role === "user") {
			input.push({ role: "user", content: convertUserContent(message.content) });
			continue;
		}
		if (message.role === "assistant") {
			const text = message.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("\n");
			// Responses accepts only `output_text` (or `refusal`) on an assistant
			// input item; `input_text` is rejected outright, so replaying a prior
			// assistant reply this way 400s every request after the first turn.
			if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				if (part.name === nativeName) {
					input.push({
						type: "computer_call",
						call_id: part.id,
						...(Array.isArray(part.arguments.actions) ? { actions: part.arguments.actions } : { action: part.arguments.action }),
						...(Array.isArray(part.arguments.pending_safety_checks) ? { pending_safety_checks: part.arguments.pending_safety_checks } : {}),
					});
				} else {
					const namespace = toolCallNamespace(part);
					input.push({
						type: "function_call",
						call_id: part.id,
						name: part.name,
						arguments: JSON.stringify(part.arguments ?? {}),
						...(namespace ? { namespace } : {}),
					});
				}
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const text = message.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("\n").trim();
		if (message.toolName === nativeName) {
			const image = [...message.content].reverse().find((part): part is ImageContent => part.type === "image");
			input.push({
				type: "computer_call_output",
				call_id: message.toolCallId,
				// `computer_screenshot` accepts image_url or file_id and nothing else.
				// An earlier version put the failure text in an `error` key here, which
				// the Responses API rejects outright — `400 Unknown parameter:
				// 'input[N].output.error'` — so one screenshot-less action poisoned every
				// later request in the conversation. A blank screenshot keeps the item
				// valid; the text follows as a user message so the model still learns
				// what happened.
				output: {
					type: "computer_screenshot",
					image_url: image ? `data:${image.mimeType};base64,${image.data}` : BLANK_SCREENSHOT_DATA_URL,
				},
				...(acknowledgedSafetyChecks(messages, message.toolCallId).length
					? { acknowledged_safety_checks: acknowledgedSafetyChecks(messages, message.toolCallId) }
					: {}),
			});
			if (!image) {
				const detail = text || (message.isError ? "tool execution failed" : "no screenshot was captured");
				input.push({
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: `[computer action produced no screenshot] ${detail}` }],
				});
			}
		} else {
			input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.isError ? `Error: ${text}` : text || "ok" });
		}
		const added = (message.addedToolNames ?? []).flatMap((name) => {
			const tool = deferred.get(name);
			if (!tool || loaded.has(name)) return [];
			loaded.add(name);
			return [tool];
		});
		if (added.length > 0) {
			const callId = `loop_tool_load_${message.toolCallId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
			input.push({ type: "tool_search_call", call_id: callId, execution: "client", status: "completed", arguments: { query: added.map((tool) => tool.name).join(" "), limit: added.length } });
			input.push({ type: "tool_search_output", call_id: callId, execution: "client", status: "completed", tools: convertTools(added, true) });
		}
	}
	return input;
}

function acknowledgedSafetyChecks(messages: readonly Context["messages"][number][], toolCallId: string): unknown[] {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]!;
		if (message.role !== "assistant") continue;
		const call = message.content.find((part) => part.type === "toolCall" && part.id === toolCallId);
		if (call?.type === "toolCall" && Array.isArray(call.arguments.pending_safety_checks)) return call.arguments.pending_safety_checks;
	}
	return [];
}

function convertTools(tools: readonly Tool[], deferLoading = false): Record<string, unknown>[] {
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(deferLoading ? { defer_loading: true } : {}),
	}));
}

function convertUserContent(content: string | Array<TextContent | ImageContent>): Array<Record<string, unknown>> {
	if (typeof content === "string") return [{ type: "input_text", text: content }];
	return content.map((part) => part.type === "text"
		? { type: "input_text", text: part.text }
		: { type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}`, detail: "auto" });
}

function parseArguments(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== "string" || !value.trim()) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function initialAssistantMessage(model: Model<string>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function emitText(stream: ReturnType<typeof createAssistantMessageEventStream>, output: AssistantMessage, text: string): void {
	const contentIndex = output.content.length;
	output.content.push({ type: "text", text });
	stream.push({ type: "text_start", contentIndex, partial: output });
	stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
	stream.push({ type: "text_end", contentIndex, content: text, partial: output });
}

function emitToolCall(stream: ReturnType<typeof createAssistantMessageEventStream>, output: AssistantMessage, call: ToolCall): void {
	const contentIndex = output.content.length;
	output.content.push(call);
	stream.push({ type: "toolcall_start", contentIndex, partial: output });
	stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: output });
}

function usageFromResponse(usage: unknown): AssistantMessage["usage"] {
	const input = readNumber(usage, "input_tokens");
	const output = readNumber(usage, "output_tokens");
	const cacheRead = readNumber(readValue(usage, "input_tokens_details"), "cached_tokens");
	return {
		input: Math.max(0, input - cacheRead),
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function headersToRecord(headers: Headers): Record<string, string> {
	const output: Record<string, string> = {};
	headers.forEach((value, key) => { output[key] = value; });
	return output;
}

function readArray(value: unknown, key: string): unknown[] {
	const entry = readValue(value, key);
	return Array.isArray(entry) ? entry : [];
}

function readString(value: unknown, key: string): string {
	const entry = readValue(value, key);
	return typeof entry === "string" ? entry : "";
}

function readNumber(value: unknown, key: string): number {
	const entry = readValue(value, key);
	return typeof entry === "number" && Number.isFinite(entry) ? entry : 0;
}

function readValue(value: unknown, key: string): unknown {
	return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}
