import {
	Agent,
	AgentHarness,
	type AgentHarnessOptions,
	type AgentOptions,
	type AgentState,
	type AgentTool,
	type PromptTemplate,
	type Skill,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
	type Api,
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
import { buildCuaComputerTools } from "./tools";
import { InternalComputerTranslator, type KernelBrowser } from "./translator/translator";

/**
 * A model selection: a CUA model ref like `"openai:gpt-5.5"` or a concrete
 * pi model object. Selects *which* model runs; *how* requests stream and
 * authenticate is the `models` collection's concern.
 */
type CuaRuntimeInput = CuaModelRef | Model<Api>;

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
		// A repeated selection must not replace the translator: disposing it
		// would drop snapshot refs, tab context, and the CDP connection.
		if (mode === this.runtimeSpec.mode) return;
		const spec = this.resolveSpec(this.runtimeSpec.model, mode);
		this.beginSwitch(spec);
		this.currentMode = mode;
	}

	get systemPrompt(): string {
		return this.runtimeSpec.defaultSystemPrompt;
	}

	setModel(model: CuaRuntimeInput): void {
		this.beginSwitch(this.resolveSpec(model));
	}

	// A mode/model switch is two-phase: the outgoing translator must stay
	// alive until the new toolset is actually installed, because on failure
	// the still-exposed pre-switch tools keep executing against it.
	private previousRuntime?: { spec: CuaRuntimeSpec; translator: InternalComputerTranslator; mode?: CuaMode };

	private beginSwitch(spec: CuaRuntimeSpec): void {
		this.previousRuntime = { spec: this.runtimeSpec, translator: this.translator, mode: this.currentMode };
		this.runtimeSpec = spec;
		this.translator = this.createTranslator();
	}

	/** Dispose the pre-switch translator once the new toolset is installed. */
	commitSwitch(): void {
		this.previousRuntime?.translator.dispose();
		this.previousRuntime = undefined;
	}

	/** Restore the pre-switch runtime; the translator the exposed tools wrap stays live. */
	rollbackSwitch(): void {
		if (!this.previousRuntime) return;
		this.translator.dispose();
		this.runtimeSpec = this.previousRuntime.spec;
		this.translator = this.previousRuntime.translator;
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
			mode: this.runtimeSpec.mode,
		});
	}
}

/** Default stream path: the shared CUA `Models` collection. */
const defaultCuaStream: StreamFn = (model, context, options) => cuaModels().streamSimple(model, context, options);

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
			extraTools,
			mode,
			nativeTool,
			playwright,
			...agentOptions
		} = options;
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
		const wrappedStreamFn: StreamFn = (model, context, streamOptions) => {
			const optionsWithCuaRuntime: CuaSimpleStreamOptions = {
				...streamOptions,
				onPayload: runtime.onPayload(),
				keepToolNames: runtime.keepToolNames(),
			};
			return (streamFn ?? defaultCuaStream)(model, context, optionsWithCuaRuntime);
		};

		super({
			...agentOptions,
			getApiKey: agentOptions.getApiKey ?? getCuaEnvApiKey,
			streamFn: wrappedStreamFn,
			initialState: {
				...initialState,
				model: runtime.model,
				tools: runtime.tools(),
				systemPrompt: initialState.systemPrompt ?? runtime.systemPrompt,
			},
		});

		this.runtime = runtime;
		this.ownsSystemPrompt = initialState.systemPrompt === undefined;
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
			...harnessOptions
		} = options;
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

		super({
			...harnessOptions,
			model: runtime.model,
			models: models ?? cuaModels(),
			tools: resolvedTools,
			systemPrompt: systemPrompt ?? (() => runtime.systemPrompt),
			activeToolNames: activeToolNames ?? resolvedTools.map((tool) => tool.name),
		});

		this.runtime = runtime;
		this.requestedActiveToolNames = activeToolNames;
		this.on("before_provider_payload", async ({ model, payload }: { model: Model<Api>; payload: unknown }) => {
			const onPayload = this.runtime.onPayload();
			if (!onPayload) return { payload };
			return { payload: (await onPayload(payload, model)) ?? payload };
		});
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
