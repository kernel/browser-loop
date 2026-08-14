import type {
	AgentHarness,
	AgentHarnessTool,
	AgentMessage,
	AgentTool,
	StreamFn,
} from "@earendil-works/pi-agent-core";
import type {
	Api,
	Context,
	Model,
	Models,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type Kernel from "@onkernel/sdk";
import { LoopExecutionResources, type LoopExecutionDetails } from "../core/resources";
import type { LoopIncomingToolPlan } from "../core/tool-catalog";
import { LoopToolManager, type LoopHarnessTool } from "../core/tool-manager";
import type { KernelBrowser } from "../core/translator/translator";
import { getLoopModel, parseLoopModelRef, type LoopModelRef } from "./models";
import { resolveProviderRetryPolicy, type LoopRetryOptions, withProviderRetryModels } from "./provider-retry";
import { loopModels } from "./providers";

/** A registered Loop model reference or an already resolved pi model. */
export type LoopModelInput = LoopModelRef | Model<Api>;

const DEFAULT_TOOL_RESULT_IMAGE_REPLAY_LIMIT = 4;
const OMITTED_TOOL_RESULT_IMAGES = "[stale tool-result images omitted]";

/** Maximum recent tool-result images retained in model context, or `false` to retain all images. Provider-required native tool images are always retained. */
export type ToolResultImageReplayLimit = number | false;

/** Optional follow-up policy for otherwise empty successful assistant responses. */
export interface LoopEmptyResponseRecoveryOptions {
	/** User message queued to ask the model to continue. */
	followUp: string;
	/** Maximum automatic follow-ups per prompt. */
	maxAttempts: number;
}

/** What a Kernel browser handle needs to know to stream and execute. */
export interface LoopAttachOptions {
	browser: KernelBrowser;
	client: Kernel;
	/** Defaults to the shared {@link loopModels} collection. */
	models?: Models;
	retry?: LoopRetryOptions;
	toolResultImageReplayLimit?: ToolResultImageReplayLimit;
	responseThreading?: boolean;
	emptyResponseRecovery?: LoopEmptyResponseRecoveryOptions;
	onPayload?: SimpleStreamOptions["onPayload"];
}

/** One compiled (model, tools) pair, ready to hand to pi. */
export interface LoopCompiled<TContext extends object | undefined = undefined> {
	/** The model to stream with, carrying the transport its tools derive. */
	readonly model: Model<Api>;
	/** Executable tools, materialized once against the handle's browser pool. */
	readonly tools: readonly AgentHarnessTool<TContext>[];
	/** Same tools viewed as pi `AgentTool`s, for the low-level `Agent`. */
	readonly agentTools: readonly AgentTool[];
	/**
	 * The handle's `Models` collection, adding what Loop owns per request:
	 * provider retry, required headers, the catalog's payload transforms, and
	 * the tool-result image bound. Shared by every compile from this handle,
	 * because pi fixes `models` at construction while those transforms are
	 * per-catalog; it serves whichever pair is currently active.
	 */
	readonly models: Models;
	/**
	 * Make this the handle's live pair on a harness: register the behaviors that
	 * are pi event handlers rather than constructor options (marking failed tool
	 * results, blocking a turn's remaining calls after one fails, empty-response
	 * recovery), and point `models` at this catalog. Returns a release that undoes
	 * both. Activating another pair releases this one.
	 */
	activate(harness: AgentHarness<any, any, any, any>): () => void;
	/**
	 * Swap a running harness onto this pair, then activate it. Model and tools
	 * move together because the transport is derived from both: setting one
	 * without the other leaves pi streaming a combination that never compiled.
	 * The model is only set when the derived transport actually moved, so a
	 * tools-only change records no model change. A failure restores the harness's
	 * previous pair before rethrowing, leaving the old pair active.
	 */
	apply(harness: AgentHarness<any, any, any, AgentHarnessTool<TContext>>): Promise<void>;
}

/**
 * A Kernel browser bound to Loop's execution resources.
 *
 * The handle is what persists: the Kernel client and browser, the canonical
 * computer translator, the lazily created raw-CDP executor, element-ref and
 * frame state, and screenshot and Playwright capability all outlive any model
 * or tool change. `compile()` is called again for each new (model, tools) pair,
 * and a spec materializes exactly once per handle, so repeat compiles keep tool
 * identity stable.
 */
export interface LoopBrowserHandle {
	compile<TContext extends object | undefined = undefined>(options: {
		model: LoopModelInput;
		tools: readonly LoopHarnessTool<TContext>[];
	}): LoopCompiled<TContext>;
	/** The shared execution pool, for callers that need it directly. */
	readonly resources: LoopExecutionResources;
	/** Same collection every {@link LoopCompiled.models} returns; see the note there. */
	readonly models: Models;
	dispose(): Promise<void>;
}

/**
 * Bind a Kernel browser to Loop's execution resources and return a handle that
 * compiles (model, tools) pairs into plain pi objects.
 *
 * ```ts
 * const kb = attach({ browser, client });
 * const { model, tools, models } = kb.compile({ model: "openai:gpt-5.6-sol", tools: [...] });
 * const harness = new AgentHarness({ model, tools, models, activeToolNames: tools.map((t) => t.name), session });
 * ```
 */
export function attach(options: LoopAttachOptions): LoopBrowserHandle {
	const resources = new LoopExecutionResources({ browser: options.browser, client: options.client });
	const imageReplayLimit = resolveToolResultImageReplayLimit(options.toolResultImageReplayLimit);
	const useResponseThreading = resolveResponseThreading(options.responseThreading);
	const recovery = resolveEmptyResponseRecovery(options.emptyResponseRecovery);
	const retrying = withProviderRetryModels(options.models ?? loopModels(), resolveProviderRetryPolicy(options.retry));

	// pi fixes `models` at construction, but the headers, payload transforms and
	// incoming tool plan it applies are per-catalog. One collection per handle,
	// reading whichever pair is live, is what lets a caller swap the pair on a
	// running harness at all.
	let live: LoopToolManager<any> | undefined;
	let lastCompiled: LoopToolManager<any> | undefined;
	let release: (() => void) | undefined;
	const models = withCatalogModels(
		retrying,
		() => {
			const manager = live ?? lastCompiled;
			if (!manager) throw new Error("loop: compile a (model, tools) pair before streaming");
			return manager;
		},
		imageReplayLimit,
		useResponseThreading,
		options.onPayload,
	);

	return {
		resources,
		models,
		dispose: () => resources.dispose(),
		compile<TContext extends object | undefined = undefined>(request: {
			model: LoopModelInput;
			tools: readonly LoopHarnessTool<TContext>[];
		}): LoopCompiled<TContext> {
			const manager = new LoopToolManager<LoopHarnessTool<TContext>>(
				resources,
				request.model,
				request.tools,
				(ref) => resolveModelFromCollection(ref, retrying),
			);
			lastCompiled = manager;
			const model = manager.catalog.model;
			const tools = manager.harnessTools() as readonly AgentHarnessTool<TContext>[];
			const activate = (harness: AgentHarness<any, any, any, any>): (() => void) => {
				release?.();
				const uninstall = installLoopBehaviors(harness, manager, recovery);
				live = manager;
				// Identity-checked so calling a stale release cannot clear a newer
				// activation: only the pair still live releases anything.
				const releaseThis = (): void => {
					uninstall();
					if (live === manager) live = undefined;
					if (release === releaseThis) release = undefined;
				};
				release = releaseThis;
				return releaseThis;
			};
			return {
				model,
				tools,
				agentTools: manager.agentTools(),
				models,
				activate,
				async apply(harness) {
					await applyCompiled(harness, model, tools);
					activate(harness);
				},
			};
		},
	};
}

async function applyCompiled<TContext extends object | undefined>(
	harness: AgentHarness<any, any, any, AgentHarnessTool<TContext>>,
	model: Model<Api>,
	tools: readonly AgentHarnessTool<TContext>[],
): Promise<void> {
	const previousModel = harness.getModel();
	const previousTools = harness.getTools();
	const transportChanged = modelTransportChanged(previousModel, model);
	try {
		if (transportChanged) await harness.setModel(model);
		await harness.setTools([...tools], tools.map((tool) => tool.name));
	} catch (error) {
		if (transportChanged) await harness.setModel(previousModel);
		await harness.setTools(previousTools, previousTools.map((tool) => tool.name));
		throw error;
	}
}

/**
 * Wire the pi event handlers Loop owns. Kept separate from `compile()` because
 * they are handlers on a constructed harness, not constructor options.
 */
export function installLoopBehaviors(
	harness: AgentHarness<any, any, any, any>,
	manager: LoopToolManager<any>,
	recovery: LoopEmptyResponseRecoveryOptions | undefined,
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

/** @internal */
export const defaultLoopStream: StreamFn = (model, context, options) => loopModels().streamSimple(model, context, options);

/** @internal */
export function resolveModelFromCollection(ref: LoopModelRef, models: Models): Model<Api> {
	const { provider, model: id } = parseLoopModelRef(ref);
	return models.getModel(provider, id) ?? getLoopModel(ref);
}

/** Whether a tools-only recompile actually changed the model pi streams with, so `setTools()` only pushes `setModel()` (and its session/event side effects) when the derived transport moved. */
/** @internal */
export function modelTransportChanged(previous: Model<Api>, next: Model<Api>): boolean {
	return previous.provider !== next.provider || previous.id !== next.id || previous.api !== next.api;
}

/** @internal */
export function withCatalogModels(
	models: Models,
	liveManager: () => LoopToolManager<any>,
	imageReplayLimit: ToolResultImageReplayLimit,
	responseThreading: boolean,
	handleOnPayload?: SimpleStreamOptions["onPayload"],
): Models {
	const contextFor = (context: Context) => projectModelContext(
		context,
		imageReplayLimit,
		requiredImageToolNames(liveManager().catalog.incoming),
	);
	const optionsFor = <T extends SimpleStreamOptions | undefined>(options: T): T => {
		const catalog = liveManager().catalog;
		const callerOnPayload = options?.onPayload ?? handleOnPayload;
		return {
			...options,
			headers: catalog.headers.merge(options?.headers),
			disableResponseThreading: responseThreading ? undefined : true,
			loopIncomingToolPlan: catalog.incoming,
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

/** @internal */
export function resolveToolResultImageReplayLimit(limit: ToolResultImageReplayLimit | undefined): ToolResultImageReplayLimit {
	if (limit === undefined) return DEFAULT_TOOL_RESULT_IMAGE_REPLAY_LIMIT;
	if (limit !== false && (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 0)) {
		throw new TypeError("toolResultImageReplayLimit must be a finite non-negative integer or false");
	}
	return limit;
}

/** Native computer tool names whose screenshot history the provider protocol requires in full, regardless of the image replay limit. */
/** @internal */
export function requiredImageToolNames(incoming: LoopIncomingToolPlan): ReadonlySet<string> {
	return new Set(incoming.openaiComputerName ? [incoming.openaiComputerName] : []);
}

/** @internal */
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

/** @internal */
export function resolveEmptyResponseRecovery(options: LoopEmptyResponseRecoveryOptions | undefined): LoopEmptyResponseRecoveryOptions | undefined {
	if (!options) return undefined;
	if (options.followUp.trim().length === 0) throw new Error("emptyResponseRecovery.followUp must not be blank");
	if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 0) throw new Error("emptyResponseRecovery.maxAttempts must be a non-negative finite integer");
	return { followUp: options.followUp, maxAttempts: options.maxAttempts };
}

/** @internal */
export function resolveResponseThreading(value: boolean | undefined): boolean {
	if (value !== undefined && typeof value !== "boolean") throw new TypeError("responseThreading must be a boolean");
	return value ?? true;
}

/** @internal */
export function isEmptyAssistantResponse(message: AgentMessage): boolean {
	return message.role === "assistant" && message.stopReason === "stop" && message.content.length === 0;
}

/** @internal */
export function hasExecutionError(details: unknown): boolean {
	return Boolean(details && typeof details === "object" && (details as LoopExecutionDetails).isError === true);
}

/** @internal */
export function turnFailureStopMessage(manager: LoopToolManager<any>): string | undefined {
	for (const entry of manager.catalog.entries) {
		const execution = manager.specFor(entry.identity)?.execution;
		if (execution?.kind === "actions" && execution.stopTurnOnFailureMessage) return execution.stopTurnOnFailureMessage;
	}
	return undefined;
}
