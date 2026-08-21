import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type FetchFunction,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type StreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { BrowserState } from "../../../core/translator/types";
import type { LoopSimpleStreamOptions } from "../common";

type AnthropicToolsetName = "computer" | "browser";

// pi-ai currently drops `toolset_name`. Encode it into the streamed tool name
// before pi-ai parses the event, then restore the local tool name and action.
const ENCODED_MEMBER_PREFIX = "loop_anthropic_toolset_";
const TAB_MEMBERS = new Set(["new_tab", "list_tabs", "switch_tab", "close_tab"]);

/** Adapt pi-ai's function-tool transcript to Anthropic's GA client-toolset protocol. */
export function withAnthropicToolsets(base: Provider): Provider {
	return {
		...base,
		stream: (model, context, options) => streamWithToolsets(
			base.stream.bind(base),
			model,
			context,
			options as LoopSimpleStreamOptions | undefined,
		),
		streamSimple: (model, context, options) => streamWithToolsets(
			base.streamSimple.bind(base),
			model,
			context,
			options as LoopSimpleStreamOptions | undefined,
		),
	};
}

type StartStream = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions | SimpleStreamOptions,
) => AssistantMessageEventStream;

function streamWithToolsets(
	start: StartStream,
	model: Model<Api>,
	context: Context,
	options: LoopSimpleStreamOptions | undefined,
): AssistantMessageEventStream {
	const toolsets = options?.loopIncomingToolPlan?.anthropicToolsets ?? [];
	if (toolsets.length === 0) return start(model, context, options);
	if ((options as StreamOptions & { client?: unknown } | undefined)?.client) {
		throw new Error("Anthropic client toolsets require the provider fetch transport; a custom Anthropic client is not supported");
	}
	const selected = new Set(toolsets);
	const fetch = createToolsetFetch(options?.fetch ?? globalThis.fetch, selected, browserStates(context));
	const source = start(model, context, { ...options, fetch });
	const output = createAssistantMessageEventStream();
	void relayToolsetEvents(output, source, model);
	return output;
}

async function relayToolsetEvents(
	output: AssistantMessageEventStream,
	source: AssistantMessageEventStream,
	model: Model<Api>,
): Promise<void> {
	let terminal: AssistantMessage | undefined;
	const members = new Map<string, { toolset: AnthropicToolsetName; member: string }>();
	try {
		for await (const event of source) {
			normalizeEvent(event, members);
			output.push(event);
			terminal = terminalMessage(event) ?? terminal;
		}
		const result = terminal ?? await source.result();
		normalizeMessage(result, members);
		output.end(result);
	} catch (error) {
		const message = failureMessage(model, error);
		output.push({ type: "error", reason: "error", error: message });
		output.end(message);
	}
}

function normalizeEvent(
	event: AssistantMessageEvent,
	members: Map<string, { toolset: AnthropicToolsetName; member: string }>,
): void {
	if ("partial" in event) normalizeMessage(event.partial, members);
	if (event.type === "toolcall_end") normalizeToolCall(event.toolCall, members);
	if (event.type === "done") normalizeMessage(event.message, members);
	if (event.type === "error") normalizeMessage(event.error, members);
}

function normalizeMessage(
	message: AssistantMessage,
	members: Map<string, { toolset: AnthropicToolsetName; member: string }>,
): void {
	for (const block of message.content) if (block.type === "toolCall") normalizeToolCall(block, members);
}

function normalizeToolCall(
	call: ToolCall,
	members: Map<string, { toolset: AnthropicToolsetName; member: string }>,
): void {
	const decoded = decodeMemberName(call.name) ?? members.get(call.id);
	if (!decoded) return;
	members.set(call.id, decoded);
	call.name = decoded.toolset;
	call.arguments = { action: decoded.member, ...call.arguments };
}

function terminalMessage(event: AssistantMessageEvent): AssistantMessage | undefined {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return undefined;
}

function createToolsetFetch(
	base: FetchFunction,
	selected: ReadonlySet<AnthropicToolsetName>,
	states: ReadonlyMap<string, BrowserState>,
): FetchFunction {
	return async (input, init) => {
		let nextInit = init;
		if (typeof init?.body === "string") {
			const payload: unknown = JSON.parse(init.body);
			const rewritten = rewriteAnthropicToolsetPayload(payload, selected, states);
			nextInit = { ...init, body: JSON.stringify(rewritten) };
		}
		const response = await base(input, nextInit);
		if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
		return rewriteSseResponse(response, selected);
	};
}

/** @internal Exported for protocol-focused tests. */
export function rewriteAnthropicToolsetPayload(
	payload: unknown,
	selected: ReadonlySet<AnthropicToolsetName>,
	states: ReadonlyMap<string, BrowserState> = new Map(),
): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;
	const calls = new Map<string, { toolset: AnthropicToolsetName; member: string }>();
	const messages = payload.messages.map((message) => {
		if (!isRecord(message) || !Array.isArray(message.content)) return message;
		if (message.role === "assistant") {
			return {
				...message,
				content: message.content.map((block) => {
					if (!isRecord(block) || block.type !== "tool_use" || typeof block.id !== "string") return block;
					if (!isToolsetName(block.name) || !selected.has(block.name) || !isRecord(block.input)) return block;
					const member = block.input.action;
					if (typeof member !== "string" || !member) return block;
					const { action: _action, ...input } = block.input;
					calls.set(block.id, { toolset: block.name, member });
					return { ...block, name: member, toolset_name: block.name, input };
				}),
			};
		}
		if (message.role === "user") {
			return {
				...message,
				content: message.content.map((block) => {
					if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") return block;
					const call = calls.get(block.tool_use_id);
					if (!call) return block;
					const needsState = call.toolset === "browser" && TAB_MEMBERS.has(call.member) && block.is_error !== true;
					const state = needsState ? states.get(block.tool_use_id) : undefined;
					if (needsState && !state) {
						throw new Error(`successful Anthropic browser member "${call.member}" is missing browser_state execution details`);
					}
					return {
						...block,
						toolset_name: call.toolset,
						...(state ? { content: [{ type: "browser_state", ...state }] } : {}),
					};
				}),
			};
		}
		return message;
	});
	return { ...payload, messages };
}

function rewriteSseResponse(response: Response, selected: ReadonlySet<AnthropicToolsetName>): Response {
	const body = response.body;
	if (!body) return response;
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffered = "";
	const transform = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			buffered += decoder.decode(chunk, { stream: true });
			let newline = buffered.indexOf("\n");
			while (newline >= 0) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				controller.enqueue(encoder.encode(`${rewriteAnthropicToolsetSseLine(line, selected)}\n`));
				newline = buffered.indexOf("\n");
			}
		},
		flush(controller) {
			buffered += decoder.decode();
			if (buffered) controller.enqueue(encoder.encode(rewriteAnthropicToolsetSseLine(buffered, selected)));
		},
	});
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	return new Response(body.pipeThrough(transform), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/** @internal Exported for protocol-focused tests. */
export function rewriteAnthropicToolsetSseLine(
	line: string,
	selected: ReadonlySet<AnthropicToolsetName>,
): string {
	const carriageReturn = line.endsWith("\r") ? "\r" : "";
	const source = carriageReturn ? line.slice(0, -1) : line;
	if (!source.startsWith("data:")) return line;
	const separator = source.startsWith("data: ") ? "data: " : "data:";
	try {
		const event: unknown = JSON.parse(source.slice(separator.length));
		if (!isRecord(event) || event.type !== "content_block_start" || !isRecord(event.content_block)) return line;
		const block = event.content_block;
		if (block.type !== "tool_use" || !isToolsetName(block.toolset_name) || !selected.has(block.toolset_name)) return line;
		if (typeof block.name !== "string") return line;
		return `${separator}${JSON.stringify({
			...event,
			content_block: { ...block, name: encodeMemberName(block.toolset_name, block.name) },
		})}${carriageReturn}`;
	} catch {
		return line;
	}
}

function browserStates(context: Context): Map<string, BrowserState> {
	const result = new Map<string, BrowserState>();
	for (const message of context.messages) {
		if (message.role !== "toolResult" || !isRecord(message.details)) continue;
		const reads = message.details.readResults;
		if (!Array.isArray(reads)) continue;
		const state = reads.find((read) => isRecord(read) && read.type === "browser_state" && isRecord(read.state));
		if (isRecord(state) && isBrowserState(state.state)) result.set(message.toolCallId, state.state);
	}
	return result;
}

function isBrowserState(value: unknown): value is BrowserState {
	return isRecord(value) && Array.isArray(value.tabs);
}

function encodeMemberName(toolset: AnthropicToolsetName, member: string): string {
	return `${ENCODED_MEMBER_PREFIX}${toolset}__${member}`;
}

function decodeMemberName(name: string): { toolset: AnthropicToolsetName; member: string } | undefined {
	if (!name.startsWith(ENCODED_MEMBER_PREFIX)) return undefined;
	const value = name.slice(ENCODED_MEMBER_PREFIX.length);
	const separator = value.indexOf("__");
	if (separator <= 0) return undefined;
	const toolset = value.slice(0, separator);
	const member = value.slice(separator + 2);
	return isToolsetName(toolset) && member ? { toolset, member } : undefined;
}

function isToolsetName(value: unknown): value is AnthropicToolsetName {
	return value === "computer" || value === "browser";
}

function failureMessage(model: Model<Api>, error: unknown): AssistantMessage {
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
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
