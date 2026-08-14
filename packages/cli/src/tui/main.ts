import {
	type AgentHarnessEvent,
	type AgentMessage,
	estimateContextTokens,
	type Session,
	type Skill,
	type ThinkingLevel,
} from "@onkernel/cua-agent";
import {
	type Component,
	Container,
	Editor,
	hyperlink,
	matchesKey,
	ProcessTerminal,
	Spacer,
	Text,
	TUI,
} from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { type CuaModelRef, listCuaModels, type Model } from "@onkernel/cua-ai";
import { type CuaCliCatalog, type CuaCliHarness, type CuaCliTool } from "../harness";
import type { CuaBrowserHandle } from "../harness-browser";
import { resolveCuaModelRef } from "../harness-models";
import { updateNamedSessionRuntime } from "../harness-named-sessions";
import type { ContextFile } from "../harness-skills";
import { openTuiDebugLog } from "./debug-log";
import { applyAndSummarizeImageProtocol } from "./diagnostics";
import { installCuaKeybindings } from "./keybindings";
import { type AssistantBuffer, MessageList } from "./message-list";
import { createMutationQueue } from "./mutation-queue";
import { fitMaxVisible, ModelPickerComponent } from "./model-picker";
import { ScreenshotWidget } from "./screenshot-widget";
import { buildAutocompleteProvider, parseSlashCommand } from "./slash-commands";
import { StatusLine } from "./status-line";
import { TelemetryFooter } from "./telemetry-footer";
import { colors, getEditorTheme } from "./themes";
import { describeMenu, selectedKeys, toolKey, toolsForSelection, type ToolSelectionItem } from "./tool-selection";
import { ToolsPickerComponent } from "./tools-picker";
import { cuaVersion } from "./version";

export interface InteractiveOptions {
	cwd: string;
	harness: CuaCliHarness;
	/** The live (model, tools) selection `/model` and `/tools` change. */
	catalog: CuaCliCatalog;
	browserHandle: CuaBrowserHandle;
	session: Session;
	skills?: Skill[];
	/** Loaded context files (AGENTS.md, …) shown in the `[Context]` section. */
	contextFiles?: ContextFile[];
	/** CUA model ref currently active. Used for the status line and `/model` default. */
	modelRef: string;
	provider: string;
	/** Coding tools explicitly owned by the CLI and retained across /model switches. */
	applicationTools: readonly CuaCliTool[];
	/** Optional CLI application policy for replacing interaction tools on /model. */
	interactionToolsForModel?: (model: CuaModelRef) => readonly CuaCliTool[];
	initialPrompt?: string;
	/** Image protocol override: kitty | iterm2 | none | auto (default: auto). */
	imageProtocol?: string;
	/** True when seeding the agent from a previously persisted session. */
	resumed?: boolean;
	/** Display path of the on-disk transcript, when one exists. */
	transcriptPath?: string;
	/** Named session (-s) backing this TUI; /model switches persist to it. */
	namedSession?: string;
	/** Enable extra TUI render diagnostics for manual repros. */
	debugTui?: boolean;
}

/**
 * Run the interactive cua TUI: pi-tui differential renderer with header,
 * message list, sticky screenshot widget, editor (autocomplete-backed slash
 * commands), status line, and telemetry footer. Drives a {@link CuaCliHarness}
 * directly via `harness.subscribe()`.
 */
export async function runInteractive(opts: InteractiveOptions): Promise<number> {
	// pi's `theme` singleton throws until initialized; do this before any
	// component or theme helper runs.
	initTheme();
	// Apply image protocol override BEFORE constructing TUI components so
	// the Image component sees the resolved capabilities on its first render.
	const { summary: capsSummary, overridden } = applyAndSummarizeImageProtocol(opts.imageProtocol);
	const debug = opts.debugTui ? openTuiDebugLog() : undefined;
	const initialModel = opts.harness.getModel();
	const initialThinking = opts.harness.getThinkingLevel();
	const initialContextWindow = initialModel.contextWindow ?? undefined;
	debug?.log("interactive_init", {
		model: opts.modelRef,
		browserSession: opts.browserHandle.browser.session_id,
		liveUrl: opts.browserHandle.browser.browser_live_view_url,
		capsSummary,
		imageProtocol: opts.imageProtocol ?? "auto",
		overridden,
	});

	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);
	const requestRender = (reason: string, force = false, data: Record<string, unknown> = {}): void => {
		debug?.log("request_render", {
			reason,
			force,
			columns: terminal.columns,
			rows: terminal.rows,
			fullRedraws: tui.fullRedraws,
			...data,
		});
		tui.requestRender(force);
	};

	// Publishes cua's `cua.tools.*` ids alongside pi's base bindings. Must run
	// before any component calls getKeybindings().
	installCuaKeybindings();

	const editor = new Editor(tui, getEditorTheme());
	editor.setAutocompleteProvider(buildAutocompleteProvider(opts.cwd, opts.skills ?? []));
	const messages = new MessageList();
	const screenshot = new ScreenshotWidget();
	const liveUrl = opts.browserHandle.browser.browser_live_view_url;
	const status = new StatusLine({
		model: modelLabel(initialModel),
		browserSession: opts.browserHandle.browser.session_id,
		liveUrl,
	});
	const footer = new TelemetryFooter({
		provider: opts.provider,
		model: modelLabel(initialModel),
		thinkingLevel: initialThinking,
		contextWindow: initialContextWindow,
		contextTokens: 0,
	});

	const header = new Container();
	const logo = colors.bold(colors.accent("cua")) + colors.dim(` v${cuaVersion()}`);
	header.addChild(new Text(logo, 0, 0));
	header.addChild(new Text(keyHintRow(), 0, 0));
	const capsHint = overridden
		? colors.dim(capsSummary)
		: colors.dim(capsSummary + " · set CUA_IMAGE_PROTOCOL=kitty|iterm2 to force inline images");
	header.addChild(new Text(capsHint, 0, 0));
	if (liveUrl) {
		header.addChild(new Text(colors.dim("live ") + hyperlink(liveUrl, liveUrl), 0, 0));
	}
	header.addChild(new Text("", 0, 0));

	const contextSection = buildContextSection(opts.contextFiles ?? []);
	const skillSection = buildSkillSection(opts.skills ?? []);
	tui.addChild(header);
	if (contextSection) {
		tui.addChild(contextSection);
		tui.addChild(new Spacer(1));
	}
	if (skillSection) {
		tui.addChild(skillSection);
		tui.addChild(new Spacer(1));
	}
	tui.addChild(messages);
	tui.addChild(new Spacer(1));
	tui.addChild(screenshot);
	tui.addChild(new Spacer(1));
	// Pickers swap into the editor's slot (pi's `showSelector` pattern) so the
	// status line and telemetry footer stay visible beneath them.
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	tui.addChild(editorContainer);
	tui.addChild(status);
	tui.addChild(footer);
	tui.setFocus(editor);
	tui.onDebug = () => {
		debug?.log("pi_tui_debug_key", {
			columns: terminal.columns,
			rows: terminal.rows,
			fullRedraws: tui.fullRedraws,
		});
	};

	if (opts.resumed) {
		const transcript = opts.transcriptPath ? ` ${opts.transcriptPath}` : "";
		messages.addNotice(`resumed${transcript} · fresh browser`);
	}

	let assistantBuffer: AssistantBuffer | undefined;
	let inflight = 0;
	let promptRunning = 0;
	let turnRevision = 0;
	let interruptState: { queued: string[]; cancelled: boolean } | undefined;
	let lastDisplayedError: string | undefined;

	const isTurnRunning = (): boolean => inflight > 0 || promptRunning > 0;

	// Ref of the live model, kept in sync by switchModel so the picker can mark
	// it with a ✓. Undefined when opts.modelRef is not a catalog ref.
	let currentModelRef: CuaModelRef | undefined = tryResolveModelRef(opts.modelRef);
	// The list the application composed for the active model: the picker's
	// "defaults", restored by ctrl+r. A selection is no longer confined to it —
	// the picker offers the model's whole menu — but every staged change is
	// still compiled by `harness.setTools()` before it can land.
	let baselineTools: readonly CuaCliTool[] = composeBaselineTools(opts, currentModelRef);
	let toolSelectionCustomized = false;
	// Serializes every catalog mutation (`/tools` applies and `/model` switches);
	// see mutation-queue.ts for why they must not interleave.
	const catalogQueue = createMutationQueue();
	// Non-null while a picker owns the editor slot and all keyboard input.
	let activeSelector: Component | null = null;

	/**
	 * Swap a picker into the editor's slot and restore the editor when it is
	 * done. Mirrors pi's `showSelector` in interactive-mode.
	 */
	const showSelector = (
		create: (done: () => void) => { component: Component; focus: Component },
	): void => {
		if (activeSelector) return;
		const done = (): void => {
			activeSelector = null;
			editorContainer.clear();
			editorContainer.addChild(editor);
			tui.setFocus(editor);
			requestRender("selector_closed");
		};
		const { component, focus } = create(done);
		activeSelector = component;
		editorContainer.clear();
		editorContainer.addChild(component);
		tui.setFocus(focus);
		requestRender("selector_opened");
	};

	/**
	 * Refuse to open a picker mid-turn. Recompiling the catalog while a request
	 * is streaming is unsafe, and nothing downstream stops it: the agent's
	 * execution-scope guard only rejects mutation from inside a tool's execute,
	 * and a TUI-initiated mutation carries no such scope. This check is the only
	 * protection, so it refuses up front rather than failing on apply.
	 */
	const refuseWhileBusy = (command: string): boolean => {
		if (!isTurnRunning() && !interruptState) return false;
		messages.addError(`${command} is unavailable while a turn is running`);
		requestRender("selector_busy", false, { command });
		return true;
	};

	const displayAgentError = (error: unknown, reason: string): void => {
		if (typeof error !== "string" || error.trim().length === 0) return;
		if (error === lastDisplayedError) return;
		lastDisplayedError = error;
		messages.addError(error);
		status.update({ working: undefined });
		debug?.log("agent_error", { reason, message: error });
		requestRender("agent_error", false, { reason });
	};

	const unsubscribe = opts.harness.subscribe((event: AgentHarnessEvent) => {
		switch (event.type) {
			case "agent_start": {
				inflight += 1;
				status.update({ working: "thinking…" });
				debug?.log("agent_start", { inflight });
				requestRender("agent_start", false, { inflight });
				return;
			}
			case "agent_end": {
				inflight -= 1;
				if (inflight <= 0) status.update({ working: undefined });
				const finalError = lastErrorMessage(event.messages);
				displayAgentError(finalError, "agent_end");
				debug?.log("agent_end", { inflight });
				requestRender("agent_end", false, { inflight });
				return;
			}
			case "message_start": {
				if (event.message.role === "assistant") {
					assistantBuffer = messages.addAssistantStart();
					debug?.log("assistant_message_start");
					requestRender("assistant_message_start");
				}
				return;
			}
			case "message_update": {
				if (event.assistantMessageEvent.type === "text_delta") {
					assistantBuffer?.append(event.assistantMessageEvent.delta);
					requestRender("assistant_text_delta", false, {
						deltaLength: event.assistantMessageEvent.delta.length,
					});
				}
				return;
			}
			case "message_end": {
				if (event.message.role === "assistant") {
					if (event.message.usage) {
						footer.update({ contextTokens: event.message.usage.input });
					}
					assistantBuffer?.end();
					assistantBuffer = undefined;
					displayAgentError(event.message.errorMessage, "assistant_message_end");
					debug?.log("assistant_message_end");
					requestRender("assistant_message_end");
				}
				return;
			}
			case "tool_execution_start": {
				messages.addToolCall(event.toolName, event.args);
				status.update({ working: event.toolName });
				debug?.log("tool_execution_start", { toolName: event.toolName });
				requestRender("tool_execution_start", false, { toolName: event.toolName });
				return;
			}
			case "tool_execution_end": {
				const result = event.result as
					| {
							content?: Array<{ type?: string; data?: string; mimeType?: string }>;
							details?: { error?: string };
					  }
					| undefined;
				const isError = !!event.isError;
				let summary = isError ? colors.error("error") : colors.success("ok");
				if (!isError && result?.content) {
					const imgs = result.content.filter((c) => c?.type === "image");
					if (imgs.length > 0) summary += colors.dim(` · ${imgs.length} screenshot${imgs.length > 1 ? "s" : ""}`);
					const lastImg = imgs[imgs.length - 1];
					if (lastImg?.data) screenshot.update(lastImg.data, lastImg.mimeType ?? "image/png");
				}
				if (isError && result?.details?.error) summary = colors.error(result.details.error);
				messages.addToolResult(event.toolName, !isError, summary);
				debug?.log("tool_execution_end", {
					toolName: event.toolName,
					isError,
					hasImage: !!result?.content?.some((c) => c?.type === "image"),
				});
				requestRender("tool_execution_end", false, {
					toolName: event.toolName,
					isError,
				});
				return;
			}
			case "model_update": {
				footer.update({
					provider: event.model.provider,
					model: modelLabel(event.model),
					contextWindow: event.model.contextWindow,
				});
				status.update({ model: modelLabel(event.model) });
				requestRender("model_update");
				return;
			}
			case "thinking_level_update": {
				footer.update({ thinkingLevel: event.level });
				requestRender("thinking_level_update");
				return;
			}
			case "session_compact": {
				messages.addNotice(`compacted ${event.compactionEntry.tokensBefore} tokens`);
				void refreshContextTokens(opts.session).then((tokens) => {
					footer.update({ contextTokens: tokens });
					requestRender("session_compact");
				});
				return;
			}
			default:
				return;
		}
	});

	const pendingPrompt = opts.initialPrompt?.trim() || "";
	let exitRequested = false;

	/**
	 * Apply a model switch. The picker and `/model <ref>` share this one path.
	 * A failed switch needs no rollback here: the harness compiles before it
	 * mutates and restores its own state if the mutation fails.
	 */
	const applySwitchModel = async (resolved: CuaModelRef): Promise<void> => {
		// The exact list installed by this switch, kept so it can become the new
		// `/tools` baseline. Undefined when the caller supplies no interaction
		// policy, in which case the switch never touches the tool list at all.
		let installedTools: readonly CuaCliTool[] | undefined;
		if (opts.interactionToolsForModel) {
			installedTools = [...opts.interactionToolsForModel(resolved), ...opts.applicationTools];
			// Native catalogs are incompatible across providers, and the selected
			// tools decide the transport, so the new model and its interaction
			// catalog have to compile as one pair rather than in sequence.
			await opts.catalog.setModelAndTools(resolved, installedTools);
		} else {
			await opts.catalog.setModel(resolved);
		}
		const model = opts.harness.getModel();
		footer.update({
			provider: model.provider,
			model: modelLabel(model),
			contextWindow: model.contextWindow,
		});
		status.update({ model: modelLabel(model) });
		messages.addNotice(`model → ${resolved}`);
		currentModelRef = resolved;
		// Only an interaction policy rebuilds the tool list; without one the switch
		// never touched setTools, so any customization legitimately survives and
		// announcing a reset would be a lie. Rebasing the baseline on the live list
		// there would also shrink it permanently.
		if (installedTools) {
			// Adopt the very list just installed as the new baseline, so baseline keys
			// and the live catalog can never disagree. Tool identities are
			// provider-specific, so carrying a previous selection over would silently
			// substitute tools; report the reset instead.
			baselineTools = installedTools;
			if (toolSelectionCustomized) {
				messages.addNotice("tool selection reset to the new model's defaults");
				toolSelectionCustomized = false;
			}
		}
		await persistNamedSessionRuntime(opts, messages, { model: resolved });
	};

	/**
	 * Serialized entry point for a model switch. Queued behind any in-flight
	 * `/tools` apply so the apply's `setTools` cannot land mid-switch and compile
	 * its tool subset against the other model. Rejects with the underlying
	 * failure; the harness has already rolled back by then.
	 */
	const switchModel = (resolved: CuaModelRef): Promise<void> => catalogQueue.run(() => applySwitchModel(resolved));

	const openModelPicker = (initialSearch?: string): void => {
		if (refuseWhileBusy("/model")) return;
		showSelector((done) => {
			const picker = new ModelPickerComponent({
				tui,
				currentRef: currentModelRef,
				items: listCuaModels(),
				initialSearch,
				// Frame overhead: borders, hint, search, detail lines, plus the
				// header/status/footer chrome the picker sits between.
				maxVisible: fitMaxVisible(terminal.rows, 22),
				onSelect: (ref) => {
					// Close first (pi does the same) so a failing switch surfaces in
					// the message list with the editor already restored.
					done();
					void switchModel(ref).catch((err: unknown) => {
						messages.addError((err as Error).message);
						requestRender("model_switch_error");
					});
				},
				onCancel: done,
			});
			return { component: picker, focus: picker };
		});
	};

	/**
	 * Apply a staged selection of the model's tool menu, in menu order.
	 * `harness.setTools` compiles and validates before mutating, so a rejected
	 * selection leaves the live catalog untouched.
	 */
	const applyToolSelection = (items: readonly ToolSelectionItem[], enabledKeys: ReadonlySet<string>): Promise<void> =>
		catalogQueue.run(async () => {
			const next = toolsForSelection(items, enabledKeys);
			try {
				await opts.catalog.setTools(next);
				toolSelectionCustomized = !sameToolList(next, baselineTools);
				messages.addNotice(`tools → ${next.length} enabled`);
				debug?.log("tools_applied", { enabled: next.length, baseline: baselineTools.length });
			} catch (err) {
				messages.addError(`tool selection rejected (tools unchanged): ${(err as Error).message}`);
				debug?.log("tools_apply_error", { message: (err as Error).message });
			}
			requestRender("tools_apply");
		});

	const openToolsPicker = (): void => {
		if (refuseWhileBusy("/tools")) return;
		const modelRef = currentModelRef;
		if (!modelRef) {
			messages.addError("the tool menu needs a catalog model ref; this session was started with a model object");
			requestRender("tools_no_ref");
			return;
		}
		const live = opts.catalog.getTools();
		// Availability is pairwise, so the menu is rebuilt against each staged
		// selection rather than computed once when the picker opens.
		const menuFor = (selected: readonly CuaCliTool[]) => describeMenu(modelRef, opts.applicationTools, selected);
		const items = menuFor(live);
		if (items.length === 0) {
			messages.addError("no model-callable tools are available for this model");
			requestRender("tools_empty");
			return;
		}
		showSelector((done) => {
			const picker = new ToolsPickerComponent({
				tui,
				items,
				enabledKeys: selectedKeys(items, live),
				defaultKeys: selectedKeys(items, baselineTools),
				maxVisible: fitMaxVisible(terminal.rows, 25),
				restage: (staged: ReadonlySet<string>) => menuFor(toolsForSelection(items, staged)),
				onApply: (enabled) => {
					done();
					void applyToolSelection(items, enabled);
				},
				onCancel: done,
			});
			return { component: picker, focus: picker };
		});
	};

	const sameToolList = (a: readonly CuaCliTool[], b: readonly CuaCliTool[]): boolean =>
		a.length === b.length && a.every((tool, index) => toolKey(tool) === toolKey(b[index]!));

	const promptAgent = async (text: string): Promise<void> => {
		promptRunning += 1;
		try {
			await opts.harness.prompt(text);
		} finally {
			promptRunning -= 1;
		}
	};

	const runPrompt = async (text: string): Promise<void> => {
		debug?.log("run_prompt_start", { length: text.length });
		try {
			const parsed = parseSlashCommand(text);
			if (parsed && refuseWhileBusy(`/${parsed.command}`)) return;
			if (parsed?.command === "model") {
				const argument = parsed.argument.trim();
				if (!argument) {
					openModelPicker();
					return;
				}
				let resolved: CuaModelRef;
				try {
					resolved = resolveCuaModelRef(argument);
				} catch (err) {
					// Keep the diagnostic, then offer the picker prefilled with the
					// unresolved text (pi's behavior for an unmatched /model arg).
					messages.addError((err as Error).message);
					openModelPicker(argument);
					return;
				}
				if (refuseWhileBusy("/model")) return;
				await switchModel(resolved);
				return;
			}
			if (parsed?.command === "tools") {
				if (parsed.argument) {
					messages.addNotice("/tools takes no argument; opening the picker");
				}
				openToolsPicker();
				return;
			}
			if (parsed?.command === "thinking") {
				await applyThinkingCommand(opts, footer, messages, parsed.argument);
				return;
			}
			if (parsed?.command === "compact") {
				await applyCompactCommand(opts, messages);
				return;
			}
			if (parsed?.command === "skill") {
				const skill = (opts.skills ?? []).find((s) => s.name === parsed.name);
				if (!skill) {
					messages.addError(`unknown skill "${parsed.name}"`);
					requestRender("skill_unknown");
					return;
				}
				messages.addNotice(`invoking /skill:${skill.name}`);
				requestRender("skill_invocation");
				const skillRemainder = parsed.remainder || undefined;
				await opts.harness.skill(skill.name, skillRemainder);
				return;
			}
			if (interruptState) {
				interruptState.queued.push(text);
				messages.addNotice(interruptState.cancelled ? "queued for after abort" : "queued for the interrupted turn");
				requestRender("prompt_queued_during_interrupt");
				return;
			}
			if (isTurnRunning()) {
				const revision = turnRevision;
				await opts.harness.steer(text);
				if (revision !== turnRevision) return;
				messages.addNotice("queued for the next available turn");
				requestRender("prompt_queued_for_steer");
				return;
			}
			await promptAgent(text);
		} catch (err) {
			messages.addError((err as Error).message);
			debug?.log("run_prompt_error", { message: (err as Error).message });
			requestRender("run_prompt_error", false, { message: (err as Error).message });
			return;
		}
		debug?.log("run_prompt_end");
	};

	editor.onSubmit = (text: string) => {
		const trimmed = text.trim();
		if (!trimmed) return;
		editor.setText("");
		editor.addToHistory(trimmed);
		messages.addUser(trimmed);
		debug?.log("editor_submit", { length: trimmed.length });
		void runPrompt(trimmed);
	};

	const startQueuedPrompt = (queued: string[], notice: string): void => {
		messages.addNotice(`${notice}; sending ${queued.length} queued message${queued.length === 1 ? "" : "s"}`);
		requestRender("queued_prompt_start", false, { queued: queued.length });
		void promptAgent(queued.join("\n\n")).catch((err: unknown) => {
			messages.addError((err as Error).message);
			debug?.log("queued_prompt_error", { message: (err as Error).message });
			requestRender("queued_prompt_error");
		});
	};

	const interruptTurn = async (): Promise<void> => {
		if (interruptState) return;
		const state: { queued: string[]; cancelled: boolean } = { queued: [], cancelled: false };
		interruptState = state;
		turnRevision += 1;
		messages.addNotice("interrupting…");
		requestRender("input_interrupt_start", false, { key: "escape" });
		try {
			const { clearedSteer, clearedFollowUp } = await opts.harness.abort();
			if (state.cancelled) {
				const queued = state.queued;
				state.queued = [];
				if (queued.length > 0) {
					interruptState = undefined;
					startQueuedPrompt(queued, "abort complete");
				}
				return;
			}
			const queued = [
				...clearedSteer.map(userMessageText).filter((text): text is string => !!text),
				...clearedFollowUp.map(userMessageText).filter((text): text is string => !!text),
				...state.queued,
			];
			state.queued = [];
			if (queued.length === 0) {
				messages.addNotice("turn aborted");
				requestRender("input_abort_stream", false, { key: "escape" });
				return;
			}

			interruptState = undefined;
			startQueuedPrompt(queued, "turn interrupted");
		} catch (err) {
			state.queued = [];
			messages.addError((err as Error).message);
			debug?.log("input_interrupt_error", { message: (err as Error).message });
			requestRender("input_interrupt_error");
		} finally {
			if (interruptState === state) interruptState = undefined;
		}
	};

	const removeListener = tui.addInputListener((data) => {
		// Input listeners run before the focused component, so an open picker has
		// to own every key: otherwise ctrl+c / ctrl+d here would quit the app
		// instead of cancelling the picker.
		if (activeSelector) return undefined;
		if (matchesKey(data, "ctrl+c")) {
			if (interruptState) {
				interruptState.cancelled = true;
				interruptState.queued = [];
				messages.addNotice("aborted");
				debug?.log("input_cancel_interrupt_replay", { key: "ctrl+c" });
				requestRender("input_cancel_interrupt_replay", false, { key: "ctrl+c" });
				return { consume: true };
			}
			if (isTurnRunning()) {
				turnRevision += 1;
				void opts.harness.abort();
				messages.addNotice("aborted");
				debug?.log("input_abort_stream", { key: "ctrl+c" });
				requestRender("input_abort_stream", false, { key: "ctrl+c" });
				return { consume: true };
			}
			exitRequested = true;
			debug?.log("input_exit_request", { key: "ctrl+c" });
			requestRender("input_exit_request", false, { key: "ctrl+c" });
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+d")) {
			exitRequested = true;
			debug?.log("input_exit_request", { key: "ctrl+d" });
			return { consume: true };
		}
		if (matchesKey(data, "escape") && (isTurnRunning() || interruptState)) {
			void interruptTurn();
			debug?.log("input_interrupt_stream", { key: "escape" });
			return { consume: true };
		}
		return undefined;
	});

	tui.start();
	debug?.log("tui_started", {
		columns: terminal.columns,
		rows: terminal.rows,
		fullRedraws: tui.fullRedraws,
	});

	try {
		if (pendingPrompt) {
			messages.addUser(pendingPrompt);
			void runPrompt(pendingPrompt);
		}

		await waitForExit(
			() => exitRequested,
			() => isTurnRunning() || !!interruptState,
		);

		return 0;
	} finally {
		removeListener();
		unsubscribe();
		tui.stop();
		debug?.close({
			fullRedraws: tui.fullRedraws,
			columns: terminal.columns,
			rows: terminal.rows,
		});
	}
}

async function waitForExit(shouldExit: () => boolean, isBusy: () => boolean): Promise<void> {
	while (true) {
		if (shouldExit() && !isBusy()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
	}
}

function modelLabel(model: Model<any> | undefined): string {
	if (!model) return "";
	return model.id;
}

function userMessageText(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content.trim() || undefined;
	const text = message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("");
	return text.trim() || undefined;
}

function lastErrorMessage(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i];
		if (m && m.role === "assistant" && typeof m.errorMessage === "string") {
			return m.errorMessage;
		}
	}
	return undefined;
}

/** Resolve the startup ref for picker bookkeeping; undefined when not a catalog ref. */
function tryResolveModelRef(input: string | undefined): CuaModelRef | undefined {
	try {
		return resolveCuaModelRef(input);
	} catch {
		return undefined;
	}
}

/**
 * The startup baseline: exactly the list `cli-harness` assembled for the initial
 * model. Only used once — a later switch adopts the list it installed instead,
 * so the baseline is never rebased on `harness.getTools()`, which a `/tools`
 * customization would have shrunk.
 */
function composeBaselineTools(opts: InteractiveOptions, ref: CuaModelRef | undefined): readonly CuaCliTool[] {
	if (!opts.interactionToolsForModel || !ref) return opts.catalog.getTools();
	return [...opts.interactionToolsForModel(ref), ...opts.applicationTools];
}

// Persistence is best-effort: the live switch already happened, so a failed
// metadata write must not masquerade as a failed switch — warn that resume
// will restore the previous value instead.
async function persistNamedSessionRuntime(
	opts: InteractiveOptions,
	messages: MessageList,
	patch: { model?: string },
): Promise<void> {
	if (!opts.namedSession) return;
	try {
		await updateNamedSessionRuntime(opts.namedSession, patch);
	} catch (err) {
		messages.addError(
			`switched, but failed to persist to session "${opts.namedSession}" (resume will restore the previous value): ${(err as Error).message}`,
		);
	}
}

async function applyThinkingCommand(
	opts: InteractiveOptions,
	footer: TelemetryFooter,
	messages: MessageList,
	argument: string,
): Promise<void> {
	const value = argument.trim().toLowerCase();
	if (!isThinkingLevel(value)) {
		messages.addError("usage: /thinking <off|minimal|low|medium|high|xhigh>");
		return;
	}
	try {
		await opts.harness.setThinkingLevel(value);
		footer.update({ thinkingLevel: value });
		messages.addNotice(`thinking → ${value}`);
	} catch (err) {
		messages.addError((err as Error).message);
	}
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
}

async function applyCompactCommand(opts: InteractiveOptions, messages: MessageList): Promise<void> {
	messages.addNotice("compacting…");
	try {
		// The `session_compact` harness event posts the final
		// "compacted N tokens" notice; emitting it here too would duplicate.
		await opts.harness.compact();
	} catch (err) {
		messages.addError((err as Error).message);
	}
}

async function refreshContextTokens(session: Session): Promise<number> {
	const context = await session.buildContext();
	return estimateContextTokens(context.messages).tokens;
}

function keyHintRow(): string {
	const hint = (keys: string, label: string) => colors.bold(keys) + colors.dim(` ${label}`);
	return [
		hint("esc/ctrl+c", "to interrupt"),
		hint("ctrl+c/ctrl+d", "to exit"),
		hint("/", "for commands"),
	].join(colors.muted(" · "));
}

function sectionLabel(name: string): string {
	return colors.heading(`[${name}]`);
}

function buildContextSection(contextFiles: ContextFile[]): Container | undefined {
	if (contextFiles.length === 0) return undefined;
	const paths = contextFiles.map((file) => displayPath(file.path)).join(", ");
	const container = new Container();
	container.addChild(new Text(sectionLabel("Context") + "\n" + colors.dim(`  ${paths}`), 0, 0));
	return container;
}

function buildSkillSection(skills: Skill[]): Container | undefined {
	if (skills.length === 0) return undefined;
	const names = skills
		.map((s) => s.name)
		.sort((a, b) => a.localeCompare(b))
		.join(", ");
	const container = new Container();
	container.addChild(new Text(sectionLabel("Skills") + "\n" + colors.dim(`  ${names}`), 0, 0));
	return container;
}

function displayPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
