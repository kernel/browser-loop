import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Context,
	type ImageContent,
	type Model,
	type SimpleStreamOptions,
	type StreamFunction,
	type StreamOptions,
	type TextContent,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { CuaIncomingToolPlan } from "../../tool-catalog";

export const YUTORI_CHAT_COMPLETIONS_API = "yutori-chat-completions";

/** Stream options accepted by {@link streamYutori}. */
export interface YutoriOptions extends StreamOptions {
	/** @internal Identity-addressed native dispatch compiled from selected tools. */
	cuaIncomingToolPlan?: CuaIncomingToolPlan;
}

export const streamYutori: StreamFunction<typeof YUTORI_CHAT_COMPLETIONS_API, YutoriOptions> = (model, context, options) => {
	const stream = createAssistantMessageEventStream();
	void runYutoriStream(stream, model, context, options);
	return stream;
};

export const streamSimpleYutori: StreamFunction<typeof YUTORI_CHAT_COMPLETIONS_API, SimpleStreamOptions> = (
	model,
	context,
	options,
) => streamYutori(model, context, options);

async function runYutoriStream(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	model: Model<Api>,
	context: Context,
	options: YutoriOptions | undefined,
): Promise<void> {
	const output = initialAssistantMessage(model);
	try {
		const apiKey = options?.apiKey || process.env.YUTORI_API_KEY;
		if (!apiKey) throw new Error("missing Yutori API key");
		const client = new OpenAI({
			apiKey,
			baseURL: model.baseUrl || "https://api.yutori.com/v1",
			defaultHeaders: { ...model.headers, ...options?.headers },
		});
		let payload: Record<string, unknown> = {
			model: model.id,
			messages: convertMessages(context),
			max_completion_tokens: options?.maxTokens ?? model.maxTokens,
			temperature: options?.temperature ?? 0.3,
		};
		const tools = convertTools(context);
		if (tools.length > 0) payload.tools = tools;
		const nextPayload = await options?.onPayload?.(payload, model);
		if (nextPayload !== undefined) payload = nextPayload as Record<string, unknown>;

		const { data: response, response: rawResponse } = await client.chat.completions
			.create(payload as unknown as Parameters<typeof client.chat.completions.create>[0], { signal: options?.signal })
			.withResponse();
		const completion = response as ChatCompletion;
		await options?.onResponse?.({ status: rawResponse.status, headers: headersToRecord(rawResponse.headers) }, model);

		stream.push({ type: "start", partial: output });
		const choice = completion.choices?.[0];
		const message = choice?.message;
		output.responseId = completion.id;
		output.usage = usageFromYutori(completion.usage);
		if (choice?.finish_reason === "tool_calls") output.stopReason = "toolUse";
		else if (choice?.finish_reason === "length") output.stopReason = "length";

		const text = typeof message?.content === "string" ? message.content : "";
		if (text) emitText(stream, output, text);

		for (const call of message?.tool_calls ?? []) {
			if (call.type !== "function") continue;
			const args = parseArguments(call.function.arguments);
			const selectedName = options?.cuaIncomingToolPlan?.yutoriNames[call.function.name];
			const contentIndex = output.content.length;
			const toolCall: ToolCall = {
				type: "toolCall",
				id: call.id,
				name: selectedName ?? call.function.name,
				arguments: args,
			};
			output.content.push(toolCall);
			output.stopReason = "toolUse";
			stream.push({ type: "toolcall_start", contentIndex, partial: output });
			stream.push({ type: "toolcall_delta", contentIndex, delta: call.function.arguments ?? "", partial: output });
			stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
		}

		stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
		stream.end();
	} catch (err) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = err instanceof Error ? err.message : String(err);
		stream.push({ type: "error", reason: output.stopReason, error: output });
		stream.end();
	}
}

function initialAssistantMessage(model: Model<Api>): AssistantMessage {
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

function convertMessages(context: Context): ChatCompletionMessageParam[] {
	const messages: ChatCompletionMessageParam[] = [];
	if (context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });
	for (const message of context.messages) {
		if (message.role === "user") {
			messages.push({
				role: "user",
				content: typeof message.content === "string" ? message.content : message.content.map(toOpenAIContentPart),
			} as ChatCompletionMessageParam);
		} else if (message.role === "assistant") {
			const text = message.content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("");
			const toolCalls = message.content
				.filter((part): part is ToolCall => part.type === "toolCall")
				.map((part) => ({
					id: part.id,
					type: "function" as const,
					function: { name: part.name, arguments: JSON.stringify(part.arguments ?? {}) },
				}));
			messages.push({
				role: "assistant",
				content: text || null,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
		} else if (message.role === "toolResult") {
			messages.push({
				role: "tool",
				tool_call_id: message.toolCallId,
				content: message.content.map(toOpenAIContentPart) as unknown as string,
			});
		}
	}
	return messages;
}

function convertTools(context: Context): Array<Record<string, unknown>> {
	return (context.tools ?? []).map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

function emitText(stream: ReturnType<typeof createAssistantMessageEventStream>, output: AssistantMessage, text: string): void {
	const contentIndex = output.content.length;
	const content: TextContent = { type: "text", text };
	output.content.push(content);
	stream.push({ type: "text_start", contentIndex, partial: output });
	stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
	stream.push({ type: "text_end", contentIndex, content: text, partial: output });
}

function toOpenAIContentPart(part: TextContent | ImageContent): Record<string, unknown> {
	if (part.type === "text") return { type: "text", text: part.text };
	return { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } };
}

// Degrade malformed tool-call arguments to {} so one bad call cannot turn the
// whole response into a stopReason "error" turn (mirrors the Tzafon provider).
function parseArguments(value: string | undefined): Record<string, unknown> {
	if (!value?.trim()) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function usageFromYutori(usage: unknown): AssistantMessage["usage"] {
	const input = readNumber(usage, "prompt_tokens");
	const output = readNumber(usage, "completion_tokens");
	const totalTokens = readNumber(usage, "total_tokens") || input + output;
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function readNumber(value: unknown, key: string): number {
	if (!value || typeof value !== "object") return 0;
	const n = (value as Record<string, unknown>)[key];
	return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function headersToRecord(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => {
		out[key] = value;
	});
	return out;
}
