import type { AgentHarnessEvent, CuaAgentHarness, Session, Skill } from "@onkernel/cua-agent";
import type { ImageContent } from "@onkernel/cua-ai";
import { stderr, stdout } from "node:process";
import { captureScreenshot } from "./harness-browser";
import type { CuaBrowserHandle } from "./harness-browser";
import { attachHarnessJsonlSink } from "./output/harness-jsonl";
import { parseSkillInvocation } from "./harness-skills";

export interface RunPrintOptions {
	harness: CuaAgentHarness;
	browserHandle: CuaBrowserHandle;
	session: Session;
	modelRef: string;
	provider: string;
	prompt: string;
	skills?: Skill[];
	/** When true, skip the auto-attached first-prompt screenshot (resume case). */
	skipInitialScreenshot?: boolean;
	verbose?: boolean;
	jsonlMode?: boolean;
	jsonlIncludeDeltas?: boolean;
	jsonlIncludeImages?: boolean;
}

/**
 * Run a single prompt through the harness and stream output to stdout
 * (text mode) or as jsonl events. Returns the process exit code (0 ok,
 * 1 on failure).
 */
export async function runPrint(opts: RunPrintOptions): Promise<number> {
	const jsonlMode = opts.jsonlMode === true;
	let unsubscribeJsonl: (() => void) | undefined;
	if (jsonlMode) {
		unsubscribeJsonl = attachHarnessJsonlSink({
			harness: opts.harness,
			browser: opts.browserHandle.browser,
			profileId: opts.browserHandle.profileId,
			modelRef: opts.modelRef,
			provider: opts.provider,
			includeDeltas: opts.jsonlIncludeDeltas,
			includeImages: opts.jsonlIncludeImages,
		});
	}

	const unsubscribeText = opts.harness.subscribe((event: AgentHarnessEvent) => {
		if (jsonlMode) return;
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			stdout.write(event.assistantMessageEvent.delta);
			return;
		}
		if (opts.verbose && event.type === "tool_execution_start") {
			stderr.write(`\n[cua] tool ${event.toolName} ${JSON.stringify(event.args)}\n`);
		}
		if (opts.verbose && event.type === "tool_execution_end") {
			stderr.write(`[cua] tool ${event.toolName} done\n`);
		}
	});

	let exitCode = 0;
	try {
		const invocation = parseSkillInvocation(opts.prompt, opts.skills ?? []);
		let assistant;
		if (invocation?.skill) {
			if (opts.verbose) stderr.write(`[cua] expanded /skill:${invocation.skill.name}\n`);
			assistant = await opts.harness.skill(invocation.skill.name, invocation.remainder || undefined);
		} else {
			const images = await maybeInitialScreenshot(opts);
			assistant = await opts.harness.prompt(opts.prompt, images ? { images } : undefined);
		}
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			throw new Error(assistant.errorMessage ?? `agent stopped with ${assistant.stopReason}`);
		}
		if (!jsonlMode) stdout.write("\n");
	} catch (err) {
		if (jsonlMode) {
			stdout.write(
				JSON.stringify({
					type: "error",
					code: "run_failed",
					message: (err as Error).message,
					ts: Date.now(),
				}) + "\n",
			);
		} else {
			stderr.write(`\n[cua] error: ${(err as Error).message}\n`);
		}
		exitCode = 1;
	} finally {
		unsubscribeText();
		unsubscribeJsonl?.();
	}
	return exitCode;
}

async function maybeInitialScreenshot(opts: RunPrintOptions): Promise<ImageContent[] | undefined> {
	if (opts.skipInitialScreenshot) return undefined;
	// Browser mode's only frame is the viewport; skip the OS-display capture
	// rather than mix coordinate frames on the first turn.
	if (opts.harness.getMode() === "browser") return undefined;
	const hasPriorTurn = await sessionHasPriorTurn(opts.session);
	if (hasPriorTurn) return undefined;
	const png = await captureScreenshot(opts.browserHandle.client, opts.browserHandle.browser.session_id);
	if (!png) return undefined;
	return [
		{
			type: "image",
			data: png.toString("base64"),
			mimeType: "image/png",
		},
	];
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
