import type { AgentHarness, AgentTool, Session } from "@onkernel/cua-agent";
import {
	AuthStorage,
	discoverAndLoadExtensions,
	ExtensionRunner,
	ModelRegistry,
	SessionManager,
	wrapRegisteredTools,
} from "@earendil-works/pi-coding-agent";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
} from "@earendil-works/pi-coding-agent";
import { installBridge, type BridgeState } from "./bridge";
import {
	makeExtensionActions,
	makeExtensionCommandContextActions,
	makeExtensionContextActions,
} from "./seams";

export interface HarnessExtensionHostOptions {
	harness: AgentHarness;
	/** The same `Session` the harness was constructed with; used for entry writes. */
	session: Session;
	cwd: string;
	/** Extension paths passed straight to `discoverAndLoadExtensions`. */
	configuredPaths: string[];
	/** Agent config dir searched for `extensions/`. Pass a temp dir to isolate from `~/.agents`. */
	agentDir?: string;
}

/**
 * Host that plays pi `AgentSession`'s role against a `CuaAgentHarness`.
 *
 * It discovers and loads pi extensions through pi's host-agnostic loader and
 * runner, binds the runner's action seams to the harness, registers extension
 * tools, bridges harness events into the runner's extension-event emitters, and
 * mirrors `AgentSession.reload`. Everything runs headless: the runner falls back
 * to its internal no-op UI context, so `ctx.hasUI` is false and extensions that
 * guard on it short-circuit.
 *
 * Tier A only. Deferred (documented as follow-ups): `ctx.ui.*`, command/shortcut/
 * flag/renderer registration, the session-replacement family (stubbed to throw),
 * provider registration, and the message_end/input/user_bash/resources_discover
 * reducers.
 */
export class HarnessExtensionHost {
	private readonly harness: AgentHarness;
	private readonly session: Session;
	private readonly cwd: string;
	private readonly configuredPaths: string[];
	private readonly agentDir?: string;
	private readonly sessionManager: SessionManager;
	private readonly modelRegistry: ModelRegistry;

	private readonly actions: ExtensionActions;
	private readonly contextActions: ExtensionContextActions;
	private readonly commandActions: ExtensionCommandContextActions;

	private runner: ExtensionRunner | undefined;
	private teardownBridge: (() => void) | undefined;
	private readonly bridgeState: BridgeState = { turnIndex: 0, isIdle: true };

	/** Tools produced by the runner this generation. Re-applied after model switches. */
	private extensionTools: AgentTool[] = [];
	/** Guards `harness.setTools` so a tools_update never re-enters reapply. */
	private applyingTools = false;
	/** Guards `dispose` so `ctx.shutdown()` and an owner call don't double-tear-down. */
	private disposed = false;
	private sessionName: string | undefined;

	/** Load errors surfaced from the last discover; non-fatal. */
	loadErrors: Array<{ path: string; error: string }> = [];

	constructor(options: HarnessExtensionHostOptions) {
		this.harness = options.harness;
		this.session = options.session;
		this.cwd = options.cwd;
		this.configuredPaths = options.configuredPaths;
		this.agentDir = options.agentDir;
		this.sessionManager = SessionManager.inMemory(this.cwd);
		this.modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());

		this.actions = makeExtensionActions(this.harness, this.session, {
			refreshTools: () => void this.reapplyTools(),
			getSessionName: () => this.sessionName,
			setSessionName: (name) => {
				this.sessionName = name;
			},
		});
		this.contextActions = makeExtensionContextActions(this.harness, {
			isIdle: () => this.bridgeState.isIdle,
			getSignal: () => undefined,
			shutdown: () => this.requestShutdown(),
		});
		this.commandActions = makeExtensionCommandContextActions(this.harness, () => this.reload());
	}

	async load(): Promise<void> {
		await this.buildRunner();
		await this.reapplyTools();
		this.installBridge();
		await this.runner?.emit({ type: "session_start", reason: "startup" });
	}

	/**
	 * Mirror `AgentSession.reload`: carry over flag values, tear down the old
	 * runner's bridge, re-discover extensions from disk, build a fresh runner over
	 * the same in-memory services, restore flags, rebind, re-apply tools, reinstall
	 * the bridge, then emit `session_start`. No extension cache is cleared because
	 * the loader imports each extension fresh from disk.
	 */
	async reload(): Promise<void> {
		const flags = this.runner?.getFlagValues() ?? new Map<string, boolean | string>();
		await this.runner?.emit({ type: "session_shutdown", reason: "reload" });
		this.teardownBridge?.();
		this.teardownBridge = undefined;

		await this.buildRunner();
		for (const [name, value] of flags) this.runner?.setFlagValue(name, value);

		await this.reapplyTools();
		this.installBridge();
		await this.runner?.emit({ type: "session_start", reason: "reload" });
	}

	/**
	 * Tear down the host: detach the bridge and notify extensions via
	 * `session_shutdown`. Idempotent — `ctx.shutdown()` routes here through
	 * `requestShutdown`, and the test/owner also calls it, so a guard keeps the
	 * two paths from running teardown twice. Note `runner.shutdown()` is pi's
	 * "request graceful shutdown" entrypoint (it invokes the bound shutdown
	 * handler), not a runner teardown, so it must not be called here.
	 */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.teardownBridge?.();
		this.teardownBridge = undefined;
		await this.runner?.emit({ type: "session_shutdown", reason: "quit" });
		this.runner = undefined;
	}

	private async buildRunner(): Promise<void> {
		const result = await discoverAndLoadExtensions(this.configuredPaths, this.cwd, this.agentDir);
		this.loadErrors = result.errors;
		this.runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			this.cwd,
			this.sessionManager,
			this.modelRegistry,
		);
		this.runner.bindCore(this.actions, this.contextActions);
		this.runner.bindCommandContext(this.commandActions);
		this.runner.setUIContext(undefined, "print");
	}

	/**
	 * Rebuild the extension-tool union and apply it to the harness as the
	 * authoritative tool list. Extension tools are de-duped by name (the harness
	 * rejects duplicates) and kept active alongside the base tools. The
	 * re-entrancy guard makes a stray `tools_update` subscriber safe; reapply is
	 * only triggered from `load`/`reload`/`model_update`/`refreshTools`, none of
	 * which run concurrently.
	 */
	private async reapplyTools(): Promise<void> {
		if (!this.runner || this.applyingTools) return;
		this.extensionTools = wrapRegisteredTools(this.runner.getAllRegisteredTools(), this.runner);
		const extensionNames = new Set(this.extensionTools.map((tool) => tool.name));
		const base = this.harness.getTools().filter((tool) => !extensionNames.has(tool.name));
		const final = [...base, ...this.extensionTools];
		const activeNames = [
			...this.harness.getActiveTools().map((tool) => tool.name),
			...extensionNames,
		];
		this.applyingTools = true;
		try {
			await this.harness.setTools(final, [...new Set(activeNames)]);
		} finally {
			this.applyingTools = false;
		}
	}

	private installBridge(): void {
		if (!this.runner) return;
		this.teardownBridge = installBridge(this.harness, this.runner, this.bridgeState, () =>
			this.reapplyTools(),
		);
	}

	private requestShutdown(): void {
		void this.dispose();
	}
}
