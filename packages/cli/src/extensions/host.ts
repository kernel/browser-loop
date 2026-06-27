import type { AgentHarness, AgentTool, Session } from "@onkernel/cua-agent";
import type { ImageContent } from "@onkernel/cua-ai";
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
	/**
	 * Capture the first-turn screenshot for extension-initiated user messages, so
	 * `pi.sendUserMessage` follows the same convention as the CLI's own prompt
	 * call sites. Omit in headless contexts with no browser; when absent the first
	 * turn is sent without an attached screenshot.
	 */
	initialScreenshot?: () => Promise<ImageContent[] | undefined>;
	/**
	 * When false (default), the implicit `<cwd>/.pi/extensions` project scan is
	 * suppressed by passing a project-config-dir-free cwd to the loader; global
	 * `<agentDir>/extensions` and `configuredPaths` still load. Gate this on
	 * project trust — project extensions execute arbitrary TypeScript in-process.
	 */
	projectExtensionsTrusted?: boolean;
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
	private readonly initialScreenshot?: () => Promise<ImageContent[] | undefined>;
	private readonly projectExtensionsTrusted: boolean;
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
	/** Extension tools turned off via the seam; not auto-re-enabled on reapply. */
	private readonly inactiveExtensionTools = new Set<string>();
	/** Guards `harness.setTools` so a tools_update never re-enters reapply. */
	private applyingTools = false;
	/** Set when a reapply is requested while `harness.setTools` is in flight. */
	private reapplyQueued = false;
	/** True inside `reload`'s critical section so shutdown requests are deferred. */
	private reloading = false;
	/** Sticky shutdown request raised by `ctx.shutdown()` or owner disposal. */
	private shutdownRequested = false;
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
		this.initialScreenshot = options.initialScreenshot;
		this.projectExtensionsTrusted = options.projectExtensionsTrusted ?? false;
		this.sessionManager = SessionManager.inMemory(this.cwd);
		this.modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());

		this.actions = makeExtensionActions(this.harness, this.session, {
			refreshTools: () => void this.reapplyTools(),
			sendUserMessage: (text) => this.promptUserMessage(text),
			setActiveTools: (names) => this.applyActiveTools(names),
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
		if (this.disposed) return;
		const flags = this.runner?.getFlagValues() ?? new Map<string, boolean | string>();
		// `reloading` defers any `ctx.shutdown()` raised by an extension's
		// session_shutdown handler so an unawaited dispose can't tear down the
		// runner/bridge mid-rebuild. Each await boundary then honors a pending
		// request before continuing.
		this.reloading = true;
		try {
			await this.runner?.emit({ type: "session_shutdown", reason: "reload" });
			if (await this.disposeIfShutdownRequested()) return;
			this.teardownBridge?.();
			this.teardownBridge = undefined;

			await this.buildRunner();
			if (await this.disposeIfShutdownRequested()) return;
			for (const [name, value] of flags) this.runner?.setFlagValue(name, value);

			await this.reapplyTools();
			if (await this.disposeIfShutdownRequested()) return;
			this.installBridge();
			await this.runner?.emit({ type: "session_start", reason: "reload" });
		} finally {
			this.reloading = false;
		}
		// Honor a shutdown requested during the final emit, after `reloading` cleared.
		if (this.shutdownRequested) await this.dispose();
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
		this.shutdownRequested = true;
		this.disposed = true;
		this.teardownBridge?.();
		this.teardownBridge = undefined;
		await this.runner?.emit({ type: "session_shutdown", reason: "quit" });
		this.runner = undefined;
	}

	private async buildRunner(): Promise<void> {
		// The loader always scans `<discoverCwd>/.pi/extensions` with no trust gate
		// and executes each factory during load, so an untrusted project must never
		// see its real cwd here. Redirecting only the discovery cwd (not the host's
		// `this.cwd`) keeps SessionManager/exec cwd intact for global extensions
		// while making the implicit project scan resolve to an absent dir.
		const discoverCwd = this.projectExtensionsTrusted ? this.cwd : this.agentDir ?? this.cwd;
		const result = await discoverAndLoadExtensions(this.configuredPaths, discoverCwd, this.agentDir);
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
	 * rejects duplicates). Base-tool active state is taken from the harness, then
	 * every extension tool is re-activated unless it was explicitly deactivated
	 * through the host's `setActiveTools` seam (`inactiveExtensionTools`). This
	 * keeps extension tools available across a `setModel` — which rebuilds the
	 * harness tool list from construction-time tools and drops them — while still
	 * honoring an opt-out. A reapply requested while `harness.setTools` is in
	 * flight is coalesced into a follow-up pass rather than dropped.
	 */
	private async reapplyTools(): Promise<void> {
		if (!this.runner) return;
		if (this.applyingTools) {
			this.reapplyQueued = true;
			return;
		}
		do {
			this.reapplyQueued = false;
			if (!this.runner) return;
			// Prior-generation extension tool names must be dropped from base even
			// when the new generation no longer registers them: after a reload that
			// removes or renames an extension's tool, the stale tool is still on the
			// harness and absent from the new set, so without this it would survive
			// bound to the dead runner generation.
			const priorExtensionNames = new Set(this.extensionTools.map((tool) => tool.name));
			const nextExtensionTools = wrapRegisteredTools(
				this.runner.getAllRegisteredTools(),
				this.runner,
			);
			const extensionNames = new Set(nextExtensionTools.map((tool) => tool.name));
			const base = this.harness
				.getTools()
				.filter((tool) => !extensionNames.has(tool.name) && !priorExtensionNames.has(tool.name));
			const final = [...base, ...nextExtensionTools];
			const finalNames = new Set(final.map((tool) => tool.name));
			const activeNames = new Set(
				this.harness
					.getActiveTools()
					.map((tool) => tool.name)
					.filter((name) => finalNames.has(name)),
			);
			for (const name of extensionNames) {
				if (!this.inactiveExtensionTools.has(name)) activeNames.add(name);
			}
			this.extensionTools = nextExtensionTools;
			this.applyingTools = true;
			try {
				await this.harness.setTools(final, [...activeNames]);
			} finally {
				this.applyingTools = false;
			}
		} while (this.reapplyQueued);
	}

	/**
	 * Apply an extension-requested active-tool set, recording which extension
	 * tools were turned off so `reapplyTools` won't silently re-enable them.
	 */
	private async applyActiveTools(names: string[]): Promise<void> {
		const active = new Set(names);
		for (const tool of this.extensionTools) {
			if (active.has(tool.name)) this.inactiveExtensionTools.delete(tool.name);
			else this.inactiveExtensionTools.add(tool.name);
		}
		await this.harness.setActiveTools(names);
	}

	private installBridge(): void {
		if (!this.runner) return;
		this.teardownBridge = installBridge(this.harness, this.runner, this.bridgeState, () =>
			this.reapplyTools(),
		);
	}

	private requestShutdown(): void {
		this.shutdownRequested = true;
		// During reload the request is latched and honored at the next await
		// boundary; outside reload, dispose immediately.
		if (this.reloading) return;
		void this.dispose();
	}

	/** Honor a shutdown latched during reload. Returns true if the host disposed. */
	private async disposeIfShutdownRequested(): Promise<boolean> {
		if (!this.shutdownRequested && !this.disposed) return false;
		await this.dispose();
		return true;
	}

	/**
	 * Forward an extension-initiated user message through `harness.prompt`,
	 * attaching the first-turn screenshot when this is the session's first turn —
	 * matching the CLI's own prompt call sites.
	 */
	private async promptUserMessage(text: string): Promise<void> {
		const images = await this.maybeInitialScreenshot();
		await this.harness.prompt(text, images ? { images } : undefined);
	}

	private async maybeInitialScreenshot(): Promise<ImageContent[] | undefined> {
		if (!this.initialScreenshot) return undefined;
		if (await sessionHasPriorTurn(this.session)) return undefined;
		return this.initialScreenshot();
	}
}

async function sessionHasPriorTurn(session: Session): Promise<boolean> {
	const entries = await session.getBranch();
	return entries.some(
		(entry) =>
			entry.type === "message" &&
			(entry.message.role === "user" || entry.message.role === "assistant"),
	);
}
