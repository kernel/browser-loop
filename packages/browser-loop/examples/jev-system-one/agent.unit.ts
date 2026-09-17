import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrowserAction } from "../../src/core/actions/browser";
import { runAgent } from "./agent";
import { observationFromSnapshot } from "./browser";
import type { BrowserRuntime, JevPolicy, PolicyDecision, PolicyInput, TextResolutionInput, TextResolver } from "./types";

class FakeBrowser implements BrowserRuntime {
	readonly actions: BrowserAction[] = [];
	#observation = blank;

	async observe() {
		return this.#observation;
	}

	async execute(action: BrowserAction) {
		this.actions.push(action);
		if (action.type === "browser_navigate") this.#observation = form;
		if (action.type === "browser_fill") this.#observation = filled;
	}
}

class ScriptedPolicy implements JevPolicy {
	#step = 0;

	async decide(input: PolicyInput): Promise<PolicyDecision> {
		const operation = (["NAVIGATE", "TYPE_TEXT", "DONE"] as const)[this.#step++]!;
		const candidate = input.space.byOperation.get(operation)?.[0];
		if (!candidate) throw new Error(`Missing ${operation} candidate`);
		return {
			operation,
			candidateId: candidate.id,
			operationConfidence: 0.99,
			latencyMs: 1,
			inputTokens: 10,
			outputTokens: 2,
			model: "test-jev",
		};
	}
}

class ScriptedTextResolver implements TextResolver {
	readonly calls: TextResolutionInput[] = [];

	async resolve(input: TextResolutionInput): Promise<string> {
		this.calls.push(input);
		return input.purpose === "navigation" ? "https://flights.example" : "SFO";
	}
}

const blank = observationFromSnapshot({
	url: "about:blank",
	snapshot: 'RootWebArea ""',
});
const form = observationFromSnapshot({
	url: "https://flights.example/",
	snapshot: ['RootWebArea "Flights"', '  textbox "From" [e1]', '  button "Search" [e2]'].join("\n"),
});
const filled = observationFromSnapshot({
	url: "https://flights.example/",
	snapshot: ['RootWebArea "Flights"', '  textbox "From" [e1] [value="SFO"]', '  button "Search" [e2]'].join("\n"),
});

describe("Jev browser agent", () => {
	it("rechecks page freshness before accepting DONE", async () => {
		let observations = 0;
		let decisions = 0;
		const changed = observationFromSnapshot({ url: "https://example.com/complete", snapshot: 'RootWebArea "Complete"\n  heading "Finished" [e1]' });
		const browser: BrowserRuntime = {
			observe: async () => ++observations === 1 ? form : changed,
			execute: async () => { throw new Error("DONE must not execute a browser action"); },
		};
		const policy: JevPolicy = {
			decide: async (input) => {
				decisions += 1;
				const candidate = input.space.byOperation.get("DONE")?.[0];
				if (!candidate) throw new Error("Missing DONE candidate");
				return {
					operation: "DONE",
					candidateId: candidate.id,
					operationConfidence: 0.99,
					latencyMs: 1,
					inputTokens: 1,
					outputTokens: 1,
					model: "test-jev",
				};
			},
		};

		const result = await runAgent({ goal: "Finish the task", browser, policy });
		assert.equal(result.status, "completed");
		assert.equal(result.finalObservation.fingerprint, changed.fingerprint);
		assert.equal(decisions, 2);
	});

	it("executes a stable candidate when only non-interactive page text changes", async () => {
		const before = observationFromSnapshot({
			url: "https://example.com/",
			snapshot: 'RootWebArea "Live page"\n  button "Continue" [e1]\n  StaticText "12:00:00"',
		});
		const churned = observationFromSnapshot({
			url: "https://example.com/",
			snapshot: 'RootWebArea "Live page"\n  button "Continue" [e1]\n  StaticText "12:00:01"',
		});
		const complete = observationFromSnapshot({
			url: "https://example.com/done",
			snapshot: 'RootWebArea "Complete"\n  heading "Finished" [e1]',
		});
		const observations = [before, churned, complete, complete];
		const actions: BrowserAction[] = [];
		let observationIndex = 0;
		let decisionIndex = 0;
		const browser: BrowserRuntime = {
			observe: async () => observations[observationIndex++] ?? complete,
			execute: async (action) => { actions.push(action); },
		};
		const policy: JevPolicy = {
			decide: async (input) => {
				const operation = decisionIndex++ === 0 ? "CLICK" : "DONE";
				const candidate = input.space.byOperation.get(operation)?.[0];
				if (!candidate) throw new Error(`Missing ${operation} candidate`);
				return {
					operation,
					candidateId: candidate.id,
					operationConfidence: 0.99,
					latencyMs: 1,
					inputTokens: 1,
					outputTokens: 1,
					model: "test-jev",
				};
			},
		};

		const result = await runAgent({ goal: "Continue until finished", browser, policy });
		assert.equal(result.status, "completed");
		assert.equal(decisionIndex, 2);
		assert.deepEqual(actions, [{ type: "browser_click", ref: "e1" }]);
	});

	it("rejects non-HTTP navigation values before browser execution", async () => {
		const browser = new FakeBrowser();
		const result = await runAgent({
			goal: "Open the requested site",
			browser,
			policy: new ScriptedPolicy(),
			textResolver: { resolve: async () => "javascript:alert(1)" },
		});
		assert.equal(result.status, "failed");
		assert.match(result.reason, /unsupported URL/);
		assert.deepEqual(browser.actions, []);
	});

	it("keeps initial navigation inside the loop and resolves field text after target selection", async () => {
		const browser = new FakeBrowser();
		const textResolver = new ScriptedTextResolver();
		const progress: string[] = [];
		const result = await runAgent({
			goal: "Open Google Flights and set From to SFO",
			browser,
			policy: new ScriptedPolicy(),
			textResolver,
			onDecision: (trace) => progress.push(`decision:${trace.operation}`),
			onAction: (trace) => progress.push(`action:${trace.operation}`),
		});

		assert.equal(result.status, "completed");
		assert.deepEqual(browser.actions[0], { type: "browser_navigate", url: "https://flights.example/" });
		assert.deepEqual(browser.actions[1], {
			type: "browser_fill",
			ref: "e1",
			value: "SFO",
		});
		assert.deepEqual(textResolver.calls.map((call) => call.purpose), ["navigation", "field"]);
		assert.equal(result.history[0]?.operation, "NAVIGATE");
		assert.equal(result.history[1]?.operation, "TYPE_TEXT");
		assert.deepEqual(progress, [
			"decision:NAVIGATE",
			"action:NAVIGATE",
			"decision:TYPE_TEXT",
			"action:TYPE_TEXT",
			"decision:DONE",
		]);
	});
});
