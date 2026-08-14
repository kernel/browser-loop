import type {
	AgentHarness,
	AgentHarnessTool,
	AgentMessage,
	AgentTool,
	StreamFn,
} from "@earendil-works/pi-agent-core";
import {
	type Api,
	type Context,
	cuaModels,
	type CuaIncomingToolPlan,
	type CuaModelRef,
	getCuaModel,
	parseCuaModelRef,
	type CuaSimpleStreamOptions,
	type Model,
	type Models,
	type SimpleStreamOptions,
} from "@onkernel/cua-ai";
import type Kernel from "@onkernel/sdk";
import { resolveProviderRetryPolicy, type CuaRetryOptions, withProviderRetryModels } from "./provider-retry";
import { CuaExecutionResources, type CuaExecutionDetails } from "./resources";
import { CuaToolManager, type CuaHarnessTool } from "./tool-manager";
import type { KernelBrowser } from "./translator/translator";

/** A registered CUA model reference or an already resolved pi model. */
export type CuaModelInput = CuaModelRef | Model<Api>;

const DEFAULT_TOOL_RESULT_IMAGE_REPLAY_LIMIT = 4;
const OMITTED_TOOL_RESULT_IMAGES = "[stale tool-result images omitted]";

/** Maximum recent tool-result images retained in model context, or `false` to retain all images. Provider-required native tool images are always retained. */
export type ToolResultImageReplayLimit = number | false;

/** Optional follow-up policy for otherwise empty successful assistant responses. */
export interface CuaEmptyResponseRecoveryOptions {
	/** User message queued to ask the model to continue. */
	followUp: string;
	/** Maximum automatic follow-ups per prompt. */
	maxAttempts: number;
}

/** What a Kernel browser handle needs to know to stream and execute. */
export interface CuaAttachOptions {
	browser: KernelBrowser;
	client: Kernel;
	/** Defaults to the shared {@link cuaModels} collection. */
	models?: Models;
	retry?: CuaRetryOptions;
	toolResultImageReplayLimit?: ToolResultImageReplayLimit;
	responseThreading?: boolean;
	emptyResponseRecovery?: CuaEmptyResponseRecoveryOptions;
	onPayload?: SimpleStreamOptions["onPayload"];
}

/** One compiled (model, tools) pair, ready to hand to pi. */
export interface CuaCompiled<TContext extends object | undefined = undefined> {
	/** The model to stream with, carrying the transport its tools derive. */
	readonly model: Model<Api>;
	/** Executable tools, materialized once against the handle's browser pool. */
	readonly tools: readonly AgentHarnessTool<TContext>[];
	/** Same tools viewed as pi `AgentTool`s, for the low-level `Agent`. */
	readonly agentTools: readonly AgentTool[];
	/**
	 * A `Models` collection that adds what CUA owns per request: provider retry,
	 * required headers, the catalog's payload transforms, and the tool-result
	 * image bound.
	 */
	readonly models: Models;
	/**
	 * Register the behaviors that are pi event handlers rather than constructor
	 * options: marking failed tool results, blocking a turn's remaining calls
	 * after one fails, and empty-response recovery. Returns an unsubscribe.
	 */
	install(harness: AgentHarness<any, any, any, any>): () => void;
}

/**
 * A Kernel browser bound to CUA's execution resources.
 *
 * The handle is what persists: the Kernel client and browser, the canonical
 * computer translator, the lazily created raw-CDP executor, element-ref and
 * frame state, and screenshot and Playwright capability all outlive any model
 * or tool change. `compile()` is called again for each new (model, tools) pair,
 * and a spec materializes exactly once per handle, so repeat compiles keep tool
 * identity stable.
 */
export interface CuaBrowserHandle {
	compile<TContext extends object | undefined = undefined>(options: {
		model: CuaModelInput;
		tools: readonly CuaHarnessTool<TContext>[];
	}): CuaCompiled<TContext>;
	/** The shared execution pool, for callers that need it directly. */
	readonly resources: CuaExecutionResources;
	dispose(): Promise<void>;
}

/**
 * Bind a Kernel browser to CUA's execution resources and return a handle that
 * compiles (model, tools) pairs into plain pi objects.
 *
 * ```ts
 * const kb = attach({ browser, client });
 * const { model, tools, models } = kb.compile({ model: "openai:gpt-5.6-sol", tools: [...] });
 * const harness = new AgentHarness({ model, tools, models, activeToolNames: tools.map((t) => t.name), session });
 * ```
 */
export function attach(options: CuaAttachOptions): CuaBrowserHandle {
	const resources = new CuaExecutionResources({ browser: options.browser, client: options.client });
	const imageReplayLimit = resolveToolResultImageReplayLimit(options.toolResultImageReplayLimit);
	const useResponseThreading = resolveResponseThreading(options.responseThreading);
	const recovery = resolveEmptyResponseRecovery(options.emptyResponseRecovery);
	const retrying = withProviderRetryModels(options.models ?? cuaModels(), resolveProviderRetryPolicy(options.retry));

	return {
		resources,
		dispose: () => resources.dispose(),
		compile<TContext extends object | undefined = undefined>(request: {
			model: CuaModelInput;
			tools: readonly CuaHarnessTool<TContext>[];
		}): CuaCompiled<TContext> {
			const manager = new CuaToolManager<CuaHarnessTool<TContext>>(
				resources,
				request.model,
				request.tools,
				(ref) => resolveModelFromCollection(ref, retrying),
			);
			const models = withCatalogModels(retrying, manager, imageReplayLimit, useResponseThreading, options.onPayload);
			return {
				model: manager.catalog.model,
				tools: manager.harnessTools() as readonly AgentHarnessTool<TContext>[],
				agentTools: manager.agentTools(),
				models,
				install: (harness) => installCuaBehaviors(harness, manager, recovery),
			};
		},
	};
}

/**
 * Wire the pi event handlers CUA owns. Kept separate from `compile()` because
 * they are handlers on a constructed harness, not constructor options.
 */
export function installCuaBehaviors(
	harness: AgentHarness<any, any, any, any>,
	manager: CuaToolManager<any>,
	recovery: CuaEmptyResponseRecoveryOptions | undefined,
): () => void {
	let turnFailed = false;
	let hasPendingQueue = false;
	let recoveryAttempts = 0;
	const offs: Array<() => void> = [];

	offs.push(harness.on("tool_result", (event: { details?: unknown }) => (hasExecutionError(event.details) ? { isError: true } : undefined)));
	offs.push(harness.on("tool_call", () =>
		turnFailed && turnFailureStopMessage(manager) ? { block: true, reason: turnFailureStopMessage(manager) } : undefined));
	offs.push(harness.on("before_agent_start", () => {
		turnFailed = false;
		recoveryAttempts = 0;
		hasPendingQueue = false;
		return undefined;
	}));
	offs.push(harness.subscribe(async (event: any, signal?: AbortSignal) => {
		if (event.type === "message_end" && event.message.role === "assistant") turnFailed = false;
		else if (event.type === "tool_execution_end" && event.isError) turnFailed = true;
		else if (event.type === "queue_update") hasPendingQueue = event.steer.length > 0 || event.followUp.length > 0;
		if (!recovery || recovery.maxAttempts <= 0) return;
		if (event.type !== "turn_end" || !isEmptyAssistantResponse(event.message)) return;
		if (signal?.aborted || recoveryAttempts >= recovery.maxAttempts || hasPendingQueue) return;
		// Count the attempt only once the follow-up is actually queued: a rejected
		// queue leaves the turn exactly as it was, so it must not consume a retry.
		await harness.followUp(recovery.followUp);
		recoveryAttempts += 1;
	}));

	return () => {
		for (const off of offs) off();
	};
}

/** @internal shared with the agent classes until they retire. */
export const defaultCuaStream: StreamFn = (model, context, options) => cuaModels().streamSimple(model, context, options);

/** @internal shared with the agent classes until they retire. */
export function resolveModelFromCollection(ref: CuaModelRef, models: Models): Model<Api> {
	const { provider, model: id } = parseCuaModelRef(ref);
	return models.getModel(provider, id) ?? getCuaModel(ref);
}

/** Whether a tools-only recompile actually changed the model pi streams with, so `setTools()` only pushes `setModel()` (and its session/event side effects) when the derived transport moved. */
/** @internal shared with the agent classes until they retire. */
export function modelTransportChanged(previous: Model<Api>, next: Model<Api>): boolean {
	return previous.provider !== next.provider || previous.id !== next.id || previous.api !== next.api;
}

/** @internal shared with the agent classes until they retire. */
export function withCatalogModels(
	models: Models,
	manager: CuaToolManager<any>,
	imageReplayLimit: ToolResultImageReplayLimit,
	responseThreading: boolean,
	handleOnPayload?: SimpleStreamOptions["onPayload"],
): Models {
	const contextFor = (context: Context) => projectModelContext(
		context,
		imageReplayLimit,
		requiredImageToolNames(manager.catalog.incoming),
	);
	const optionsFor = <T extends SimpleStreamOptions | undefined>(options: T): T => {
		const catalog = manager.catalog;
		const callerOnPayload = options?.onPayload ?? handleOnPayload;
		return {
			...options,
			headers: catalog.headers.merge(options?.headers),
			disableResponseThreading: responseThreading ? undefined : true,
			cuaIncomingToolPlan: catalog.incoming,
			onPayload: async (payload: unknown, model: Model<Api>) => {
				const generated = await catalog.payload.apply(payload, model);
				return callerOnPayload ? (await callerOnPayload(generated, model)) ?? generated : generated;
			},
		} as T;
	};
	return {
		getProviders: () => models.getProviders(),
		getProvider: (id) => models.getProvider(id),
		getModels: (provider) => models.getModels(provider),
		getModel: (provider, id) => models.getModel(provider, id),
		refresh: (provider) => models.refresh(provider),
		getAuth: (input, overrides) => models.getAuth(input as never, overrides),
		checkAuth: (providerId) => models.checkAuth(providerId),
		getAvailable: (providerId) => models.getAvailable(providerId),
		login: (providerId, type, interaction) => models.login(providerId, type, interaction),
		logout: (providerId) => models.logout(providerId),
		stream: (model, context, options) => models.stream(model, contextFor(context), optionsFor(options)),
		complete: (model, context, options) => models.complete(model, contextFor(context), optionsFor(options)),
		streamSimple: (model, context, options) => models.streamSimple(model, contextFor(context), optionsFor(options)),
		completeSimple: (model, context, options) => models.completeSimple(model, contextFor(context), optionsFor(options)),
	};
}

/** @internal shared with the agent classes until they retire. */
export function resolveToolResultImageReplayLimit(limit: ToolResultImageReplayLimit | undefined): ToolResultImageReplayLimit {
	if (limit === undefined) return DEFAULT_TOOL_RESULT_IMAGE_REPLAY_LIMIT;
	if (limit !== false && (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 0)) {
		throw new TypeError("toolResultImageReplayLimit must be a finite non-negative integer or false");
	}
	return limit;
}

/** Native computer tool names whose screenshot history the provider protocol requires in full, regardless of the image replay limit. */
/** @internal shared with the agent classes until they retire. */
export function requiredImageToolNames(incoming: CuaIncomingToolPlan): ReadonlySet<string> {
	return new Set(incoming.openaiComputerName ? [incoming.openaiComputerName] : []);
}

/** @internal shared with the agent classes until they retire. */
export function projectToolResultImages<TMessage extends AgentMessage>(
	messages: TMessage[],
	limit: ToolResultImageReplayLimit,
	requiredToolNames: ReadonlySet<string> = new Set(),
): TMessage[] {
	if (limit === false) return messages;
	let imageCount = 0;
	for (const message of messages) {
		if (message.role === "toolResult" && !requiredToolNames.has(message.toolName)) {
			imageCount += message.content.filter((block) => block.type === "image").length;
		}
	}
	if (imageCount <= limit) return messages;
	const firstRetainedImage = Math.max(0, imageCount - limit);
	let imageOrdinal = 0;
	return messages.map((message) => {
		if (message.role !== "toolResult" || requiredToolNames.has(message.toolName)) return message;
		let changed = false;
		let markerInserted = false;
		const content = [] as typeof message.content;
		for (const block of message.content) {
			if (block.type !== "image" || imageOrdinal++ >= firstRetainedImage) {
				content.push(block);
				continue;
			}
			changed = true;
			if (!markerInserted) {
				content.push({ type: "text", text: OMITTED_TOOL_RESULT_IMAGES });
				markerInserted = true;
			}
		}
		return changed ? { ...message, content } as TMessage : message;
	});
}

function projectModelContext(
	context: Context,
	imageReplayLimit: ToolResultImageReplayLimit,
	requiredToolNames: ReadonlySet<string>,
): Context {
	const messages = projectToolResultImages(context.messages, imageReplayLimit, requiredToolNames);
	return messages === context.messages ? context : { ...context, messages };
}

/** @internal shared with the agent classes until they retire. */
export function resolveEmptyResponseRecovery(options: CuaEmptyResponseRecoveryOptions | undefined): CuaEmptyResponseRecoveryOptions | undefined {
	if (!options) return undefined;
	if (options.followUp.trim().length === 0) throw new Error("emptyResponseRecovery.followUp must not be blank");
	if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 0) throw new Error("emptyResponseRecovery.maxAttempts must be a non-negative finite integer");
	return { followUp: options.followUp, maxAttempts: options.maxAttempts };
}

/** @internal shared with the agent classes until they retire. */
export function resolveResponseThreading(value: boolean | undefined): boolean {
	if (value !== undefined && typeof value !== "boolean") throw new TypeError("responseThreading must be a boolean");
	return value ?? true;
}

/** @internal shared with the agent classes until they retire. */
export function isEmptyAssistantResponse(message: AgentMessage): boolean {
	return message.role === "assistant" && message.stopReason === "stop" && message.content.length === 0;
}

/** @internal shared with the agent classes until they retire. */
export function hasExecutionError(details: unknown): boolean {
	return Boolean(details && typeof details === "object" && (details as CuaExecutionDetails).isError === true);
}

/** @internal shared with the agent classes until they retire. */
export function turnFailureStopMessage(manager: CuaToolManager<any>): string | undefined {
	for (const entry of manager.catalog.entries) {
		const execution = manager.specFor(entry.identity)?.execution;
		if (execution?.kind === "actions" && execution.stopTurnOnFailureMessage) return execution.stopTurnOnFailureMessage;
	}
	return undefined;
}
