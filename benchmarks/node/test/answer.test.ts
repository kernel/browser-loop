import { describe, expect, it } from "vitest";
import { extractFinalAnswer } from "../src/answer.ts";

describe("extractFinalAnswer", () => {
  it("joins the text blocks of the last assistant message", () => {
    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "Example " },
            { type: "text", text: "Domain" },
          ],
        },
      },
    ] as never[];
    expect(extractFinalAnswer(branch)).toBe("Example Domain");
  });

  it("ignores non-message and non-assistant entries", () => {
    const branch = [
      { type: "model_change" },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "second" }] } },
    ] as never[];
    expect(extractFinalAnswer(branch)).toBe("first");
  });

  it("returns an empty string when there is no assistant message", () => {
    expect(extractFinalAnswer([])).toBe("");
  });
});
