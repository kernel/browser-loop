import type { AgentHarness, Session } from "@onkernel/cua-agent";
import {
	createSyntheticSourceInfo,
	type ExtensionActions,
	type ExtensionCommandContextActions,
	type ExtensionContextActions,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

/**
 * Read/write bridge between the runner's `ExtensionActions` (pi.* API surface)
 * and the harness + the `Session` the harness was constructed with.
 *
 * Session entry writes are async on the harness `Session` but the action
 * handlers are synchronous, so the appends are fired without awaiting. The
 * runner only needs the call to be enqueued, matching how pi forwards these to
 * its own session.
 */
export interface SeamHooks {
	/** Re-apply the authoritative base+extension tool union to the harness. */
	refreshTools: () => void;
	/** Synchronous mirror of the session name (kept because the action getter is sync). */
	getSessionName: () => string | undefined;
	/** Record the latest session name set through the action surface. */
	setSessionName: (name: string | undefined) => void;
}

export function makeExtensionActions(
	harness: AgentHarness,
	session: Session,
	hooks: SeamHooks,
): ExtensionActions {
	return {
		sendMessage(message): void {
			void session.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display ?? true,
				message.details,
			);
		},
		sendUserMessage(content): void {
			const text = typeof content === "string" ? content : textPartsOf(content);
			void harness.prompt(text);
		},
		appendEntry(customType, data): void {
			void session.appendCustomEntry(customType, data);
		},
		setSessionName(name): void {
			hooks.setSessionName(name);
			void session.appendSessionName(name);
		},
		getSessionName(): string | undefined {
			return hooks.getSessionName();
		},
		// Labels are a TUI-only affordance (entry bookmarking); no headless sink.
		setLabel(): void {},
		getActiveTools(): string[] {
			return harness.getActiveTools().map((tool) => tool.name);
		},
		getAllTools(): ToolInfo[] {
			return harness.getTools().map(
				(tool): ToolInfo => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					promptGuidelines: undefined,
					sourceInfo: createSyntheticSourceInfo(tool.name, { source: "harness" }),
				}),
			);
		},
		setActiveTools(names): void {
			void harness.setActiveTools(names);
		},
		refreshTools(): void {
			hooks.refreshTools();
		},
		// Slash commands are Tier B; none are surfaced from this host.
		getCommands(): never[] {
			return [];
		},
		async setModel(model): Promise<boolean> {
			await harness.setModel(model);
			return true;
		},
		getThinkingLevel() {
			return harness.getThinkingLevel();
		},
		setThinkingLevel(level): void {
			void harness.setThinkingLevel(level);
		},
	};
}

export function makeExtensionContextActions(
	harness: AgentHarness,
	state: { isIdle: () => boolean; getSignal: () => AbortSignal | undefined; shutdown: () => void },
): ExtensionContextActions {
	return {
		getModel() {
			return harness.getModel();
		},
		isIdle() {
			return state.isIdle();
		},
		// Headless host trusts its cwd; project-trust prompts are a TUI concern.
		isProjectTrusted(): boolean {
			return true;
		},
		getSignal() {
			return state.getSignal();
		},
		abort(): void {
			void harness.abort();
		},
		hasPendingMessages(): boolean {
			return false;
		},
		shutdown(): void {
			state.shutdown();
		},
		getContextUsage() {
			return undefined;
		},
		compact(options): void {
			void harness.compact(options?.customInstructions);
		},
		getSystemPrompt(): string {
			return "";
		},
	};
}

export function makeExtensionCommandContextActions(
	harness: AgentHarness,
	reload: () => Promise<void>,
): ExtensionCommandContextActions {
	return {
		waitForIdle() {
			return harness.waitForIdle();
		},
		async navigateTree(targetId, options) {
			const result = await harness.navigateTree(targetId, options);
			return { cancelled: result.cancelled };
		},
		reload,
		newSession(): never {
			throw new Error("newSession is unsupported on this harness host");
		},
		fork(): never {
			throw new Error("fork is unsupported on this harness host");
		},
		switchSession(): never {
			throw new Error("switchSession is unsupported on this harness host");
		},
	};
}

function textPartsOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text ?? "")
		.join("");
}
