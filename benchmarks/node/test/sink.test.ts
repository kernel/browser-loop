import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHarnessEvent } from "@onkernel/cua-agent";
import { describe, expect, it } from "vitest";
import { attachAtifSink, writeFinalLine, writeUserLine } from "../src/sink.ts";

/** Harness stub that captures the subscribed handler so tests can drive it. */
function fakeHarness(): {
  subscribe: (h: (e: AgentHarnessEvent) => void) => () => void;
  emit: (e: AgentHarnessEvent) => void;
} {
  let handler: ((e: AgentHarnessEvent) => void) | undefined;
  return {
    subscribe(h) {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    emit(e) {
      handler?.(e);
    },
  };
}

function readJsonl(outDir: string): Array<Record<string, unknown>> {
  return readFileSync(join(outDir, "run.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// 1x1 transparent PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("attachAtifSink", () => {
  it("writes user, assistant, and tool_result lines and spills a screenshot", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cua-sink-"));
    const harness = fakeHarness();

    writeUserLine(outDir, "go to example.com");
    attachAtifSink({ harness, outDir });

    harness.emit({
      type: "message_end",
      message: {
        role: "assistant",
        model: "anthropic:claude-opus-4-8",
        content: [
          { type: "thinking", thinking: "I should click" },
          { type: "text", text: "clicking now" },
          { type: "toolCall", id: "call_1", name: "click", arguments: { x: 1, y: 2 } },
        ],
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17, cost: { total: 0.01 } },
      },
    } as never);
    harness.emit({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "click",
      isError: false,
      result: {
        content: [
          { type: "text", text: "ok" },
          { type: "image", data: PNG_B64, mimeType: "image/png" },
        ],
      },
    } as never);

    writeFinalLine(outDir, {
      answer: "Example Domain",
      session_id: "t1",
      model: "anthropic:claude-opus-4-8",
      agent_version: "0.3.5",
    });

    const records = readJsonl(outDir);
    expect(records.map((r) => r.t)).toEqual(["user", "assistant", "tool_result", "final"]);

    const assistant = records[1];
    expect(assistant.text).toBe("clicking now");
    expect(assistant.reasoning).toBe("I should click");
    expect(assistant.tool_calls).toEqual([
      { id: "call_1", name: "click", arguments: { x: 1, y: 2 } },
    ]);

    const toolResult = records[2];
    expect(toolResult.call_id).toBe("call_1");
    expect(toolResult.is_error).toBe(false);
    expect(toolResult.text).toBe("ok");
    expect(toolResult.shots).toEqual(["shots/shot-1.png"]);
    expect(existsSync(join(outDir, "shots/shot-1.png"))).toBe(true);
  });

  it("records reasoning as null when the turn has no thinking block", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cua-sink-"));
    const harness = fakeHarness();
    attachAtifSink({ harness, outDir });

    harness.emit({
      type: "message_end",
      message: {
        role: "assistant",
        model: "openai:gpt-5.5",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
      },
    } as never);

    const assistant = readJsonl(outDir)[0];
    expect(assistant.reasoning).toBeNull();
    expect(assistant.tool_calls).toEqual([]);
  });
});
