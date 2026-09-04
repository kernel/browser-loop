import type { AgentMessage } from "@onkernel/cua-agent";

interface BranchEntryLike {
  type: string;
  message?: AgentMessage;
}

/** Last assistant text from a session branch, joining its text blocks. */
export function extractFinalAnswer(branch: BranchEntryLike[]): string {
  const last = [...branch]
    .reverse()
    .flatMap((entry) =>
      entry.type === "message" && entry.message?.role === "assistant" ? [entry.message] : [],
    )[0];
  const content = last?.content ?? [];
  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
}
