import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentHarnessEvent } from "@onkernel/cua-agent";

/** Content block shape shared by assistant content and tool results. */
interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  data?: string;
  mimeType?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

const RUN_JSONL = "run.jsonl";
const SHOTS_DIR = "shots";

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/webp": "webp",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
};

function appendLine(outDir: string, record: Record<string, unknown>): void {
  appendFileSync(join(outDir, RUN_JSONL), `${JSON.stringify(record)}\n`);
}

/** First `instruction` line so the Python mapper has a leading user step. */
export function writeUserLine(outDir: string, instruction: string): void {
  appendLine(outDir, { t: "user", ts: Date.now(), text: instruction });
}

/** Closing line carrying the final answer and run identity. */
export function writeFinalLine(
  outDir: string,
  fields: { answer: string; session_id: string; model: string; agent_version: string },
): void {
  appendLine(outDir, { t: "final", ts: Date.now(), ...fields });
}

function textOf(blocks: Block[]): string {
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

function reasoningOf(blocks: Block[]): string | null {
  const parts = blocks
    .filter((b) => b.type === "thinking" && typeof b.thinking === "string")
    .map((b) => b.thinking as string);
  return parts.length ? parts.join("") : null;
}

function toolCallsOf(blocks: Block[]): Array<{ id: string; name: string; arguments: unknown }> {
  return blocks
    .filter((b) => b.type === "toolCall" && typeof b.id === "string")
    .map((b) => ({ id: b.id as string, name: b.name ?? "", arguments: b.arguments ?? {} }));
}

/**
 * Subscribe to the harness and write a `run.jsonl` line per assistant turn and
 * per tool result, spilling every tool-result image block to
 * `shots/shot-<n>.<ext>` and recording the relative path. The Python mapper
 * (`cua_harbor.trajectory`) reads these lines back into an ATIF trajectory.
 * Returns the unsubscribe handle.
 */
export function attachAtifSink(opts: {
  harness: { subscribe: (h: (e: AgentHarnessEvent) => void) => () => void };
  outDir: string;
}): () => void {
  const { harness, outDir } = opts;
  mkdirSync(join(outDir, SHOTS_DIR), { recursive: true });
  let shotCount = 0;

  return harness.subscribe((event: AgentHarnessEvent) => {
    if (event.type === "message_end") {
      const msg = event.message;
      if (msg.role !== "assistant") return;
      const blocks = (msg.content ?? []) as Block[];
      appendLine(outDir, {
        t: "assistant",
        ts: Date.now(),
        model: msg.model,
        text: textOf(blocks),
        reasoning: reasoningOf(blocks),
        tool_calls: toolCallsOf(blocks),
        usage: msg.usage,
      });
      return;
    }

    if (event.type === "tool_execution_end") {
      const blocks = ((event.result as { content?: Block[] } | undefined)?.content ?? []) as Block[];
      const shots: string[] = [];
      for (const block of blocks) {
        if (block.type !== "image" || typeof block.data !== "string") continue;
        const ext = EXT_BY_MIME[block.mimeType ?? "image/png"] ?? "png";
        shotCount += 1;
        const rel = `${SHOTS_DIR}/shot-${shotCount}.${ext}`;
        writeFileSync(join(outDir, rel), Buffer.from(block.data, "base64"));
        shots.push(rel);
      }
      const text = textOf(blocks);
      appendLine(outDir, {
        t: "tool_result",
        ts: Date.now(),
        call_id: event.toolCallId,
        is_error: event.isError,
        text: text || null,
        shots,
      });
    }
  });
}
