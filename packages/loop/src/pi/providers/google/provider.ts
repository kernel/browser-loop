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
	type ThinkingLevel,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { LoopIncomingToolPlan } from "../../../core/tool-catalog";
import {
	responseThreadingDelta,
	responseThreadingEnabled,
	type ResponseThreadingOptions,
} from "../common";

export const GOOGLE_INTERACTIONS_API = "google-interactions";

const GOOGLE_NATIVE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
	"screenshot:take_screenshot": "take_screenshot",
	"computer:screenshot": "take_screenshot",
	"custom_user_interpretation:screenshot": "take_screenshot",
	screenshot: "take_screenshot",
});

export interface GoogleInteractionsOptions extends StreamOptions, ResponseThreadingOptions {
	reasoning?: ThinkingLevel;
	/** @internal Identity-addressed native action dispatch. */
	loopIncomingToolPlan?: LoopIncomingToolPlan;
}

export const streamGoogleInteractions: StreamFunction<typeof GOOGLE_INTERACTIONS_API, GoogleInteractionsOptions> = (
	model,
	context,
	options,
) => {
	const stream = createAssistantMessageEventStream();
	void run(stream, model, context, options);
	return stream;
};

export const streamSimpleGoogleInteractions: StreamFunction<typeof GOOGLE_INTERACTIONS_API, GoogleInteractionsOptions> =
	(model, context, options) => streamGoogleInteractions(model, context, options);

async function run(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	model: Model<Api>,
	context: Context,
	options: GoogleInteractionsOptions | undefined,
): Promise<void> {
	const output = initialAssistantMessage(model);
	try {
		const apiKey = options?.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
		if (!apiKey) throw new Error("missing Google API key");
		const threading = responseThreadingEnabled(options)
			? responseThreadingDelta(context.messages, GOOGLE_INTERACTIONS_API)
			: { deltaMessages: [...context.messages] };
		let payload: Record<string, unknown> = {
			model: model.id,
			input: convertMessages(threading.deltaMessages),
			store: true,
			...(threading.previousResponseId ? { previous_interaction_id: threading.previousResponseId } : {}),
			...(context.systemPrompt ? { system_instruction: context.systemPrompt } : {}),
			generation_config: {
				max_output_tokens: options?.maxTokens ?? model.maxTokens,
				...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
				...(options?.reasoning ? { thinking_level: googleThinkingLevel(options.reasoning) } : {}),
			},
		};
		const tools = convertTools(context);
		if (tools.length > 0) payload.tools = tools;
		const transformed = await options?.onPayload?.(payload, model);
		if (transformed !== undefined) payload = transformed as Record<string, unknown>;

		const configuredBaseUrl = (model.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
		const baseUrl = configuredBaseUrl.replace(/\/v1(?:beta)?$/, "");
		const response = await fetch(`${baseUrl}/v1beta/interactions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-goog-api-key": apiKey,
				...model.headers,
				...options?.headers,
			},
			body: JSON.stringify(payload),
			signal: options?.signal,
		});
		await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
		if (!response.ok) throw new Error(`Google Interactions API ${response.status}: ${await response.text()}`);
		const interaction = await response.json() as Record<string, unknown>;

		stream.push({ type: "start", partial: output });
		output.responseId = typeof interaction.id === "string" ? interaction.id : undefined;
		output.usage = usageFromInteraction(interaction.usage);
		const contents = Array.isArray(interaction.steps)
			? interaction.steps
			: Array.isArray(interaction.outputs) ? interaction.outputs : [];
		const nativeToolNames = new Set(options?.loopIncomingToolPlan?.nativeToolNames ?? []);
		const ordinaryToolNames = new Set((context.tools ?? []).map((tool) => tool.name).filter((name) => !nativeToolNames.has(name)));
		for (const raw of contents) emitContent(stream, output, raw, options?.loopIncomingToolPlan, ordinaryToolNames);
		if (output.content.some((content) => content.type === "toolCall")) output.stopReason = "toolUse";
		if (interaction.status === "incomplete") output.stopReason = "length";
		if (interaction.status === "failed" || interaction.status === "cancelled") {
			throw new Error(`Google interaction ended with status ${String(interaction.status)}`);
		}
		stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
		stream.end();
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = error instanceof Error ? error.message : String(error);
		stream.push({ type: "error", reason: output.stopReason, error: output });
		stream.end();
	}
}

function convertMessages(messages: readonly Message[]): Array<Record<string, unknown>> {
	const steps: Array<Record<string, unknown>> = [];
	for (const message of messages) {
		if (message.role === "user") {
			steps.push({
				type: "user_input",
				content: typeof message.content === "string"
					? [{ type: "text", text: message.content }]
					: message.content.map(toInteractionContent),
			});
			continue;
		}
		if (message.role === "assistant") {
			for (const content of message.content) {
				if (content.type === "text") {
					steps.push({ type: "model_output", content: [{ type: "text", text: content.text }] });
					continue;
				}
				if (content.type === "thinking") {
					steps.push({
						type: "thought",
						summary: [{ type: "text", text: content.thinking }],
						...(content.thinkingSignature ? { signature: content.thinkingSignature } : {}),
					});
					continue;
				}
				if (content.thoughtSignature) steps.push({ type: "thought", signature: content.thoughtSignature });
				steps.push({
					type: "function_call",
					id: content.id,
					name: content.name,
					arguments: content.arguments,
				});
			}
			continue;
		}
		steps.push({
			type: "function_result",
			call_id: message.toolCallId,
			name: message.toolName,
			is_error: message.isError,
			result: message.content.map(toInteractionContent),
		});
	}
	return steps;
}

function convertTools(context: Context): Array<Record<string, unknown>> {
	return (context.tools ?? []).map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
}

function toInteractionContent(content: TextContent | ImageContent): Record<string, unknown> {
	if (content.type === "text") return { type: "text", text: content.text };
	return { type: "image", data: content.data, mime_type: content.mimeType };
}

function emitContent(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	output: AssistantMessage,
	raw: unknown,
	incoming: LoopIncomingToolPlan | undefined,
	ordinaryToolNames: ReadonlySet<string>,
): void {
	if (!isRecord(raw)) return;
	if (raw.type === "model_output" && Array.isArray(raw.content)) {
		for (const content of raw.content) emitContent(stream, output, content, incoming, ordinaryToolNames);
		return;
	}
	if (raw.type === "text" && typeof raw.text === "string") {
		const contentIndex = output.content.length;
		output.content.push({ type: "text", text: raw.text });
		stream.push({ type: "text_start", contentIndex, partial: output });
		stream.push({ type: "text_delta", contentIndex, delta: raw.text, partial: output });
		stream.push({ type: "text_end", contentIndex, content: raw.text, partial: output });
		return;
	}
	if (raw.type !== "function_call" || typeof raw.name !== "string") return;
	const arguments_ = isRecord(raw.arguments) ? raw.arguments : {};
	const contentIndex = output.content.length;
	const toolCall: ToolCall = {
		type: "toolCall",
		id: typeof raw.id === "string" ? raw.id : `google_${Date.now()}_${contentIndex}`,
		name: resolveGoogleToolName(raw.name, incoming, ordinaryToolNames),
		arguments: arguments_,
		...(typeof raw.signature === "string" ? { thoughtSignature: raw.signature } : {}),
	};
	output.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex, partial: output });
	stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(arguments_), partial: output });
	stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
}

function resolveGoogleToolName(
	name: string,
	incoming: LoopIncomingToolPlan | undefined,
	ordinaryToolNames: ReadonlySet<string>,
): string {
	// Caller function names are exact and take precedence over provider-observed
	// native aliases; never reinterpret a caller-owned declaration.
	if (ordinaryToolNames.has(name)) return name;
	const normalizedName = name.trim();
	if (ordinaryToolNames.has(normalizedName)) return normalizedName;
	const selectedName = incoming && Object.hasOwn(incoming.googleNames, normalizedName)
		? incoming.googleNames[normalizedName]
		: undefined;
	if (selectedName) return selectedName;
	const aliasTarget = GOOGLE_NATIVE_ALIASES[normalizedName];
	const selectedAlias = aliasTarget && incoming && Object.hasOwn(incoming.googleNames, aliasTarget)
		? incoming.googleNames[aliasTarget]
		: undefined;
	if (selectedAlias) return selectedAlias;

	const requestedNative = Object.values(incoming?.googleNames ?? {}).map((toolName) => `"${toolName}"`).join(", ") || "none";
	const requestedOrdinary = [...ordinaryToolNames].map((toolName) => `"${toolName}"`).join(", ") || "none";
	const alias = aliasTarget ? ` (alias of "${aliasTarget}")` : "";
	throw new Error(
		`Google exact tool catalog rejected function "${name}"${alias}; selected Google native tools: ${requestedNative}; ordinary function tools: ${requestedOrdinary}`,
	);
}

function initialAssistantMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function usageFromInteraction(value: unknown): AssistantMessage["usage"] {
	if (!isRecord(value)) return emptyUsage();
	const input = numeric(value.input_tokens ?? value.prompt_token_count);
	const output = numeric(value.output_tokens ?? value.candidates_token_count);
	return {
		input,
		output,
		cacheRead: numeric(value.cached_input_tokens),
		cacheWrite: 0,
		totalTokens: numeric(value.total_tokens) || input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function emptyUsage(): AssistantMessage["usage"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function googleThinkingLevel(level: ThinkingLevel): "minimal" | "low" | "medium" | "high" {
	return level === "xhigh" || level === "max" ? "high" : level;
}

function numeric(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function headersToRecord(headers: Headers): Record<string, string> {
	return Object.fromEntries(headers.entries());
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
