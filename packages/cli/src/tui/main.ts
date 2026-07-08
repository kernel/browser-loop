import {
	type AgentHarnessEvent,
	type AgentMessage,
	type CuaAgentHarness,
	estimateContextTokens,
	formatSkillInvocation,
	type Session,
	type Skill,
	type ThinkingLevel,
} from "@onkernel/cua-agent";
import {
	Container,
	Editor,
	hyperlink,
	KeybindingsManager,
	matchesKey,
	ProcessTerminal,
	Spacer,
	Text,
	TUI,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import type { ImageContent, Model } from "@onkernel/cua-ai";
import { captureScreenshot, type CuaBrowserHandle } from "../harness-browser";
import { resolveCuaModelRef } from "../harness-models";
import type { ContextFile } from "../harness-skills";
import { openTuiDebugLog } from "./debug-log";
import { applyAndSummarizeImageProtocol } from "./diagnostics";
import { type AssistantBuffer, MessageList } from "./message-list";
import { ScreenshotWidget } from "./screenshot-widget";
import { buildAutocompleteProvider, parseSlashCommand } from "./slash-commands";
import { StatusLine } from "./status-line";
import { TelemetryFooter } from "./telemetry-footer";
import { colors, getEditorTheme } from "./themes";
import { cuaVersion } from "./version";

export interface InteractiveOptions {
	cwd: string;
	harness: CuaAgentHarness;
	browserHandle: CuaBrowserHandle;
	session: Session;
	skills?: Skill[];
	/** Loaded context files (AGENTS.md, …) shown in the `[Context]` section. */
	contextFiles?: ContextFile[];
	/** CUA model ref currently active. Used for the status line and `/model` default. */
	modelRef: string;
	provider: string;
	initialPrompt?: string;
	/** Image protocol override: kitty | iterm2 | none | auto (default: auto). */
	imageProtocol?: string;
	/** Skip the first-prompt screenshot (resume case). */
	skipInitialScreenshot?: boolean;
	/** True when seeding the agent from a previously persisted session. */
	resumed?: boolean;
	/** Display path of the on-disk transcript, when one exists. */
	transcriptPath?: string;
	/** Enable extra TUI render diagnostics for manual repros. */
	debugTui?: boolean;
}

/**
 * Run the interactive cua TUI: pi-tui differential renderer with header,
 * message list, sticky screenshot widget, editor (autocomplete-backed slash
 * commands), status line, and telemetry footer. Drives a {@link CuaAgentHarness}
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

	const _keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
	void _keybindings;

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
	tui.addChild(editor);
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
	let firstPromptSent = false;
	let lastDisplayedError: string | undefined;

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

	const runPrompt = async (text: string): Promise<void> => {
		debug?.log("run_prompt_start", { length: text.length });
		try {
			const parsed = parseSlashCommand(text);
			if (parsed?.command === "model") {
				await applyModelCommand(opts, footer, status, messages, parsed.argument);
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
			if (parsed?.command === "playwright") {
				await applyPlaywrightCommand(opts, messages, parsed.argument);
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
				const skillImages = await maybeInitialScreenshot(opts, firstPromptSent);
				firstPromptSent = true;
				if (skillImages) {
					// `harness.skill` has no images option; fall back to `prompt`
					// with the formatted skill invocation so the first turn sees
					// the browser screenshot.
					await opts.harness.prompt(formatSkillInvocation(skill, skillRemainder), { images: skillImages });
				} else {
					await opts.harness.skill(skill.name, skillRemainder);
				}
				return;
			}
			const images = await maybeInitialScreenshot(opts, firstPromptSent);
			firstPromptSent = true;
			await opts.harness.prompt(text, images ? { images } : undefined);
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

	const removeListener = tui.addInputListener((data) => {
		if (matchesKey(data, "ctrl+c")) {
			if (inflight > 0) {
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
		if (matchesKey(data, "escape") && inflight > 0) {
			void opts.harness.abort();
			messages.addNotice("turn aborted");
			debug?.log("input_abort_stream", { key: "escape" });
			requestRender("input_abort_stream", false, { key: "escape" });
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
			() => inflight > 0,
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

function lastErrorMessage(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i];
		if (m && m.role === "assistant" && typeof m.errorMessage === "string") {
			return m.errorMessage;
		}
	}
	return undefined;
}

async function maybeInitialScreenshot(
	opts: InteractiveOptions,
	firstPromptSent: boolean,
): Promise<ImageContent[] | undefined> {
	if (firstPromptSent) return undefined;
	if (opts.skipInitialScreenshot) return undefined;
	if (await sessionHasPriorTurn(opts.session)) return undefined;
	const png = await captureScreenshot(opts.browserHandle.client, opts.browserHandle.browser.session_id);
	if (!png) return undefined;
	return [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }];
}

async function sessionHasPriorTurn(session: Session): Promise<boolean> {
	const entries = await session.getBranch();
	for (const entry of entries) {
		if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
			return true;
		}
	}
	return false;
}

async function applyModelCommand(
	opts: InteractiveOptions,
	footer: TelemetryFooter,
	status: StatusLine,
	messages: MessageList,
	argument: string,
): Promise<void> {
	const ref = argument.trim();
	if (!ref) {
		messages.addError("usage: /model <provider:model>");
		return;
	}
	try {
		const resolved = resolveCuaModelRef(ref);
		await opts.harness.setModel(resolved);
		const model = opts.harness.getModel();
		footer.update({
			provider: model.provider,
			model: modelLabel(model),
			contextWindow: model.contextWindow,
		});
		status.update({ model: modelLabel(model) });
		messages.addNotice(`model → ${resolved}`);
	} catch (err) {
		messages.addError((err as Error).message);
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

async function applyPlaywrightCommand(
	opts: InteractiveOptions,
	messages: MessageList,
	argument: string,
): Promise<void> {
	const value = argument.trim().toLowerCase();
	if (value !== "on" && value !== "off") {
		messages.addError("usage: /playwright <on|off>");
		return;
	}
	try {
		await opts.harness.setPlaywright(value === "on");
		messages.addNotice(`playwright → ${value}`);
	} catch (err) {
		messages.addError((err as Error).message);
	}
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
