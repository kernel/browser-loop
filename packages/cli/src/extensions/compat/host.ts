import type { AgentHarness, AgentTool, Session } from "@onkernel/cua-agent";
import type { ImageContent } from "@onkernel/cua-ai";
import {
	AuthStorage,
	discoverAndLoadExtensions,
	ExtensionRunner,
	ModelRegistry,
	SessionManager,
	wrapRegisteredTool,
} from "@earendil-works/pi-coding-agent";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
} from "@earendil-works/pi-coding-agent";
import { createAddToolRegistration } from "../add-tool";
import {
	makeExtensionActions,
	makeExtensionCommandContextActions,
	makeExtensionContextActions,
} from "./context";
import { installExtensionHooks, type ExtensionHookState } from "./hooks";
import { HarnessToolRegistry } from "./tool-registry";

interface ModeAwareAgentHarness extends AgentHarness {
	getMode?(): string;
}

export interface HarnessExtensionHostOptions {
	harness: ModeAwareAgentHarness;
	/** The same `Session` the harness was constructed with; used for entry writes. */
	session: Session;
	cwd: string;
	/** Extension paths passed straight to `discoverAndLoadExtensions`. */
	configuredPaths: string[];
	/** Agent config dir searched for `extensions/`. Pass a temp dir to isolate from `~/.agents`. */
	agentDir?: string;
	/** Capture the first-turn screenshot for extension-initiated user messages. */
	initialScreenshot?: () => Promise<ImageContent[] | undefined>;
	/** Expose the project-local `add_tool` extension. */
	selfExtend?: boolean;
}

export type ReloadOutcome = "reloaded" | "coalesced" | "disposed";

/**
 * Compatibility host for Pi extensions on `AgentHarness`.
 *
 * Pi plans to move coding-agent extensions onto generic AgentHarness hooks and
 * facades. Keep that temporary integration under `extensions/compat`; the CLI
 * depends only on the interface exported by `extensions/setup`.
 */
export class HarnessExtensionHost {
	private readonly harness: ModeAwareAgentHarness;
	private readonly session: Session;
	private readonly cwd: string;
	private readonly configuredPaths: string[];
	private readonly agentDir?: string;
	private readonly initialScreenshot?: () => Promise<
		ImageContent[] | undefined
	>;
	private readonly selfExtend: boolean;
	private readonly extensionRoot: string | undefined;
	private readonly sessionManager: SessionManager;
	private readonly modelRegistry: ModelRegistry;
	private readonly tools: HarnessToolRegistry;
	private readonly actions: ExtensionActions;
	private readonly contextActions: ExtensionContextActions;
	private readonly commandActions: ExtensionCommandContextActions;

	private runner: ExtensionRunner | undefined;
	private teardownHooks: (() => void) | undefined;
	private readonly hookState: ExtensionHookState = { turnIndex: 0, isIdle: true };
	private reloadPromise: Promise<ReloadOutcome> | undefined;
	private shutdownRequested = false;
	private disposed = false;
	private teardownDone = false;
	private loaded = false;
	private startedUp = false;
	private sessionName: string | undefined;

	loadErrors: Array<{ path: string; error: string }> = [];

	constructor(options: HarnessExtensionHostOptions) {
		this.harness = options.harness;
		this.session = options.session;
		this.cwd = options.cwd;
		this.configuredPaths = options.configuredPaths;
		this.agentDir = options.agentDir;
		this.initialScreenshot = options.initialScreenshot;
		this.selfExtend = options.selfExtend ?? false;
		this.extensionRoot = options.configuredPaths[0];
		this.sessionManager = SessionManager.inMemory(this.cwd);
		this.modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
		this.tools = new HarnessToolRegistry(this.harness, (path, error) =>
			this.recordError(path, error),
		);

		this.actions = makeExtensionActions(this.harness, this.session, {
			refreshTools: () => this.refreshTools(),
			getActiveTools: () => this.tools.desiredActiveToolNames(this.runner),
			sendUserMessage: (text) => this.promptUserMessage(text),
			setActiveTools: (names) => this.tools.applyActiveTools(names),
			getSessionName: () => this.sessionName,
			setSessionName: (name) => {
				this.sessionName = name;
			},
		});
		this.contextActions = makeExtensionContextActions(this.harness, {
			isIdle: () => this.hookState.isIdle,
			getSignal: () => undefined,
			shutdown: () => this.requestShutdown(),
		});
		this.commandActions = makeExtensionCommandContextActions(
			this.harness,
			async () => {
				await this.reload();
			},
		);
	}

	isDisposed(): boolean {
		return this.disposed;
	}

	async load(): Promise<void> {
		if (this.disposed) throw new Error("cannot load a disposed extension host");
		if (this.loaded) return;
		await this.buildRunner();
		try {
			const runner = this.runner!;
			await this.tools.reapply(runner, () => runner === this.runner);
			this.installHooks();
			await runner.emit({ type: "session_start", reason: "startup" });
		} catch (error) {
			this.uninstallHooks();
			this.runner?.invalidate();
			this.runner = undefined;
			throw error;
		}
		this.loaded = true;
		this.startedUp = true;
		if (this.shutdownRequested) await this.dispose();
	}

	reload(): Promise<ReloadOutcome> {
		if (this.disposed) return Promise.resolve("disposed");
		if (this.reloadPromise) return Promise.resolve("coalesced");
		const operation = this.reloadNow();
		this.reloadPromise = operation;
		const clear = () => {
			if (this.reloadPromise === operation) this.reloadPromise = undefined;
		};
		void operation.then(clear, clear);
		return operation;
	}

	async dispose(): Promise<void> {
		if (this.teardownDone) return;
		this.shutdownRequested = true;
		this.disposed = true;
		await this.reloadPromise?.catch(() => {});
		await this.tools.waitForSettled();
		await this.disposeNow();
	}

	private async reloadNow(): Promise<ReloadOutcome> {
		await this.harness.waitForIdle();
		if (this.disposed) return "disposed";

		const previousRunner = this.runner;
		const previousLoadErrors = this.loadErrors;
		const flags = previousRunner?.getFlagValues() ?? new Map();
		const candidate = await this.createRunner();
		if (this.disposed) {
			candidate.runner.invalidate();
			return "disposed";
		}
		for (const [name, value] of flags) candidate.runner.setFlagValue(name, value);

		await previousRunner?.emit({ type: "session_shutdown", reason: "reload" });
		if (this.disposed || this.shutdownRequested) {
			candidate.runner.invalidate();
			await this.disposeNow();
			return "disposed";
		}

		this.uninstallHooks();
		this.runner = candidate.runner;
		this.loadErrors = candidate.loadErrors;
		const registrySnapshot = this.tools.beginRunnerReplacement(candidate.hostTool);
		try {
			await this.tools.reapply(
				candidate.runner,
				() => candidate.runner === this.runner && !this.disposed,
			);
			if (this.disposed || this.shutdownRequested) {
				candidate.runner.invalidate();
				previousRunner?.invalidate();
				await this.disposeNow();
				return "disposed";
			}
			this.installHooks();
			await candidate.runner.emit({ type: "session_start", reason: "reload" });
			if (this.disposed || this.shutdownRequested) {
				previousRunner?.invalidate();
				await this.disposeNow();
				return "disposed";
			}
			previousRunner?.invalidate();
			return "reloaded";
		} catch (error) {
			candidate.runner.invalidate();
			this.uninstallHooks();
			this.runner = previousRunner;
			this.loadErrors = previousLoadErrors;
			this.tools.restore(registrySnapshot);
			if (!this.disposed && previousRunner) {
				await this.tools
					.reapply(previousRunner, () => previousRunner === this.runner)
					.catch(() => {});
				this.installHooks();
				await previousRunner.emit({ type: "session_start", reason: "reload" });
			}
			throw error;
		}
	}

	private async disposeNow(): Promise<void> {
		if (this.teardownDone) return;
		this.teardownDone = true;
		this.shutdownRequested = true;
		this.disposed = true;
		this.uninstallHooks();
		await this.tools.removeAll().catch(() => {});
		const runner = this.runner;
		await runner?.emit({ type: "session_shutdown", reason: "quit" });
		runner?.invalidate();
		this.runner = undefined;
	}

	private async buildRunner(): Promise<void> {
		const built = await this.createRunner();
		this.loadErrors = built.loadErrors;
		this.runner = built.runner;
		this.tools.setHostTool(built.hostTool);
	}

	private async createRunner(): Promise<{
		runner: ExtensionRunner;
		hostTool: AgentTool | undefined;
		loadErrors: Array<{ path: string; error: string }>;
	}> {
		const result = await discoverAndLoadExtensions(
			this.configuredPaths,
			this.cwd,
			this.agentDir,
		);
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			this.cwd,
			this.sessionManager,
			this.modelRegistry,
		);
		runner.bindCore(this.actions, this.contextActions);
		runner.bindCommandContext(this.commandActions);
		runner.setUIContext(undefined, "print");

		const hostTool = this.selfExtend
			? wrapRegisteredTool(
					createAddToolRegistration({
						cwd: this.cwd,
						extensionRoot: this.extensionRoot,
						hasToolName: (name) => this.tools.hasToolName(name),
						installTool: (registration) =>
							this.tools.installRuntimeTool(
								registration,
								runner,
								() => runner === this.runner && !this.disposed,
							),
					}),
					runner,
				)
			: undefined;
		return { runner, hostTool, loadErrors: result.errors };
	}

	private refreshTools(): void {
		const runner = this.runner;
		if (!runner) return;
		void this.tools
			.reapply(runner, () => runner === this.runner && !this.disposed)
			.catch((error) =>
				this.recordError(
					"<tools_update>",
					error instanceof Error ? error.message : String(error),
				),
			);
	}

	private installHooks(): void {
		const runner = this.runner;
		if (!runner) return;
		this.teardownHooks = installExtensionHooks(
			this.harness,
			runner,
			this.hookState,
			() => this.tools.reapply(runner, () => runner === this.runner && !this.disposed),
		);
	}

	private uninstallHooks(): void {
		const teardown = this.teardownHooks;
		this.teardownHooks = undefined;
		teardown?.();
	}

	private recordError(path: string, error: string): void {
		if (this.loadErrors.some((entry) => entry.path === path && entry.error === error)) {
			return;
		}
		this.loadErrors.push({ path, error });
	}

	private requestShutdown(): void {
		this.shutdownRequested = true;
		if (!this.reloadPromise) void this.dispose();
	}

	private async promptUserMessage(text: string): Promise<void> {
		try {
			const images = await this.maybeInitialScreenshot();
			await this.harness.prompt(text, images ? { images } : undefined);
		} catch (error) {
			this.recordError(
				"<sendUserMessage>",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	private async maybeInitialScreenshot(): Promise<ImageContent[] | undefined> {
		if (!this.initialScreenshot || !this.startedUp) return undefined;
		if (this.harness.getMode?.() === "browser") return undefined;
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
