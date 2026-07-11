import {
	Agent,
	AgentHarness,
	type AgentHarnessOptions,
	type AgentMessage,
	type AgentOptions,
	type AgentState,
	type AgentTool,
	type PromptTemplate,
	type Skill,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
	type Api,
	type Context,
	CUA_NAVIGATION_TOOL_NAME,
	CUA_PLAYWRIGHT_TOOL_NAME,
	cuaModels,
	type CuaMode,
	type CuaModelRef,
	type CuaNativeToolSpec,
	type CuaRuntimeSpec,
	type CuaSimpleStreamOptions,
	getCuaEnvApiKey,
	type Model,
	type Models,
	resolveCuaRuntimeSpec,
	type SimpleStreamOptions,
} from "@onkernel/cua-ai";
import type Kernel from "@onkernel/sdk";
import {
	type CuaRetryOptions,
	resolveProviderRetryPolicy,
	withProviderRetry,
	withProviderRetryModels,
} from "./provider-retry";
import { buildCuaComputerTools } from "./tools";
import { InternalComputerTranslator, type KernelBrowser } from "./translator/translator";

/**
 * A model selection: a CUA model ref like `"openai:gpt-5.5"` or a concrete
 * pi model object. Selects *which* model runs; *how* requests stream and
 * authenticate is the `models` collection's concern.
 */
type CuaRuntimeInput = CuaModelRef | Model<Api>;

const DEFAULT_TOOL_RESULT_IMAGE_REPLAY_LIMIT = 4;
const OMITTED_TOOL_RESULT_IMAGES = "[stale tool-result images omitted]";

/**
 * Maximum number of tool-result images included in the request-time message
 * projection, or `false` to leave image blocks unchanged.
 */
export type ToolResultImageReplayLimit = number | false;

function resolveToolResultImageReplayLimit(limit: ToolResultImageReplayLimit | undefined): ToolResultImageReplayLimit {
	if (limit === undefined) return DEFAULT_TOOL_RESULT_IMAGE_REPLAY_LIMIT;
	if (limit !== false && (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 0)) {
		throw new TypeError("toolResultImageReplayLimit must be a finite non-negative integer or false");
	}
	return limit;
}

function projectToolResultImages<TMessage extends AgentMessage>(
	messages: TMessage[],
	limit: ToolResultImageReplayLimit,
): TMessage[] {
	if (limit === false) return messages;

	let imageCount = 0;
	for (const message of messages) {
		if (message.role === "toolResult") {
			imageCount += message.content.filter((block) => block.type === "image").length;
		}
	}
	if (imageCount <= limit) return messages;

	const firstRetainedImage = Math.max(0, imageCount - limit);
	let imageOrdinal = 0;
	return messages.map((message) => {
		if (message.role !== "toolResult") return message;

		let changed = false;
		let markerInserted = false;
		const content: typeof message.content = [];
		for (const block of message.content) {
			if (block.type !== "image") {
				content.push(block);
				continue;
			}
			if (imageOrdinal++ >= firstRetainedImage) {
				content.push(block);
				continue;
			}
			changed = true;
			if (!markerInserted) {
				content.push({ type: "text", text: OMITTED_TOOL_RESULT_IMAGES });
				markerInserted = true;
			}
		}
		return changed ? ({ ...message, content } as TMessage) : message;
	});
}

/**
 * Agent state exposed by {@link CuaAgent}.
 *
 * It is the regular pi `AgentState`, except assigning `state.model` may use a
 * CUA model ref such as `"openai:gpt-5.5"`. CUA-owned tools and the default
 * system prompt are refreshed to match the new provider runtime.
 */
export interface CuaAgentState extends Omit<AgentState, "model"> {
	/** The concrete pi model currently used by the underlying agent loop. */
	get model(): Model<Api>;
	/** Assign a concrete pi model or CUA model ref and refresh CUA runtime defaults. */
	set model(model: CuaRuntimeInput);
}

/** Initial state for {@link CuaAgent}. */
type CuaAgentInitialState = Omit<NonNullable<AgentOptions["initialState"]>, "model" | "tools"> & {
	/** Model to use for the first turn. CUA refs are resolved before pi sees the state. */
	model: CuaRuntimeInput;
};

/** Explicit opt-in policy for continuing after a successful exact-empty assistant response. */
export interface CuaEmptyResponseRecoveryOptions {
	/** User message appended to request another model turn. */
	followUp: string;
	/** Maximum recovery continuations per top-level prompt. */
	maxAttempts: number;
}

/**
 * Constructor options for {@link CuaAgent}.
 *
 * `browser` and `client` are used to build the default computer-use tools.
 * Everything else follows pi `AgentOptions`, with `initialState.model`
 * widened to accept CUA model refs.
 */
export type CuaAgentOptions = Omit<AgentOptions, "initialState"> & {
	/** Kernel browser session used by default CUA tools. */
	browser: KernelBrowser;
	/** Kernel SDK client used by default CUA tools. */
	client: Kernel;
	/** Initial pi state plus a CUA-aware model value. */
	initialState: CuaAgentInitialState;
	/** Add your own pi tools alongside the built-in browser tools. */
	extraTools?: AgentTool[];
	/** Which canonical action plane(s) to expose: "computer" (default), "browser", or "hybrid". */
	mode?: CuaMode;
	/** Drive the model through a provider-native tool declaration (validated against `mode`). */
	nativeTool?: CuaNativeToolSpec;
	/** Expose a tool that runs Playwright code against the browser session. */
	playwright?: boolean;
	/** Explicitly continue successful exact-empty responses with pi's follow-up queue. */
	emptyResponseRecovery?: CuaEmptyResponseRecoveryOptions;
	/** Maximum tool-result images included from message history per provider request. Defaults to 4; false disables projection. */
	toolResultImageReplayLimit?: ToolResultImageReplayLimit;
	/** Chain OpenAI, Meta, and Tzafon requests through provider-stored response state. Defaults to true. */
	responseThreading?: boolean;
	/** Optional CUA-level retries around each provider request. Disabled by default. */
	retry?: CuaRetryOptions;
};

/**
 * Constructor options for {@link CuaAgentHarness}.
 *
 * The harness keeps pi `AgentHarnessOptions` intact except that `model`
 * accepts CUA refs and `browser`/`client` are required to build default
 * computer-use tools. Callers provide pi's `env` and `session` directly.
 */
export type CuaAgentHarnessOptions<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> = Omit<AgentHarnessOptions<TSkill, TPromptTemplate, AgentTool>, "model" | "tools" | "models"> & {
	/** Kernel browser session used by default CUA tools. */
	browser: KernelBrowser;
	/** Kernel SDK client used by default CUA tools. */
	client: Kernel;
	/**
	 * The model the harness starts with (switch later with `setModel()`).
	 * CUA refs are resolved before pi sees the model.
	 */
	model: CuaRuntimeInput;
	/**
	 * pi `Models` provider collection requests stream through — providers,
	 * auth, and stream dispatch, mirroring pi's `AgentHarnessOptions.models`.
	 * Defaults to {@link cuaModels}. Not the model selection; that is `model`.
	 */
	models?: Models;
	/** Add your own pi tools alongside the built-in browser tools. */
	extraTools?: AgentTool[];
	/** Which canonical action plane(s) to expose: "computer" (default), "browser", or "hybrid". */
	mode?: CuaMode;
	/** Drive the model through a provider-native tool declaration (validated against `mode`). */
	nativeTool?: CuaNativeToolSpec;
	/** Expose a tool that runs Playwright code against the browser session. */
	playwright?: boolean;
	/** Optional payload hook composed after the provider-specific CUA payload hook. */
	onPayload?: SimpleStreamOptions["onPayload"];
	/** Explicitly continue successful exact-empty responses with pi's follow-up queue. */
	emptyResponseRecovery?: CuaEmptyResponseRecoveryOptions;
	/** Maximum tool-result images included from message history per provider request. Defaults to 4; false disables projection. */
	toolResultImageReplayLimit?: ToolResultImageReplayLimit;
	/** Chain OpenAI, Meta, and Tzafon requests through provider-stored response state. Defaults to true. */
	responseThreading?: boolean;
	/** Optional CUA-level retries around each provider request. Disabled by default. */
	retry?: CuaRetryOptions;
};

/**
 * Holds the CUA-specific pieces that have to change when a model changes:
 * the resolved runtime spec, the browser translator built for that spec, and
 * the tools/prompt/payload hooks derived from it. Caller-owned `extraTools`
 * are appended after the CUA defaults.
 */
class CuaRuntimeController {
	private runtimeSpec: CuaRuntimeSpec;
	private translator: InternalComputerTranslator;
	private currentMode?: CuaMode;

	constructor(
		private readonly options: {
			browser: KernelBrowser;
			client: Kernel;
			model: CuaRuntimeInput;
			extraTools?: AgentTool[];
			mode?: CuaMode;
			nativeTool?: CuaNativeToolSpec;
			playwright?: boolean;
			onPayload?: SimpleStreamOptions["onPayload"];
		},
	) {
		this.currentMode = options.mode;
		this.runtimeSpec = this.resolveSpec(options.model);
		this.translator = this.createTranslator();
	}

	private resolveSpec(model: CuaRuntimeInput, mode: CuaMode | undefined = this.currentMode): CuaRuntimeSpec {
		return resolveCuaRuntimeSpec(model, {
			mode,
			nativeTool: this.options.nativeTool,
		});
	}

	get model(): Model<Api> {
		return this.runtimeSpec.model;
	}

	get mode(): CuaMode {
		return this.runtimeSpec.mode;
	}

	setMode(mode: CuaMode): void {
		if (mode === this.runtimeSpec.mode) return;
		this.beginSwitch(this.resolveSpec(this.runtimeSpec.model, mode));
		this.currentMode = mode;
	}

	get systemPrompt(): string {
		return this.runtimeSpec.defaultSystemPrompt;
	}

	setModel(model: CuaRuntimeInput): void {
		this.beginSwitch(this.resolveSpec(model));
	}

	// A mode/model switch is two-phase: when the new spec needs a different
	// translator configuration, the outgoing translator must stay alive until
	// the new toolset is actually installed, because on failure the
	// still-exposed pre-switch tools keep executing against it.
	private previousRuntime?: { spec: CuaRuntimeSpec; translator?: InternalComputerTranslator; mode?: CuaMode };

	private beginSwitch(spec: CuaRuntimeSpec): void {
		// The translator only cares about the provider's coordinate system and
		// screenshot transform. Keep it — and its CDP connection, tabs, and
		// refs — whenever those are unchanged (always true for mode switches).
		const replaceTranslator =
			JSON.stringify([spec.coordinateSystem, spec.screenshot]) !==
			JSON.stringify([this.runtimeSpec.coordinateSystem, this.runtimeSpec.screenshot]);
		if (!this.previousRuntime) {
			this.previousRuntime = { spec: this.runtimeSpec, mode: this.currentMode };
		}
		this.runtimeSpec = spec;
		if (!replaceTranslator) return;
		if (this.previousRuntime.translator) {
			// An earlier pending switch already replaced the translator; its
			// replacement was never installed into the exposed tools, so
			// dispose it rather than orphaning it.
			this.translator.dispose();
		} else {
			this.previousRuntime.translator = this.translator;
		}
		this.translator = this.createTranslator();
	}

	/** Dispose the pre-switch translator (when one was replaced) once the new toolset is installed. */
	commitSwitch(): void {
		this.previousRuntime?.translator?.dispose();
		this.previousRuntime = undefined;
	}

	/** Restore the pre-switch runtime; the translator the exposed tools wrap stays live. */
	rollbackSwitch(): void {
		if (!this.previousRuntime) return;
		if (this.previousRuntime.translator) {
			this.translator.dispose();
			this.translator = this.previousRuntime.translator;
		}
		this.runtimeSpec = this.previousRuntime.spec;
		this.currentMode = this.previousRuntime.mode;
		this.previousRuntime = undefined;
	}

	tools(): AgentTool[] {
		return [
			...buildCuaComputerTools(
				{
					toolExecutors: this.runtimeSpec.toolExecutors,
					mode: this.runtimeSpec.mode,
					playwright: this.options.playwright,
				},
				this.translator,
			),
			...(this.options.extraTools ?? []),
		];
	}

	onPayload(): SimpleStreamOptions["onPayload"] {
		const runtimeSpec = this.runtimeSpec;
		const providerOnPayload: SimpleStreamOptions["onPayload"] | undefined = runtimeSpec.onPayload
			? async (payload, model) =>
					runtimeSpec.onPayload?.(payload, model as Model<Api>, {
						keepToolNames: this.keepToolNames(),
						getScreenshot: () => this.translator.screenshot(),
					})
			: undefined;
		return composeOnPayload(providerOnPayload, this.options.onPayload);
	}

	keepToolNames(): string[] {
		return [
			...(this.options.extraTools ?? []).map((tool) => tool.name),
			CUA_NAVIGATION_TOOL_NAME,
			...(this.options.playwright ? [CUA_PLAYWRIGHT_TOOL_NAME] : []),
		];
	}

	private createTranslator(): InternalComputerTranslator {
		return new InternalComputerTranslator({
			browser: this.options.browser,
			client: this.options.client,
			coordinateSystem: this.runtimeSpec.coordinateSystem,
			screenshot: this.runtimeSpec.screenshot,
		});
	}
}

/** Default stream path: the shared CUA `Models` collection. */
const defaultCuaStream: StreamFn = (model, context, options) => cuaModels().streamSimple(model, context, options);

function resolveEmptyResponseRecovery(
	options: CuaEmptyResponseRecoveryOptions | undefined,
): CuaEmptyResponseRecoveryOptions | undefined {
	if (!options) return undefined;
	if (options.followUp.trim().length === 0) {
		throw new Error("emptyResponseRecovery.followUp must not be blank");
	}
	if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 0) {
		throw new Error("emptyResponseRecovery.maxAttempts must be a non-negative finite integer");
	}
	return { followUp: options.followUp, maxAttempts: options.maxAttempts };
}

function isEmptyAssistantResponse(message: AgentMessage): boolean {
	return message.role === "assistant" && message.stopReason === "stop" && message.content.length === 0;
}

function resolveResponseThreading(responseThreading: boolean | undefined): boolean {
	if (responseThreading !== undefined && typeof responseThreading !== "boolean") {
		throw new TypeError("responseThreading must be a boolean");
	}
	return responseThreading ?? true;
}

function withResponseThreading<TOptions extends object | undefined>(
	options: TOptions,
	enabled: boolean,
): TOptions {
	return enabled ? options : { ...options, disableResponseThreading: true };
}

function projectModelContext(context: Context, imageReplayLimit: ToolResultImageReplayLimit): Context {
	const messages = projectToolResultImages(context.messages, imageReplayLimit);
	return messages === context.messages ? context : { ...context, messages };
}

function withContextManagement(
	models: Models,
	imageReplayLimit: ToolResultImageReplayLimit,
	responseThreading: boolean,
): Models {
	if (imageReplayLimit === false && responseThreading) return models;

	const stream: Models["stream"] = (model, context, options) =>
		models.stream(
			model,
			projectModelContext(context, imageReplayLimit),
			withResponseThreading(options, responseThreading),
		);
	const complete: Models["complete"] = (model, context, options) =>
		models.complete(
			model,
			projectModelContext(context, imageReplayLimit),
			withResponseThreading(options, responseThreading),
		);
	const streamSimple: Models["streamSimple"] = (model, context, options) =>
		models.streamSimple(
			model,
			projectModelContext(context, imageReplayLimit),
			withResponseThreading(options, responseThreading),
		);
	const completeSimple: Models["completeSimple"] = (model, context, options) =>
		models.completeSimple(
			model,
			projectModelContext(context, imageReplayLimit),
			withResponseThreading(options, responseThreading),
		);
	return {
		getProviders: () => models.getProviders(),
		getProvider: (id) => models.getProvider(id),
		getModels: (provider) => models.getModels(provider),
		getModel: (provider, id) => models.getModel(provider, id),
		refresh: (provider) => models.refresh(provider),
		getAuth: (model) => models.getAuth(model),
		stream,
		complete,
		streamSimple,
		completeSimple,
	};
}

/**
 * Pi `Agent` configured for Kernel browser computer use.
 *
 * Use this class when you want direct access to the lower-level pi agent state,
 * queues, event stream, and `state.model` mutation model. It resolves CUA model
 * refs, installs provider-appropriate CUA tools by default, and keeps those
 * defaults in sync when `agent.state.model` changes.
 */
export class CuaAgent extends Agent {
	private readonly runtime: CuaRuntimeController;
	private readonly ownsSystemPrompt: boolean;
	private runtimeDirty = false;
	private emptyResponseRecoveryAttempts = 0;
	private stateProxy?: CuaAgentState;
	private stateProxyTarget?: AgentState;

	constructor(options: CuaAgentOptions) {
		const {
			browser,
			client,
			initialState,
			onPayload,
			streamFn,
			prepareNextTurn,
			transformContext,
			extraTools,
			mode,
			nativeTool,
			playwright,
			emptyResponseRecovery,
			toolResultImageReplayLimit,
			responseThreading,
			retry,
			...agentOptions
		} = options;
		const recovery = resolveEmptyResponseRecovery(emptyResponseRecovery);
		const imageReplayLimit = resolveToolResultImageReplayLimit(toolResultImageReplayLimit);
		const useResponseThreading = resolveResponseThreading(responseThreading);
		const runtime = new CuaRuntimeController({
			browser,
			client,
			model: initialState.model,
			extraTools,
			mode,
			nativeTool,
			playwright,
			onPayload,
		});
		const retryingStream = withProviderRetry(
			streamFn ?? defaultCuaStream,
			resolveProviderRetryPolicy(retry),
		);
		const wrappedStreamFn: StreamFn = (model, context, streamOptions) => {
			const optionsWithCuaRuntime: CuaSimpleStreamOptions = {
				...streamOptions,
				onPayload: runtime.onPayload(),
				keepToolNames: runtime.keepToolNames(),
				disableResponseThreading: !useResponseThreading,
			};
			return retryingStream(model, context, optionsWithCuaRuntime);
		};

		super({
			...agentOptions,
			getApiKey: agentOptions.getApiKey ?? getCuaEnvApiKey,
			streamFn: wrappedStreamFn,
			transformContext: async (messages, signal) =>
				projectToolResultImages(
					transformContext ? await transformContext(messages, signal) : messages,
					imageReplayLimit,
				),
			initialState: {
				...initialState,
				model: runtime.model,
				tools: runtime.tools(),
				systemPrompt: initialState.systemPrompt ?? runtime.systemPrompt,
			},
		});

		this.runtime = runtime;
		this.ownsSystemPrompt = initialState.systemPrompt === undefined;
		if (recovery && recovery.maxAttempts > 0) {
			this.subscribe((event, signal) => {
				if (event.type === "agent_start") {
					this.emptyResponseRecoveryAttempts = 0;
					return;
				}
				if (event.type !== "turn_end" || !isEmptyAssistantResponse(event.message)) return;
				this.recoverFromEmptyResponse(recovery, signal);
			});
		}
		/**
		 * pi's loop only re-reads model/tools/prompt between provider requests
		 * through `prepareNextTurn`. The wrapper stays pass-through (returning
		 * `undefined`, i.e. stock pi behavior) until either the user hook returns
		 * an update or a mid-run model assignment marks the CUA runtime dirty —
		 * only then is a turn update built from current state.
		 */
		this.prepareNextTurn = async (signal: AbortSignal | undefined) => {
			const update = await prepareNextTurn?.(signal);
			if (update?.model) {
				this.applyRuntime(update.model as CuaRuntimeInput);
			}
			if (!update && !this.runtimeDirty) return undefined;
			this.runtimeDirty = false;

			const state = super.state;
			const context = update?.context ?? {
				systemPrompt: state.systemPrompt,
				messages: state.messages.slice(),
				tools: state.tools.slice(),
			};

			return {
				...update,
				model: state.model,
				context: {
					...context,
					systemPrompt: this.ownsSystemPrompt ? state.systemPrompt : context.systemPrompt,
					tools: state.tools.slice(),
				},
			};
		};
	}

	/**
	 * Return a state proxy so `agent.state.model = "provider:model"` can behave
	 * like pi's normal mutable state while also re-resolving CUA tools, prompt,
	 * and payload hooks for the selected provider.
	 */
	override get state(): CuaAgentState {
		const target = super.state;
		if (!this.stateProxy || this.stateProxyTarget !== target) {
			this.stateProxyTarget = target;
			this.stateProxy = new Proxy(target, {
				set: (proxied, prop, value, receiver) => {
					if (prop === "model") {
						this.applyRuntime(value as CuaRuntimeInput);
						return true;
					}
					return Reflect.set(proxied, prop, value, receiver);
				},
			}) as CuaAgentState;
		}
		return this.stateProxy;
	}

	/** Switch the action plane(s) exposed to the model; takes effect next turn. */
	setMode(mode: CuaMode): void {
		if (mode === this.runtime.mode) return;
		this.runtime.setMode(mode);
		this.runtimeDirty = true;
		const state = super.state;
		state.tools = this.runtime.tools();
		if (this.ownsSystemPrompt) {
			state.systemPrompt = this.runtime.systemPrompt;
		}
		this.runtime.commitSwitch();
	}

	/** The action plane(s) currently exposed to the model. */
	getMode(): CuaMode {
		return this.runtime.mode;
	}

	private recoverFromEmptyResponse(recovery: CuaEmptyResponseRecoveryOptions, signal: AbortSignal): void {
		if (signal.aborted || this.emptyResponseRecoveryAttempts >= recovery.maxAttempts || this.hasQueuedMessages()) {
			return;
		}
		super.followUp({
			role: "user",
			content: [{ type: "text", text: recovery.followUp }],
			timestamp: Date.now(),
		});
		this.emptyResponseRecoveryAttempts += 1;
	}

	private applyRuntime(model: CuaRuntimeInput): void {
		this.runtime.setModel(model);
		this.runtimeDirty = true;
		const state = super.state;
		state.model = this.runtime.model;
		state.tools = this.runtime.tools();
		if (this.ownsSystemPrompt) {
			state.systemPrompt = this.runtime.systemPrompt;
		}
		this.runtime.commitSwitch();
	}
}

/**
 * Pi `AgentHarness` configured for Kernel browser computer use.
 *
 * Use this class when you want pi's higher-level harness APIs for sessions,
 * resources, prompt templates, queue events, compaction, and model selection.
 * It installs provider CUA tools by default and keeps CUA-owned runtime
 * defaults in sync through `setModel()`.
 */
export class CuaAgentHarness<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> extends AgentHarness<TSkill, TPromptTemplate, AgentTool> {
	private readonly runtime: CuaRuntimeController;
	private requestedActiveToolNames?: string[];
	private emptyResponseRecoveryAttempts = 0;
	private hasPendingActiveQueue = false;

	constructor(options: CuaAgentHarnessOptions<TSkill, TPromptTemplate>) {
		const {
			browser,
			client,
			model,
			models,
			extraTools,
			mode,
			nativeTool,
			playwright,
			systemPrompt,
			onPayload,
			activeToolNames,
			emptyResponseRecovery,
			toolResultImageReplayLimit,
			responseThreading,
			retry,
			...harnessOptions
		} = options;
		const recovery = resolveEmptyResponseRecovery(emptyResponseRecovery);
		const imageReplayLimit = resolveToolResultImageReplayLimit(toolResultImageReplayLimit);
		const useResponseThreading = resolveResponseThreading(responseThreading);
		const runtime = new CuaRuntimeController({
			browser,
			client,
			model,
			extraTools,
			mode,
			nativeTool,
			playwright,
			onPayload,
		});
		const resolvedTools = runtime.tools();
		const retryingModels = withProviderRetryModels(
			models ?? cuaModels(),
			resolveProviderRetryPolicy(retry),
		);
		const contextModels = withContextManagement(retryingModels, imageReplayLimit, useResponseThreading);

		super({
			...harnessOptions,
			model: runtime.model,
			models: contextModels,
			tools: resolvedTools,
			systemPrompt: systemPrompt ?? (() => runtime.systemPrompt),
			activeToolNames: activeToolNames ?? resolvedTools.map((tool) => tool.name),
		});

		this.runtime = runtime;
		this.requestedActiveToolNames = activeToolNames;
		if (recovery && recovery.maxAttempts > 0) {
			this.on("before_agent_start", () => {
				this.emptyResponseRecoveryAttempts = 0;
				this.hasPendingActiveQueue = false;
				return undefined;
			});
			this.subscribe(async (event, signal) => {
				if (event.type === "queue_update") {
					this.hasPendingActiveQueue = event.steer.length > 0 || event.followUp.length > 0;
					return;
				}
				if (event.type !== "turn_end" || !isEmptyAssistantResponse(event.message)) return;
				await this.recoverFromEmptyResponse(recovery, signal);
			});
		}
		this.on("before_provider_payload", async ({ model, payload }: { model: Model<Api>; payload: unknown }) => {
			const onPayload = this.runtime.onPayload();
			if (!onPayload) return { payload };
			return { payload: (await onPayload(payload, model)) ?? payload };
		});
	}

	private async recoverFromEmptyResponse(
		recovery: CuaEmptyResponseRecoveryOptions,
		signal?: AbortSignal,
	): Promise<void> {
		if (signal?.aborted || this.emptyResponseRecoveryAttempts >= recovery.maxAttempts || this.hasPendingActiveQueue) {
			return;
		}
		await super.followUp(recovery.followUp);
		this.emptyResponseRecoveryAttempts += 1;
	}

	/**
	 * Mirror pi `AgentHarness.setModel()` while accepting CUA model refs.
	 *
	 * The override refreshes CUA-owned tools before delegating to pi so the
	 * harness snapshot and session model-change entry are written with the
	 * concrete model selected by `@onkernel/cua-ai`.
	 */
	override async setModel(model: CuaRuntimeInput): Promise<void> {
		this.runtime.setModel(model);
		const tools = this.runtime.tools();
		try {
			await super.setTools(tools, this.requestedActiveToolNames ?? tools.map((tool) => tool.name));
		} catch (err) {
			// The pre-switch tools stay exposed, so restore the runtime they are
			// bound to — including its still-live translator.
			this.runtime.rollbackSwitch();
			throw err;
		}
		this.runtime.commitSwitch();
		await super.setModel(this.runtime.model);
	}

	override async setActiveTools(toolNames: string[]): Promise<void> {
		await super.setActiveTools(toolNames);
		this.requestedActiveToolNames = [...toolNames];
	}

	/**
	 * Switch the action plane(s) exposed to the model and refresh CUA-owned
	 * tools. Throws when the harness was configured with a `nativeTool` whose
	 * plane conflicts with the requested mode.
	 */
	async setMode(mode: CuaMode): Promise<void> {
		if (mode === this.runtime.mode) return;
		const previousNames = new Set(this.getTools().map((tool) => tool.name));
		this.runtime.setMode(mode);
		const tools = this.runtime.tools();
		// Tools that survive the mode switch (extraTools, shared names) keep
		// their requested activation state; names new in this mode activate.
		const requested = this.requestedActiveToolNames;
		const active = requested
			? tools.map((tool) => tool.name).filter((name) => !previousNames.has(name) || requested.includes(name))
			: tools.map((tool) => tool.name);
		try {
			await super.setTools(tools, active);
		} catch (err) {
			// The pre-switch tools stay exposed, so restore the runtime they are
			// bound to — including its still-live translator.
			this.runtime.rollbackSwitch();
			throw err;
		}
		this.runtime.commitSwitch();
		// The requested subset now reflects this mode's toolset; without this a
		// later setModel would restore the pre-switch names.
		if (requested) this.requestedActiveToolNames = active;
	}

	/** The action plane(s) currently exposed to the model. */
	getMode(): CuaMode {
		return this.runtime.mode;
	}
}

function composeOnPayload(first: AgentOptions["onPayload"], second: AgentOptions["onPayload"]): AgentOptions["onPayload"] {
	if (!first) return second;
	if (!second) return first;
	return async (payload, modelRef) => {
		const afterFirst = await first(payload, modelRef);
		return second(afterFirst ?? payload, modelRef);
	};
}
