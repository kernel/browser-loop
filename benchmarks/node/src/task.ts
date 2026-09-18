import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CuaAgentHarness, InMemorySessionRepo, NodeExecutionEnv } from "@onkernel/cua-agent";
import { type CuaModelRef, type ImageContent, requireCuaEnvApiKeyForModel } from "@onkernel/cua-ai";
import Kernel from "@onkernel/sdk";
import { extractFinalAnswer } from "./answer.ts";
import { attachAtifSink, writeFinalLine, writeUserLine } from "./sink.ts";

/** Pinned @onkernel/cua-agent version; surfaced in the run.jsonl `final` line. */
const CUA_AGENT_VERSION = "0.3.5";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readInstruction(): string {
  const fromEnv = process.env.AGENT_INSTRUCTION;
  if (fromEnv) return fromEnv;
  const fromArg = process.argv[2];
  if (fromArg) return fromArg;
  throw new Error("instruction is required (set AGENT_INSTRUCTION or pass it as the first argument)");
}

/** Truthy env flag: `1`, `true`, or `yes` (case-insensitive). */
function envFlag(name: string): boolean {
  const value = process.env[name]?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Capture the current browser frame for the first model turn. Each benchmark
 * task runs in a brand-new session, so — like the cua CLI on a fresh session —
 * the model would otherwise take its first turn without seeing the page.
 * Best-effort: a capture failure returns undefined rather than failing the run.
 */
async function initialScreenshot(
  client: Kernel,
  sessionId: string,
): Promise<ImageContent[] | undefined> {
  try {
    const response = await client.browsers.computer.captureScreenshot(sessionId);
    const data = Buffer.from(await response.arrayBuffer()).toString("base64");
    return [{ type: "image", data, mimeType: "image/png" }];
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  // The Python agent maps Harbor's `provider/name` to cua's `provider:name`;
  // requireCuaEnvApiKeyForModel validates the ref at runtime below.
  const model = requireEnv("CUA_MODEL") as CuaModelRef;
  const outDir = requireEnv("AGENT_OUT_DIR");
  const taskId = process.env.TASK_ID ?? "cua-task";
  const instruction = readInstruction();

  requireCuaEnvApiKeyForModel(model);

  const client = new Kernel({ apiKey: requireEnv("KERNEL_API_KEY") });
  const sessionId = requireEnv("KERNEL_SESSION_ID");
  const browser = await client.browsers.retrieve(sessionId);
  const session = await new InMemorySessionRepo().create({ id: taskId });
  const harness = new CuaAgentHarness({
    browser,
    client,
    env: new NodeExecutionEnv({ cwd: process.cwd() }),
    model,
    session,
    computerUseExtra: true,
    // `playwright_execute` is an extra power tool; off by default to match the
    // cua CLI and keep cross-model benchmark comparisons apples-to-apples.
    playwright: envFlag("CUA_PLAYWRIGHT"),
  });

  writeUserLine(outDir, instruction);
  const unsubscribe = attachAtifSink({ harness, outDir });
  try {
    const images = await initialScreenshot(client, sessionId);
    const assistant = await harness.prompt(instruction, images ? { images } : undefined);
    // A failed turn (provider error / abort) must not masquerade as a clean
    // finish: throw so the run exits non-zero and the Python agent doesn't grade
    // a blank or misleading answer as success.
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      throw new Error(assistant.errorMessage ?? `agent stopped with ${assistant.stopReason}`);
    }
  } finally {
    unsubscribe();
  }

  const branch = await session.getBranch();
  const answer = extractFinalAnswer(branch);
  writeFileSync(join(outDir, "answer.txt"), answer);
  writeFinalLine(outDir, { answer, session_id: taskId, model, agent_version: CUA_AGENT_VERSION });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
