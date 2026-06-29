import type { AgentHarness, AgentTool, AgentToolResult, Session } from "@onkernel/cua-agent";
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
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
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
	 * Opt-in: expose the `write_extension` tool so the agent can author its own
	 * tools at runtime. Off by default; when off the tool is not registered.
	 */
	selfExtend?: boolean;
}

/** Structured details for a `write_extension` tool result. */
interface WriteExtensionDetails {
	/** Absolute path the extension file was written to. */
	written: string;
	/** True only when the trial load parsed and registered at least one tool. */
	valid: boolean;
	/** Tool names the trial load registered from the authored file. */
	registeredTools: string[];
	/** Errors from trial-loading the authored file in isolation. */
	loadErrors: Array<{ path: string; error: string }>;
	/** Load errors from the live host's last discover, surfaced for context. */
	hostLoadErrors: Array<{ path: string; error: string }>;
}

/**
 * Result of a {@link HarnessExtensionHost.reload} call, so callers like the
 * `/reload` command can report honestly instead of assuming success:
 * - `reloaded`  — extensions were re-discovered and re-applied.
 * - `coalesced` — a reload was already in flight; this request was latched onto
 *   it rather than run concurrently, so nothing new was applied yet.
 * - `disposed`  — the host was (or became) torn down, so no reload happened.
 */
export type ReloadOutcome = "reloaded" | "coalesced" | "disposed";

const WRITE_EXTENSION_TOOL_NAME = "write_extension";

const WRITE_EXTENSION_DESCRIPTION = [
	"Author a new tool for yourself at runtime by writing a TypeScript extension",
	"file. The file is validated immediately and joins your toolset at the next",
	"idle boundary (after the current run completes), so the tool you write is",
	"callable on a subsequent prompt without any manual reload.",
	"",
	"The `code` must be a complete extension module that default-exports a factory:",
	"  export default function (pi) {",
	"    pi.registerTool({",
	"      name, label, description,",
	"      parameters: <plain JSON Schema object literal>,",
	"      async execute(id, params) {",
	'        return { content: [{ type: "text", text: "..." }], details: {} };',
	"      },",
	"    });",
	"  }",
	"",
	"Hard rules — a file that breaks any of these fails to load:",
	"- No bare runtime imports. Type-only imports (import type { ... }) are fine",
	"  because they are erased; a runtime import of any package cannot be resolved",
	"  by the loader and hangs it.",
	"- Declare `parameters` as an inline plain JSON Schema object literal",
	"  (type/properties/required/additionalProperties). Never import a schema",
	"  builder.",
	"- Every execute() result must include a `details` object (it may be empty).",
	"",
	"The result reports `valid`, the registered tool names, and any load errors so",
	"you can fix a broken file and call this again.",
].join("\n");

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
	private readonly sessionManager: SessionManager;
	private readonly modelRegistry: ModelRegistry;

	/**
	 * Host-provided tools folded into the authoritative set on every reapply.
	 * Empty unless `selfExtend` is on, in which case it holds `write_extension`.
	 * Kept separate from extension tools so they survive both reload and
	 * `setModel`'s tool rebuild.
	 */
	private readonly hostTools: AgentTool[];

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
	/** Set by `write_extension`; drained into a single reload at the next idle boundary. */
	private reloadRequested = false;
	/** The in-flight queued reload, so a drain can await one already running. */
	private pendingReload: Promise<ReloadOutcome> | undefined;
	/** Sticky shutdown request raised by `ctx.shutdown()` or owner disposal. */
	private shutdownRequested = false;
	/** Guards `dispose` so `ctx.shutdown()` and an owner call don't double-tear-down. */
	private disposed = false;
	/** Guards the actual teardown (`disposeNow`); `disposed` is set before the await. */
	private teardownDone = false;
	/** True once `load()` has run; guards against double-load and load-after-dispose. */
	private loaded = false;
	/**
	 * False until `load()` finishes emitting the startup `session_start`. While
	 * false, an extension-initiated `sendUserMessage` does not consume the
	 * first-turn screenshot, so it can't pre-empt the user's real first prompt.
	 */
	private startedUp = false;
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
		this.commandActions = makeExtensionCommandContextActions(this.harness, async () => {
			await this.reload();
		});
		this.hostTools = options.selfExtend ? [this.makeWriteExtensionTool()] : [];
	}

	/** True once the host has been torn down (via dispose or `ctx.shutdown()`). */
	isDisposed(): boolean {
		return this.disposed;
	}

	async load(): Promise<void> {
		// One-shot: a disposed host can't be revived (load would rebuild the runner
		// while `disposed` stays true, leaving dispose/reload/shutdown as no-ops),
		// and a second load would stack a second bridge over the first. reload() is
		// the supported way to re-discover extensions.
		if (this.disposed) throw new Error("cannot load a disposed extension host");
		if (this.loaded) return;
		await this.buildRunner();
		await this.reapplyTools();
		this.installBridge();
		await this.runner?.emit({ type: "session_start", reason: "startup" });
		// Mark loaded only after wiring succeeds: an earlier throw leaves `loaded`
		// false so a half-built host (no bridge or tool union) isn't mistaken for
		// ready by a later load() call.
		this.loaded = true;
		// Startup is over: from here an extension sendUserMessage may carry the
		// first-turn screenshot (it can no longer steal it from the user's first
		// prompt, which the CLI captured before extensions loaded).
		this.startedUp = true;
		// An extension that calls ctx.shutdown() during session_start disposes via
		// requestShutdown; honor it so load doesn't resolve a torn-down host as ready.
		if (this.shutdownRequested) await this.dispose();
	}

	/**
	 * Mirror `AgentSession.reload`: carry over flag values, tear down the old
	 * runner's bridge, re-discover extensions from disk, build a fresh runner over
	 * the same in-memory services, restore flags, rebind, re-apply tools, reinstall
	 * the bridge, then emit `session_start`. No extension cache is cleared because
	 * the loader imports each extension fresh from disk.
	 */
	async reload(): Promise<ReloadOutcome> {
		if (this.disposed) return "disposed";
		// Reentrancy guard: a reload triggered (e.g. via ctx.reload()) while one is
		// in flight must not run concurrently and double-tear-down the bridge. Re-arm
		// the latch so the in-flight reload's loop picks up the newer request, and
		// report `coalesced` so a caller (e.g. the /reload command) doesn't claim a
		// completed reload it didn't perform.
		if (this.reloading) {
			this.reloadRequested = true;
			return "coalesced";
		}
		this.reloading = true;
		try {
			// Loop so a reload requested mid-reload — via the reentrancy guard above,
			// or a write_extension during this reload — is applied before reload()
			// resolves, instead of waiting for the next idle boundary. The latch is
			// cleared at the top of each pass and re-checked at the bottom.
			do {
				this.reloadRequested = false;
				// Don't swap the runner/bridge mid-turn: wait for the agent loop to be
				// idle first. All callers reach here at or after an idle point (the
				// /reload command runs between prompts; the self-extend drain is
				// scheduled off-stack at agent_end), so this resolves promptly and
				// cannot deadlock on an awaited-in-loop reload.
				await this.harness.waitForIdle();
				if (this.disposed) return "disposed";
				const flags = this.runner?.getFlagValues() ?? new Map<string, boolean | string>();
				await this.runner?.emit({ type: "session_shutdown", reason: "reload" });
				if (await this.disposeIfShutdownRequested()) return "disposed";
				this.teardownBridge?.();
				this.teardownBridge = undefined;
				try {
					await this.buildRunner();
					if (await this.disposeIfShutdownRequested()) return "disposed";
					for (const [name, value] of flags) this.runner?.setFlagValue(name, value);

					await this.reapplyTools();
					if (await this.disposeIfShutdownRequested()) return "disposed";
					this.installBridge();
					await this.runner?.emit({ type: "session_start", reason: "reload" });
				} catch (error) {
					// A failed rebuild left the bridge torn down; reinstall it over the
					// current runner so extension events keep flowing rather than going
					// silently dark for the rest of the session.
					if (this.runner && !this.teardownBridge) this.installBridge();
					throw error;
				}
			} while (this.reloadRequested && !this.disposed);
		} finally {
			this.reloading = false;
		}
		// Honor a shutdown requested during the final emit, after `reloading` cleared.
		// Still inside reload() (pendingReload may point at us), so tear down via
		// disposeNow rather than dispose to avoid awaiting our own reload.
		if (this.shutdownRequested) {
			await this.disposeNow();
			return "disposed";
		}
		return "reloaded";
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
		// A write_extension reload scheduled off-stack at agent_end may still be in
		// flight (print/interactive/action cleanup runs in `finally`). Setting
		// `disposed` stops new reloads and makes the in-flight one bail at its next
		// await boundary; await it so teardown — and the caller closing the browser —
		// doesn't race a live reload. Shutdowns raised from inside reload() use
		// `disposeNow` directly, since awaiting the running reload from within its own
		// call stack would deadlock.
		const inFlight = this.pendingReload;
		if (inFlight) await inFlight.catch(() => {});
		await this.disposeNow();
	}

	/**
	 * The actual teardown, split from `dispose` so reload()'s own shutdown paths
	 * can run it without awaiting the in-flight reload (which is their call stack).
	 * Idempotent via `teardownDone` — `disposed` is set before `dispose` awaits, so
	 * it can't double as the teardown guard.
	 */
	private async disposeNow(): Promise<void> {
		if (this.teardownDone) return;
		this.teardownDone = true;
		this.shutdownRequested = true;
		this.disposed = true;
		this.teardownBridge?.();
		this.teardownBridge = undefined;
		// Drop the host + extension tools this host merged into the harness before
		// the runner goes away: otherwise the model could still call a tool whose
		// runner binding is gone. (Moot at process exit, but `ctx.shutdown()` from
		// an extension disposes the host while the CLI keeps running.)
		await this.removeMergedTools();
		await this.runner?.emit({ type: "session_shutdown", reason: "quit" });
		this.runner = undefined;
	}

	/** Restore the harness to its base tools, removing this host's host+extension tools. */
	private async removeMergedTools(): Promise<void> {
		const merged = new Set([...this.hostTools, ...this.extensionTools].map((tool) => tool.name));
		if (merged.size === 0) return;
		const base = this.harness.getTools().filter((tool) => !merged.has(tool.name));
		const active = this.harness
			.getActiveTools()
			.map((tool) => tool.name)
			.filter((name) => !merged.has(name));
		// Best-effort: a failure here must not block the rest of teardown.
		await this.harness.setTools(base, active).catch(() => {});
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
			// Host tools own their names and must survive both reload and `setModel`'s
			// tool rebuild, so they are prepended. Names already on the harness that
			// are neither host tools nor a prior generation's extension tools are the
			// CLI's built-ins. An extension may not collide with a host tool or shadow
			// a built-in (the shadow would vanish the built-in when the extension is
			// later removed) — either would mis-bind the tool union. Colliding tools
			// are dropped and logged instead. (Two extensions registering the same
			// name can't reach here: the loader/runner keeps one registration.)
			const hostNames = new Set(this.hostTools.map((tool) => tool.name));
			const baseToolNames = new Set(
				this.harness
					.getTools()
					.filter((tool) => !hostNames.has(tool.name) && !priorExtensionNames.has(tool.name))
					.map((tool) => tool.name),
			);
			const nextExtensionTools = wrapRegisteredTools(
				this.runner.getAllRegisteredTools(),
				this.runner,
			).filter((tool) => {
				const collidesWith = hostNames.has(tool.name)
					? "a host-provided tool"
					: baseToolNames.has(tool.name)
						? "a built-in tool"
						: undefined;
				if (!collidesWith) return true;
				const error = `extension tool "${tool.name}" collides with ${collidesWith} and was dropped`;
				// Reapply can run several times per runner generation (e.g. on each
				// model switch) without a rebuild resetting loadErrors, so don't
				// re-push the same collision.
				if (!this.loadErrors.some((e) => e.path === tool.name && e.error === error)) {
					this.loadErrors.push({ path: tool.name, error });
				}
				return false;
			});
			const extensionNames = new Set(nextExtensionTools.map((tool) => tool.name));
			const base = this.harness
				.getTools()
				.filter(
					(tool) =>
						!extensionNames.has(tool.name) &&
						!priorExtensionNames.has(tool.name) &&
						!hostNames.has(tool.name),
				);
			const final = [...this.hostTools, ...base, ...nextExtensionTools];
			const finalNames = new Set(final.map((tool) => tool.name));
			const activeNames = new Set(
				this.harness
					.getActiveTools()
					.map((tool) => tool.name)
					.filter((name) => finalNames.has(name)),
			);
			for (const name of hostNames) activeNames.add(name);
			for (const name of extensionNames) {
				if (!this.inactiveExtensionTools.has(name)) activeNames.add(name);
			}
			this.applyingTools = true;
			try {
				await this.harness.setTools(final, [...activeNames]);
				// Record the applied set only after setTools succeeds: on a throw the
				// harness keeps the previous generation, so `extensionTools` (which
				// drives the next reapply's prior-name filtering) must still match it.
				this.extensionTools = nextExtensionTools;
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
		this.teardownBridge = installBridge(
			this.harness,
			this.runner,
			this.bridgeState,
			() => this.reapplyTools(),
			() => this.drainPendingReloadFromBridge(),
		);
	}

	/**
	 * Bridge-scheduled drain. The bridge fires this off-stack and discards the
	 * result, so a `reload()` failure (e.g. an unforeseen `setTools`/`buildRunner`
	 * throw — authored parse errors and tool collisions are collected, not thrown)
	 * must be caught here rather than left to surface as an unhandled rejection. It
	 * is recorded in `loadErrors` so the next `write_extension` result reports it.
	 */
	private drainPendingReloadFromBridge(): void {
		void this.drainPendingReload().catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			this.loadErrors.push({ path: "<reload>", error: message });
		});
	}

	/**
	 * Perform a reload queued by `write_extension`, if one is pending and it is
	 * safe to do so. The bridge schedules this off-stack at `agent_end` (the only
	 * idle boundary), never synchronously inside a tool's execute() or an event
	 * handler — reloading there would swap the runner out from under the in-flight
	 * loop and the listener dispatching the event. The `reloading` guard keeps an
	 * in-flight reload from being re-entered; a write during a reload re-arms the
	 * latch, which reload()'s own loop drains before it resolves. `disposed` makes
	 * this a no-op during teardown.
	 */
	async drainPendingReload(): Promise<void> {
		// Await a reload already running (the bridge fires this fire-and-forget, so
		// a caller that awaits the drain — e.g. a test asserting the new tool is
		// live — must observe that reload settle). reload() drains any request
		// latched mid-reload via its own loop, so a single pass suffices here.
		if (this.pendingReload) {
			await this.pendingReload;
			return;
		}
		if (!this.reloadRequested || this.reloading || this.disposed) return;
		this.reloadRequested = false;
		this.pendingReload = this.reload();
		try {
			await this.pendingReload;
		} catch (error) {
			// Re-arm the latch so the next idle boundary retries: a transient reload
			// failure (e.g. setTools throwing) must not strand a valid on-disk
			// extension until a manual /reload. The bridge's caller logs the error.
			if (!this.disposed) this.reloadRequested = true;
			throw error;
		} finally {
			this.pendingReload = undefined;
		}
	}

	/**
	 * Build the `write_extension` tool. It writes the authored module into the
	 * project extension dir, trial-loads it in isolation to validate it parses and
	 * registers (without touching the live runner), and queues a reload at the next
	 * idle boundary so the new tool joins the toolset for subsequent prompts. It
	 * never reloads synchronously — see `drainPendingReload`.
	 */
	private makeWriteExtensionTool(): AgentTool {
		const extensionDir = this.configuredPaths[0];
		return {
			name: WRITE_EXTENSION_TOOL_NAME,
			label: "Write extension",
			description: WRITE_EXTENSION_DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					filename: {
						type: "string",
						description:
							"basename for the extension file, e.g. my_tool.ts; must end in .ts and contain no path separators",
					},
					code: {
						type: "string",
						description: "full TypeScript extension module source",
					},
				},
				required: ["filename", "code"],
				additionalProperties: false,
			},
			// Sequential so two concurrent authorings can't race the same dir/latch.
			executionMode: "sequential",
			execute: async (_toolCallId, params): Promise<AgentToolResult<WriteExtensionDetails>> => {
				const { filename, code } = params as { filename: string; code: string };
				if (!extensionDir) throw new Error("no extension directory configured for write_extension");
				const target = this.resolveExtensionFilePath(extensionDir, filename);
				await mkdir(extensionDir, { recursive: true });
				await writeFile(target, code, "utf8");

				const trial = await this.trialLoadExtension(target);
				this.reloadRequested = true;

				const valid = trial.errors.length === 0 && trial.registeredTools.length > 0;
				const summary = valid
					? `wrote ${target}; registered tool(s): ${trial.registeredTools.join(", ")}. it will be available on your next prompt.`
					: `wrote ${target} but it did not load: ${
							trial.errors.map((e) => e.error).join("; ") ||
							"no tool was registered (the file must call pi.registerTool)"
						}. fix it and call write_extension again.`;
				return {
					content: [{ type: "text", text: summary }],
					details: {
						written: target,
						valid,
						registeredTools: trial.registeredTools,
						loadErrors: trial.errors,
						hostLoadErrors: this.loadErrors,
					},
				};
			},
		};
	}

	/**
	 * Constrain the authored filename to a fresh `.ts` basename inside the
	 * extension dir: no separators, no absolute path, no traversal. Resolving the
	 * dirname back to the extension dir is the final guard against escapes.
	 */
	private resolveExtensionFilePath(extensionDir: string, filename: string): string {
		if (!filename || filename.includes("/") || filename.includes("\\") || isAbsolute(filename)) {
			throw new Error("filename must be a bare basename with no path separators");
		}
		if (!filename.endsWith(".ts")) throw new Error("filename must end in .ts");
		if (normalize(filename) !== filename || filename === "." || filename === "..") {
			throw new Error("filename must be a plain basename");
		}
		const target = join(extensionDir, filename);
		const expectedDir = resolve(extensionDir);
		if (resolve(dirname(target)) !== expectedDir) {
			throw new Error("filename must resolve inside the extension directory");
		}
		return target;
	}

	/**
	 * Load just the authored file into a throwaway runner to collect
	 * parse/registration errors and the tool names it exposes, without binding it
	 * to the harness or mutating the live runner. Discovery runs with empty
	 * throwaway cwd/agentDir so its implicit `<cwd>/.pi/extensions` and
	 * `<agentDir>/extensions` scans pick up nothing — only the authored file
	 * (passed by absolute path) is loaded, so an unrelated extension elsewhere
	 * can't bias the result or hang the loader on its own bad import.
	 */
	private async trialLoadExtension(
		filePath: string,
	): Promise<{ errors: Array<{ path: string; error: string }>; registeredTools: string[] }> {
		const isolatedRoot = await mkdtemp(join(tmpdir(), "cua-ext-trial-"));
		const result = await discoverAndLoadExtensions([filePath], isolatedRoot, isolatedRoot);
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			isolatedRoot,
			this.sessionManager,
			this.modelRegistry,
		);
		const registeredTools = runner
			.getAllRegisteredTools()
			.map((tool) => tool.definition.name);
		return { errors: result.errors, registeredTools };
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
		// disposeNow, not dispose: this runs inside reload(), whose promise is the
		// `pendingReload` dispose() would await — awaiting it here would deadlock.
		await this.disposeNow();
		return true;
	}

	/**
	 * Forward an extension-initiated user message through `harness.prompt`,
	 * attaching the first-turn screenshot when this is the session's first turn —
	 * matching the CLI's own prompt call sites.
	 */
	private async promptUserMessage(text: string): Promise<void> {
		// The seam voids this call, so a rejection (e.g. prompting while the harness
		// is already driving a turn) would otherwise be an unhandled rejection.
		// Record it where the agent can see it instead of crashing the process.
		try {
			const images = await this.maybeInitialScreenshot();
			await this.harness.prompt(text, images ? { images } : undefined);
		} catch (error) {
			this.loadErrors.push({
				path: "<sendUserMessage>",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async maybeInitialScreenshot(): Promise<ImageContent[] | undefined> {
		if (!this.initialScreenshot) return undefined;
		// During startup the user's first prompt owns the first-turn screenshot; an
		// extension message here must not consume it (see `startedUp`).
		if (!this.startedUp) return undefined;
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
