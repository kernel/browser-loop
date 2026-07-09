import { describe, expect, it } from "vitest";
import { runAction } from "../src/action/harness-runner";
import { buildTestHarness, type TestHarnessFixture } from "./fixtures/harness";

let fixture: TestHarnessFixture | undefined;

describe("action harness-runner", () => {
	it("exits 0 with formatted result when a click action succeeds", async () => {
		fixture = await buildTestHarness({
			turns: [
				{
					steps: [
						{
							type: "tool_call",
							toolName: "click",
							args: { x: 123, y: 45 },
						},
					],
				},
				{
					steps: [{ type: "text", text: "clicked" }],
				},
			],
		});
		const res = await runAction(
			{ action: "click", target: "the button" },
			{ harness: fixture.harness, browserHandle: handleFor(fixture), session: fixture.session, maxTurns: 5 },
		);
		expect(res.exitCode).toBe(0);
		expect(res.result.coordinates).toEqual([123, 45]);
		expect(res.result.action).toBe("click");
	});

	it("exits 1 when the model says NOT_FOUND", async () => {
		fixture = await buildTestHarness({
			turns: [
				{
					steps: [{ type: "text", text: "NOT_FOUND: no match" }],
				},
			],
		});
		const res = await runAction(
			{ action: "click", target: "missing" },
			{ harness: fixture.harness, browserHandle: handleFor(fixture), session: fixture.session, maxTurns: 5 },
		);
		expect(res.exitCode).toBe(1);
		expect(res.result.status).toBe("not_found");
		expect(res.result.text).toBe("no match");
	});

	it("exits 2 when the provider returns an error", async () => {
		fixture = await buildTestHarness({
			turns: [{ steps: [{ type: "error", message: "boom" }] }],
		});
		const res = await runAction(
			{ action: "do", text: "fail" },
			{ harness: fixture.harness, browserHandle: handleFor(fixture), session: fixture.session, maxTurns: 3 },
		);
		expect(res.exitCode).toBe(2);
		expect(res.result.status).toBe("error");
		expect(res.result.text).toContain("boom");
	});

	it("invokes harness.abort once the turn cap is reached", async () => {
		const toolCall = {
			steps: [
				{
					type: "tool_call" as const,
					toolName: "click",
					args: { x: 1, y: 1 },
				},
			],
		};
		fixture = await buildTestHarness({
			turns: Array.from({ length: 10 }, () => toolCall),
		});
		// Spy on harness.abort so we don't depend on the scripted provider
		// honouring the abort signal (it runs synchronously below the loop).
		let abortCalls = 0;
		const originalAbort = fixture.harness.abort.bind(fixture.harness);
		fixture.harness.abort = async () => {
			abortCalls += 1;
			return originalAbort();
		};
		await runAction(
			{ action: "do", text: "loop" },
			{ harness: fixture.harness, browserHandle: handleFor(fixture), session: fixture.session, maxTurns: 2 },
		);
		expect(abortCalls).toBeGreaterThanOrEqual(1);
	});

	it("attaches a screenshot to the first user message on a fresh session", async () => {
		fixture = await buildTestHarness({
			turns: [{ steps: [{ type: "text", text: "ok" }] }],
		});
		await runAction(
			{ action: "do", text: "look" },
			{ harness: fixture.harness, browserHandle: handleFor(fixture), session: fixture.session, maxTurns: 3 },
		);
		expect(fixture.kernel.screenshots).toBeGreaterThanOrEqual(1);
		const entries = await fixture.session.getBranch();
		const firstUser = entries.find((e) => e.type === "message" && e.message.role === "user");
		expect(firstUser).toBeDefined();
		const content = (firstUser as { message: { content: unknown[] } }).message.content as Array<{
			type: string;
		}>;
		expect(content.some((c) => c.type === "image")).toBe(true);
	});
});

function handleFor(fixture: TestHarnessFixture) {
	return {
		client: fixture.kernel.client,
		browser: fixture.kernel.browser,
		async close(): Promise<void> {},
	};
}
