import { createHash } from "node:crypto";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import type { CuaAnthropicBrowserFallback } from "../../tool-catalog";
import type { CuaSimpleStreamOptions } from "../common";

const supportedCredentials = new Set<string>();
const unsupportedCredentials = new Set<string>();

/** Add transparent function-tool fallback when a credential cannot use Anthropic's native browser beta. */
export function withAnthropicBrowserFallback(base: Provider): Provider {
	return {
		...base,
		stream: (model, context, options) => streamWithFallback(
			base.stream.bind(base),
			model,
			context,
			options as CuaSimpleStreamOptions | undefined,
		),
		streamSimple: (model, context, options) => streamWithFallback(
			base.streamSimple.bind(base),
			model,
			context,
			options as CuaSimpleStreamOptions | undefined,
		),
	};
}

type StartStream = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions | SimpleStreamOptions,
) => AssistantMessageEventStream;

function streamWithFallback(
	start: StartStream,
	model: Model<Api>,
	context: Context,
	options: CuaSimpleStreamOptions | undefined,
): AssistantMessageEventStream {
	const fallback = options?.cuaIncomingToolPlan?.anthropicBrowserFallback;
	if (!fallback) return start(model, context, options);
	const credential = credentialKey(model, options);
	if (supportedCredentials.has(credential)) return start(model, context, options);
	if (unsupportedCredentials.has(credential)) return start(model, context, fallbackOptions(options, fallback));

	const output = createAssistantMessageEventStream();
	void detectAccessAndRelay(output, start, model, context, options, fallback, credential);
	return output;
}

async function detectAccessAndRelay(
	output: AssistantMessageEventStream,
	start: StartStream,
	model: Model<Api>,
	context: Context,
	options: CuaSimpleStreamOptions,
	fallback: CuaAnthropicBrowserFallback,
	credential: string,
): Promise<void> {
	let committed = false;
	let terminal: AssistantMessage | undefined;
	const pending: AssistantMessageEvent[] = [];
	try {
		const source = start(model, context, options);
		for await (const event of source) {
			if (!committed && event.type === "error" && isAnthropicBrowserAccessError(event.error.errorMessage, fallback)) {
				unsupportedCredentials.add(credential);
				await relay(output, start(model, context, fallbackOptions(options, fallback)));
				return;
			}
			if (!committed) {
				pending.push(event);
				if (event.type === "start") continue;
				committed = true;
				if (event.type !== "error") supportedCredentials.add(credential);
				for (const buffered of pending) output.push(buffered);
			} else {
				output.push(event);
			}
			terminal = terminalMessage(event) ?? terminal;
		}
		if (!committed) {
			for (const event of pending) output.push(event);
		}
		output.end(terminal ?? await source.result());
	} catch (error) {
		if (!committed && isAnthropicBrowserAccessError(errorMessage(error), fallback)) {
			unsupportedCredentials.add(credential);
			try {
				await relay(output, start(model, context, fallbackOptions(options, fallback)));
				return;
			} catch (fallbackError) {
				error = fallbackError;
			}
		}
		const message = failureMessage(model, error);
		output.push({ type: "error", reason: "error", error: message });
		output.end(message);
	}
}

async function relay(output: AssistantMessageEventStream, source: AssistantMessageEventStream): Promise<void> {
	let terminal: AssistantMessage | undefined;
	for await (const event of source) {
		output.push(event);
		terminal = terminalMessage(event) ?? terminal;
	}
	output.end(terminal ?? await source.result());
}

function fallbackOptions(
	options: CuaSimpleStreamOptions,
	fallback: CuaAnthropicBrowserFallback,
): CuaSimpleStreamOptions {
	const originalOnPayload = options.onPayload;
	return {
		...options,
		headers: removeHeaderToken(options.headers, "anthropic-beta", fallback.beta),
		onPayload: async (payload, model) => {
			const generated = (await originalOnPayload?.(payload, model)) ?? payload;
			return replaceNativeDeclaration(generated, fallback);
		},
	};
}

function replaceNativeDeclaration(payload: unknown, fallback: CuaAnthropicBrowserFallback): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.tools)) return payload;
	let replaced = false;
	const tools = payload.tools.map((tool) => {
		if (!isRecord(tool) || tool.type !== fallback.nativeType) return tool;
		replaced = true;
		return fallback.declaration;
	});
	return replaced ? { ...payload, tools } : payload;
}

function removeHeaderToken(
	headers: StreamOptions["headers"],
	name: string,
	token: string,
): StreamOptions["headers"] {
	if (!headers) return undefined;
	const next = { ...headers };
	for (const [headerName, value] of Object.entries(next)) {
		if (headerName.toLowerCase() !== name || typeof value !== "string") continue;
		const tokens = value.split(",").map((entry) => entry.trim()).filter((entry) => entry && entry !== token);
		if (tokens.length > 0) next[headerName] = tokens.join(",");
		else delete next[headerName];
	}
	return Object.keys(next).length > 0 ? next : undefined;
}

/** Return whether an Anthropic provider error specifically denies the selected native browser beta. */
export function isAnthropicBrowserAccessError(
	message: string | undefined,
	fallback: Pick<CuaAnthropicBrowserFallback, "beta" | "nativeType">,
): boolean {
	if (!message) return false;
	const value = message.toLowerCase();
	const namesBrowserFeature = value.includes(fallback.nativeType.toLowerCase())
		|| value.includes(fallback.beta.toLowerCase())
		|| value.includes("browser tool")
		|| value.includes("browser use");
	return namesBrowserFeature && [
		"access", "permission", "not available", "not enabled", "not supported", "unsupported",
		"unknown beta", "invalid beta", "unrecognized beta",
	].some((marker) => value.includes(marker));
}

function terminalMessage(event: AssistantMessageEvent): AssistantMessage | undefined {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return undefined;
}

function credentialKey(model: Model<Api>, options: StreamOptions): string {
	const authHeaders = Object.entries(options.headers ?? {})
		.filter(([name, value]) => ["authorization", "x-api-key"].includes(name.toLowerCase()) && typeof value === "string")
		.sort(([left], [right]) => left.localeCompare(right));
	const credential = options.apiKey ?? JSON.stringify(authHeaders);
	const digest = createHash("sha256").update(credential).digest("hex");
	return `${model.id}\u0000${digest}`;
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
		errorMessage: errorMessage(error),
		timestamp: Date.now(),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
