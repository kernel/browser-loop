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
import {
	type CuaEmptyResponseRecoveryOptions,
	type CuaModelInput,
	defaultCuaStream,
	hasExecutionError,
	isEmptyAssistantResponse,
	modelTransportChanged,
	projectToolResultImages,
	requiredImageToolNames,
	resolveEmptyResponseRecovery,
	resolveModelFromCollection,
	resolveResponseThreading,
	resolveToolResultImageReplayLimit,
	type ToolResultImageReplayLimit,
	turnFailureStopMessage,
	withCatalogModels,
} from "./attach";
import type { KernelBrowser } from "./translator/translator";

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
	/** Governs Google's `previous_response_id`-style continuation. Every other provider streams through pi's transports and their automatic prompt caching regardless of this flag. Defaults to `true`. */
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
	/** Governs Google's `previous_response_id`-style continuation. Every other provider streams through pi's transports and their automatic prompt caching regardless of this flag. Defaults to `true`. */
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
		this.coreAgent.state.model = prepared.catalog.model;
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
		const previousModel = this.tools.catalog.model;
		const previousTools = this.tools.harnessTools();
		const prepared = this.tools.prepareTools(tools);
		const materialized = this.tools.harnessTools(prepared);
		const transportChanged = modelTransportChanged(previousModel, prepared.catalog.model);
		try {
			if (transportChanged) await this.coreHarness.setModel(prepared.catalog.model);
			await this.coreHarness.setTools(materialized, materialized.map((tool) => tool.name));
		} catch (error) {
			if (transportChanged) await this.coreHarness.setModel(previousModel);
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

	/**
	 * Select a model and its tool list in one compile. A model switch that also
	 * swaps interaction tools would otherwise stage through an intermediate
	 * catalog whose derived transport differs from both the old and the new one,
	 * recording a `model_change` for a transport nothing ever streamed with.
	 */
	async setModelAndTools(model: CuaModelInput, tools: readonly CuaHarnessTool<TContext>[]): Promise<void> {
		const previousModel = this.tools.catalog.model;
		const previousTools = this.tools.harnessTools();
		const prepared = this.tools.prepareModelAndTools(model, tools);
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
