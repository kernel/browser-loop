import {
	Agent,
	AgentHarness,
	type AgentEvent,
	type AgentHarnessEvent,
	type AgentHarnessEventResultMap,
	type AgentHarnessOptions,
	type AgentHarnessOwnEvent,
	type AgentHarnessToolContextSource,
	type AgentHarnessResources,
	type AgentHarnessStreamOptions,
	type AgentHarnessTool,
	type AgentMessage,
	type AgentOptions,
	type AgentTool,
	type NavigateTreeResult,
	type PromptTemplate,
	type QueueMode,
	type Session,
	type Skill,
	type StreamFn,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	type Api,
	type Context,
	cuaModels,
	type CuaIncomingToolPlan,
	type CuaModelRef,
	findCuaAnnotation,
	getCuaModel,
	parseCuaModelRef,
	type CuaSimpleStreamOptions,
	getCuaEnvApiKey,
	type ImageContent,
	type Model,
	type Models,
	type SimpleStreamOptions,
} from "@onkernel/cua-ai";
import type Kernel from "@onkernel/sdk";
import {
	resolveProviderRetryPolicy,
	type CuaRetryOptions,
	withProviderRetry,
	withProviderRetryModels,
} from "./provider-retry";
import { CuaExecutionResources, type CuaExecutionDetails } from "./resources";
import { CuaToolManager, type CuaAgentTool, type CuaHarnessTool } from "./tool-manager";
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

/** Mutable conversation state exposed by {@link CuaAgent}. */
export interface CuaAgentState {
	systemPrompt: string;
	model: Model<Api> | CuaModelRef;
	thinkingLevel: ThinkingLevel;
	messages: AgentMessage[];
	readonly tools: readonly AgentTool[];
	readonly isStreaming: boolean;
	readonly streamingMessage?: AgentMessage;
	readonly pendingToolCalls: ReadonlySet<string>;
	readonly errorMessage?: string;
}

type CuaAgentInitialState = Omit<NonNullable<AgentOptions["initialState"]>, "model" | "tools"> & {
	model: CuaModelInput;
};

/** Construction options for {@link CuaAgent}, including its exact caller-owned tool catalog. */
export type CuaAgentOptions = Omit<AgentOptions, "initialState" | "streamFn"> & {
	browser: KernelBrowser;
	client: Kernel;
	tools: readonly CuaAgentTool[];
	initialState: CuaAgentInitialState;
	/** Defaults to streaming through the shared {@link cuaModels} collection. */
	streamFn?: AgentOptions["streamFn"];
	emptyResponseRecovery?: CuaEmptyResponseRecoveryOptions;
	toolResultImageReplayLimit?: ToolResultImageReplayLimit;
	/** Governs Google, Meta, xAI, and Tzafon's `previous_response_id`-style continuation. OpenAI streams through pi's automatic prompt caching regardless of this flag. Defaults to `true`. */
	responseThreading?: boolean;
	retry?: CuaRetryOptions;
};

type CuaAgentHarnessOptionsBase<
	TContext extends object | undefined,
	TSkill extends Skill,
	TPromptTemplate extends PromptTemplate,
> = Omit<
	AgentHarnessOptions<TContext, TSkill, TPromptTemplate, AgentHarnessTool<TContext>>,
	"activeToolNames" | "model" | "models" | "tools" | "toolContext" | "retry"
> & {
	browser: KernelBrowser;
	client: Kernel;
	model: CuaModelInput;
	models?: Models;
	tools: readonly CuaHarnessTool<TContext>[];
	onPayload?: SimpleStreamOptions["onPayload"];
	emptyResponseRecovery?: CuaEmptyResponseRecoveryOptions;
	toolResultImageReplayLimit?: ToolResultImageReplayLimit;
	/** Governs Google, Meta, xAI, and Tzafon's `previous_response_id`-style continuation. OpenAI streams through pi's automatic prompt caching regardless of this flag. Defaults to `true`. */
	responseThreading?: boolean;
	retry?: CuaRetryOptions;
};

/**
 * Construction options for {@link CuaAgentHarness}, including its exact
 * caller-owned tool catalog. Mirrors pi's `AgentHarnessOptions` generic order:
 * the tool context first, then skill and prompt-template resource types. The
 * supplied `toolContext` is forwarded to pi untouched, and every executable
 * tool receives it on each call.
 */
export type CuaAgentHarnessOptions<
	TContext extends object | undefined = undefined,
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> = CuaAgentHarnessOptionsBase<TContext, TSkill, TPromptTemplate> & ([TContext] extends [undefined] ? {
	/** Context-free harnesses do not need a tool context. */
	toolContext?: undefined;
} : {
	/** Static context or zero-argument context provider resolved for each turn snapshot. */
	toolContext: AgentHarnessToolContextSource<TContext>;
});

/** Pi Agent behavior with an explicit, identity-keyed CUA tool catalog. */
export class CuaAgent {
	private readonly coreAgent: Agent;
	private readonly tools: CuaToolManager;
	private runtimeDirty = false;
	private readonly stateView: CuaAgentState;
	private emptyResponseRecoveryAttempts = 0;

	constructor(options: CuaAgentOptions) {
		const {
			browser,
			client,
			tools: requestedTools,
			initialState,
			onPayload,
			streamFn,
			prepareNextTurn,
			prepareNextTurnWithContext,
			transformContext,
			afterToolCall,
			beforeToolCall,
			emptyResponseRecovery,
			toolResultImageReplayLimit,
			responseThreading,
			retry,
			...agentOptions
		} = options;
		const recovery = resolveEmptyResponseRecovery(emptyResponseRecovery);
		const imageReplayLimit = resolveToolResultImageReplayLimit(toolResultImageReplayLimit);
		const useResponseThreading = resolveResponseThreading(responseThreading);
		const resources = new CuaExecutionResources({ browser, client });
		const manager = new CuaToolManager(resources, initialState.model, requestedTools);
		const retryingStream = withProviderRetry(streamFn ?? defaultCuaStream, resolveProviderRetryPolicy(retry));
		const streamWithCatalog: StreamFn = (model, context, streamOptions) => {
			const catalog = manager.catalog;
			const generatedOnPayload = async (payload: unknown, selectedModel: Model<Api>) => {
				const generated = await catalog.payload.apply(payload, selectedModel);
				return onPayload ? (await onPayload(generated, selectedModel)) ?? generated : generated;
			};
			const cuaOptions: CuaSimpleStreamOptions = {
				...streamOptions,
				headers: catalog.headers.merge(streamOptions?.headers),
				onPayload: generatedOnPayload,
				disableResponseThreading: !useResponseThreading,
				cuaIncomingToolPlan: catalog.incoming,
			};
			return retryingStream(model, context, cuaOptions);
		};
		const failedTurns = new WeakSet<object>();
		let core!: Agent;
		core = new Agent({
			...agentOptions,
			getApiKey: agentOptions.getApiKey ?? getCuaEnvApiKey,
			streamFn: streamWithCatalog,
			beforeToolCall: async (context, signal) => {
				const stopMessage = turnFailureStopMessage(manager);
				if (stopMessage && failedTurns.has(context.assistantMessage)) return { block: true, reason: stopMessage };
				return beforeToolCall?.(context, signal);
			},
			afterToolCall: async (context, signal) => {
				const result = await afterToolCall?.(context, signal);
				const forcedError = hasExecutionError(result?.details ?? context.result.details);
				if ((result?.isError ?? context.isError) || forcedError) failedTurns.add(context.assistantMessage);
				return forcedError ? { ...result, isError: true } : result;
			},
			transformContext: async (messages, signal) => projectToolResultImages(
				transformContext ? await transformContext(messages, signal) : messages,
				imageReplayLimit,
				requiredImageToolNames(manager.catalog.incoming),
			),
			prepareNextTurnWithContext: async (context, signal) => {
				const update = prepareNextTurnWithContext
					? await prepareNextTurnWithContext(context, signal)
					: await prepareNextTurn?.(signal);
				if (update?.model) this.setModel(update.model as CuaModelInput);
				if (!update && !this.runtimeDirty) return undefined;
				this.runtimeDirty = false;
				return {
					...update,
					model: core.state.model,
					context: {
						...(update?.context ?? context.context),
						tools: core.state.tools.slice(),
					},
				};
			},
			initialState: {
				...initialState,
				model: manager.catalog.model,
				tools: manager.agentTools(),
				systemPrompt: initialState.systemPrompt ?? "",
			},
		});
		this.coreAgent = core;
		this.tools = manager;
		this.stateView = this.createStateView();

		if (recovery && recovery.maxAttempts > 0) {
			this.subscribe((event, signal) => {
				if (event.type === "agent_start") {
					this.emptyResponseRecoveryAttempts = 0;
					return;
				}
				if (event.type !== "turn_end" || !isEmptyAssistantResponse(event.message)) return;
				if (signal.aborted || this.emptyResponseRecoveryAttempts >= recovery.maxAttempts || this.hasQueuedMessages()) return;
				this.followUp({ role: "user", content: [{ type: "text", text: recovery.followUp }], timestamp: Date.now() });
				this.emptyResponseRecoveryAttempts += 1;
			});
		}
	}

	get state(): CuaAgentState {
		return this.stateView;
	}

	getTools(): readonly CuaAgentTool[] {
		return this.tools.getTools();
	}

	setTools(tools: readonly CuaAgentTool[]): void {
		const prepared = this.tools.prepareTools(tools);
		this.coreAgent.state.tools = this.tools.agentTools(prepared);
		this.tools.commit(prepared);
		this.runtimeDirty = true;
	}

	getModel(): Model<Api> {
		return this.tools.catalog.model;
	}

	setModel(model: CuaModelInput): void {
		const prepared = this.tools.prepareModel(model);
		this.coreAgent.state.model = prepared.catalog.model;
		this.coreAgent.state.tools = this.tools.agentTools(prepared);
		this.tools.commit(prepared);
		this.runtimeDirty = true;
	}

	prompt(...args: Parameters<Agent["prompt"]>): Promise<void> {
		return this.coreAgent.prompt(...args);
	}

	continue(): Promise<void> { return this.coreAgent.continue(); }
	steer(message: AgentMessage): void { this.coreAgent.steer(message); }
	followUp(message: AgentMessage): void { this.coreAgent.followUp(message); }
	clearSteeringQueue(): void { this.coreAgent.clearSteeringQueue(); }
	clearFollowUpQueue(): void { this.coreAgent.clearFollowUpQueue(); }
	clearAllQueues(): void { this.coreAgent.clearAllQueues(); }
	hasQueuedMessages(): boolean { return this.coreAgent.hasQueuedMessages(); }
	abort(): void { this.coreAgent.abort(); }
	waitForIdle(): Promise<void> { return this.coreAgent.waitForIdle(); }
	reset(): void { this.coreAgent.reset(); }
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void { return this.coreAgent.subscribe(listener); }
	get signal(): AbortSignal | undefined { return this.coreAgent.signal; }
	get steeringMode(): QueueMode { return this.coreAgent.steeringMode; }
	set steeringMode(mode: QueueMode) { this.coreAgent.steeringMode = mode; }
	get followUpMode(): QueueMode { return this.coreAgent.followUpMode; }
	set followUpMode(mode: QueueMode) { this.coreAgent.followUpMode = mode; }

	async dispose(): Promise<void> {
		this.abort();
		await this.waitForIdle();
		await this.tools.resources.dispose();
	}

	private createStateView(): CuaAgentState {
		const owner = this;
		return Object.defineProperties({}, {
			systemPrompt: { enumerable: true, get: () => owner.coreAgent.state.systemPrompt, set: (value: string) => { owner.coreAgent.state.systemPrompt = value; } },
			model: { enumerable: true, get: () => owner.getModel(), set: (value: CuaModelInput) => owner.setModel(value) },
			thinkingLevel: { enumerable: true, get: () => owner.coreAgent.state.thinkingLevel, set: (value: ThinkingLevel) => { owner.coreAgent.state.thinkingLevel = value; } },
			messages: { enumerable: true, get: () => owner.coreAgent.state.messages, set: (value: AgentMessage[]) => { owner.coreAgent.state.messages = value; } },
			tools: { enumerable: true, get: () => owner.coreAgent.state.tools.slice() },
			isStreaming: { enumerable: true, get: () => owner.coreAgent.state.isStreaming },
			streamingMessage: { enumerable: true, get: () => owner.coreAgent.state.streamingMessage },
			pendingToolCalls: { enumerable: true, get: () => owner.coreAgent.state.pendingToolCalls },
			errorMessage: { enumerable: true, get: () => owner.coreAgent.state.errorMessage },
		}) as CuaAgentState;
	}
}

/** Pi AgentHarness behavior through composition, without inherited active-tool APIs. */
export class CuaAgentHarness<
	TContext extends object | undefined = undefined,
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
	readonly models: Models;
	private readonly coreHarness: AgentHarness<TContext, TSkill, TPromptTemplate, AgentHarnessTool<TContext>>;
	private readonly tools: CuaToolManager<CuaHarnessTool<TContext>>;
	private emptyResponseRecoveryAttempts = 0;
	private hasPendingQueue = false;
	private toolTurnFailed = false;

	constructor(options: CuaAgentHarnessOptions<TContext, TSkill, TPromptTemplate>) {
		const {
			browser,
			client,
			model,
			models,
			tools: requestedTools,
			onPayload,
			emptyResponseRecovery,
			toolResultImageReplayLimit,
			responseThreading,
			retry,
			...harnessOptions
		} = options;
		const recovery = resolveEmptyResponseRecovery(emptyResponseRecovery);
		const imageReplayLimit = resolveToolResultImageReplayLimit(toolResultImageReplayLimit);
		const useResponseThreading = resolveResponseThreading(responseThreading);
		const resources = new CuaExecutionResources({ browser, client });
		const retrying = withProviderRetryModels(models ?? cuaModels(), resolveProviderRetryPolicy(retry));
		const manager = new CuaToolManager<CuaHarnessTool<TContext>>(resources, model, requestedTools, (ref) => resolveModelFromCollection(ref, retrying));
		const catalogModels = withCatalogModels(retrying, manager, imageReplayLimit, useResponseThreading);
		const materialized = manager.harnessTools();
		// A generic TContext leaves pi's conditional toolContext unverifiable
		// here; the spread forwards the caller's toolContext verbatim.
		const core = new AgentHarness<TContext, TSkill, TPromptTemplate, AgentHarnessTool<TContext>>({
			...harnessOptions,
			model: manager.catalog.model,
			models: catalogModels,
			tools: materialized,
			activeToolNames: materialized.map((tool) => tool.name),
		} as AgentHarnessOptions<TContext, TSkill, TPromptTemplate, AgentHarnessTool<TContext>>);
		this.coreHarness = core;
		this.tools = manager;
		this.models = core.models;

		core.on("tool_result", (event) => hasExecutionError(event.details) ? { isError: true } : undefined);
		core.on("tool_call", () => this.toolTurnFailed && turnFailureStopMessage(manager)
			? { block: true, reason: turnFailureStopMessage(manager) }
			: undefined);
		core.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") this.toolTurnFailed = false;
			else if (event.type === "tool_execution_end" && event.isError) this.toolTurnFailed = true;
			else if (event.type === "queue_update") this.hasPendingQueue = event.steer.length > 0 || event.followUp.length > 0;
		});
		core.on("before_agent_start", () => {
			this.toolTurnFailed = false;
			return undefined;
		});
		if (onPayload) {
			core.on("before_provider_payload", async ({ model: selectedModel, payload }) => ({
				payload: (await onPayload(payload, selectedModel)) ?? payload,
			}));
		}
		if (recovery && recovery.maxAttempts > 0) {
			core.on("before_agent_start", () => {
				this.emptyResponseRecoveryAttempts = 0;
				this.hasPendingQueue = false;
				return undefined;
			});
			core.subscribe(async (event, signal) => {
				if (event.type !== "turn_end" || !isEmptyAssistantResponse(event.message)) return;
				if (signal?.aborted || this.emptyResponseRecoveryAttempts >= recovery.maxAttempts || this.hasPendingQueue) return;
				await core.followUp(recovery.followUp);
				this.emptyResponseRecoveryAttempts += 1;
			});
		}
	}

	getTools(): readonly CuaHarnessTool<TContext>[] { return this.tools.getTools(); }

	async setTools(tools: readonly CuaHarnessTool<TContext>[]): Promise<void> {
		const previousTools = this.tools.harnessTools();
		const prepared = this.tools.prepareTools(tools);
		const materialized = this.tools.harnessTools(prepared);
		try {
			await this.coreHarness.setTools(materialized, materialized.map((tool) => tool.name));
		} catch (error) {
			await this.coreHarness.setTools(previousTools, previousTools.map((tool) => tool.name));
			throw error;
		}
		this.tools.commit(prepared);
	}

	getModel(): Model<Api> { return this.tools.catalog.model; }

	async setModel(model: CuaModelInput): Promise<void> {
		const previousModel = this.tools.catalog.model;
		const previousTools = this.tools.harnessTools();
		const prepared = this.tools.prepareModel(model);
		const materialized = this.tools.harnessTools(prepared);
		try {
			await this.coreHarness.setModel(prepared.catalog.model);
			await this.coreHarness.setTools(materialized, materialized.map((tool) => tool.name));
		} catch (error) {
			await this.coreHarness.setModel(previousModel);
			await this.coreHarness.setTools(previousTools, previousTools.map((tool) => tool.name));
			throw error;
		}
		this.tools.commit(prepared);
	}

	prompt(text: string, options?: { images?: ImageContent[] }) { return this.coreHarness.prompt(text, options); }
	skill(name: string, additionalInstructions?: string) { return this.coreHarness.skill(name, additionalInstructions); }
	promptFromTemplate(name: string, args?: string[]) { return this.coreHarness.promptFromTemplate(name, args); }
	steer(text: string, options?: { images?: ImageContent[] }) { return this.coreHarness.steer(text, options); }
	followUp(text: string, options?: { images?: ImageContent[] }) { return this.coreHarness.followUp(text, options); }
	nextTurn(text: string, options?: { images?: ImageContent[] }) { return this.coreHarness.nextTurn(text, options); }
	appendMessage(message: AgentMessage) { return this.coreHarness.appendMessage(message); }
	compact(customInstructions?: string) { return this.coreHarness.compact(customInstructions); }
	navigateTree(targetId: string, options?: Parameters<AgentHarness["navigateTree"]>[1]): Promise<NavigateTreeResult> { return this.coreHarness.navigateTree(targetId, options); }
	getThinkingLevel(): ThinkingLevel { return this.coreHarness.getThinkingLevel(); }
	setThinkingLevel(level: ThinkingLevel): Promise<void> { return this.coreHarness.setThinkingLevel(level); }
	getSteeringMode(): QueueMode { return this.coreHarness.getSteeringMode(); }
	setSteeringMode(mode: QueueMode): Promise<void> { return this.coreHarness.setSteeringMode(mode); }
	getFollowUpMode(): QueueMode { return this.coreHarness.getFollowUpMode(); }
	setFollowUpMode(mode: QueueMode): Promise<void> { return this.coreHarness.setFollowUpMode(mode); }
	getResources(): AgentHarnessResources<TSkill, TPromptTemplate> { return this.coreHarness.getResources(); }
	setResources(resources: AgentHarnessResources<TSkill, TPromptTemplate>): Promise<void> { return this.coreHarness.setResources(resources); }
	getStreamOptions(): AgentHarnessStreamOptions { return this.coreHarness.getStreamOptions(); }
	setStreamOptions(options: AgentHarnessStreamOptions): Promise<void> { return this.coreHarness.setStreamOptions(options); }
	abort() { return this.coreHarness.abort(); }
	waitForIdle(): Promise<void> { return this.coreHarness.waitForIdle(); }
	subscribe(listener: (event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal) => Promise<void> | void) { return this.coreHarness.subscribe(listener); }

	on<TType extends keyof AgentHarnessEventResultMap>(
		type: TType,
		handler: (event: Extract<AgentHarnessOwnEvent, { type: TType }>) => Promise<AgentHarnessEventResultMap[TType]> | AgentHarnessEventResultMap[TType],
	): () => void {
		return this.coreHarness.on(type, handler);
	}

	async dispose(): Promise<void> {
		await this.abort();
		await this.tools.resources.dispose();
	}
}

const defaultCuaStream: StreamFn = (model, context, options) => cuaModels().streamSimple(model, context, options);

function resolveModelFromCollection(ref: CuaModelRef, models: Models): Model<Api> {
	const { provider, model: id } = parseCuaModelRef(ref);
	if (!findCuaAnnotation(provider, id)) throw new Error(`unsupported CUA model "${ref}"`);
	return models.getModel(provider, id) ?? getCuaModel(ref);
}

function withCatalogModels(
	models: Models,
	manager: CuaToolManager<any>,
	imageReplayLimit: ToolResultImageReplayLimit,
	responseThreading: boolean,
): Models {
	const contextFor = (context: Context) => projectModelContext(
		context,
		imageReplayLimit,
		requiredImageToolNames(manager.catalog.incoming),
	);
	const optionsFor = <T extends SimpleStreamOptions | undefined>(options: T): T => {
		const catalog = manager.catalog;
		const callerOnPayload = options?.onPayload;
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

function resolveToolResultImageReplayLimit(limit: ToolResultImageReplayLimit | undefined): ToolResultImageReplayLimit {
	if (limit === undefined) return DEFAULT_TOOL_RESULT_IMAGE_REPLAY_LIMIT;
	if (limit !== false && (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 0)) {
		throw new TypeError("toolResultImageReplayLimit must be a finite non-negative integer or false");
	}
	return limit;
}

/** Native computer tool names whose screenshot history the provider protocol requires in full, regardless of the image replay limit. */
function requiredImageToolNames(incoming: CuaIncomingToolPlan): ReadonlySet<string> {
	return new Set([incoming.tzafonComputerName, incoming.openaiComputerName].filter((name): name is string => !!name));
}

function projectToolResultImages<TMessage extends AgentMessage>(
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

function resolveEmptyResponseRecovery(options: CuaEmptyResponseRecoveryOptions | undefined): CuaEmptyResponseRecoveryOptions | undefined {
	if (!options) return undefined;
	if (options.followUp.trim().length === 0) throw new Error("emptyResponseRecovery.followUp must not be blank");
	if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 0) throw new Error("emptyResponseRecovery.maxAttempts must be a non-negative finite integer");
	return { followUp: options.followUp, maxAttempts: options.maxAttempts };
}

function resolveResponseThreading(value: boolean | undefined): boolean {
	if (value !== undefined && typeof value !== "boolean") throw new TypeError("responseThreading must be a boolean");
	return value ?? true;
}

function isEmptyAssistantResponse(message: AgentMessage): boolean {
	return message.role === "assistant" && message.stopReason === "stop" && message.content.length === 0;
}

function hasExecutionError(details: unknown): boolean {
	return Boolean(details && typeof details === "object" && (details as CuaExecutionDetails).isError === true);
}

function turnFailureStopMessage(manager: CuaToolManager<any>): string | undefined {
	for (const entry of manager.catalog.entries) {
		const execution = manager.specFor(entry.identity)?.execution;
		if (execution?.kind === "actions" && execution.stopTurnOnFailureMessage) return execution.stopTurnOnFailureMessage;
	}
	return undefined;
}
