import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrowserAction } from "../../src/core/actions/browser";
import { runAgent } from "./agent";
import { observationFromElements } from "./browser";
import { CredentialBlockedError } from "./types";
import type { BrowserRuntime, CredentialBroker, JevCandidate, JevPolicy, ObservationElement, PolicyDecision, PolicyInput, TextResolutionInput, TextResolver } from "./types";

function element(id: string, role: string, name: string, operations: ObservationElement["operations"], value = ""): ObservationElement {
	return {
		id,
		node: Number(id.slice(1)),
		role,
		name,
		value,
		operations,
		options: [],
		guard: `guard-${id}-${value}`,
		rect: { x: 10, y: 10, width: 100, height: 30 },
	};
}

const blank = observationFromElements({ url: "about:blank" });
const form = observationFromElements({
	url: "https://flights.example/",
	title: "Flights",
	elements: [element("n1", "textbox", "From", ["TYPE_TEXT", "CLICK"]), element("n2", "button", "Search", ["CLICK"])],
});
const filled = observationFromElements({
	url: "https://flights.example/",
	title: "Flights",
	elements: [element("n1", "textbox", "From", ["TYPE_TEXT", "CLICK"], "SFO"), element("n2", "button", "Search", ["CLICK"])],
});

class FakeBrowser implements BrowserRuntime {
	readonly actions: BrowserAction[] = [];
	readonly targets: Array<{ candidate: JevCandidate; value?: string }> = [];
	#observation = blank;

	async observe() { return this.#observation; }
	async isFresh() { return true; }
	async execute(action: BrowserAction) {
		this.actions.push(action);
		if (action.type === "browser_navigate") this.#observation = form;
	}
	async executeTarget(candidate: JevCandidate, value?: string) {
		this.targets.push({ candidate, ...(value === undefined ? {} : { value }) });
		if (candidate.operation === "TYPE_TEXT") this.#observation = filled;
	}
}

class ScriptedPolicy implements JevPolicy {
	#step = 0;
	async decide(input: PolicyInput): Promise<PolicyDecision> {
		const operation = (["NAVIGATE", "TYPE_TEXT", "DONE"] as const)[this.#step++]!;
		const candidate = input.space.byOperation.get(operation)?.[0];
		if (!candidate) throw new Error(`Missing ${operation} candidate`);
		return { operation, candidateId: candidate.id, operationConfidence: 0.99, latencyMs: 1, inputTokens: 10, outputTokens: 2, model: "test-jev" };
	}
}

class ScriptedTextResolver implements TextResolver {
	readonly calls: TextResolutionInput[] = [];
	async resolve(input: TextResolutionInput): Promise<string> {
		this.calls.push(input);
		return input.purpose === "navigation" ? "https://flights.example" : "SFO";
	}
}

describe("Jev browser agent", () => {
	it("re-observes and asks again when terminal freshness fails", async () => {
		const changed = observationFromElements({ url: "https://example.com/complete", title: "Complete", text: "Finished" });
		let observations = 0;
		let freshnessChecks = 0;
		let decisions = 0;
		const browser: BrowserRuntime = {
			observe: async () => ++observations === 1 ? form : changed,
			isFresh: async () => ++freshnessChecks > 1,
			execute: async () => { throw new Error("DONE must not execute"); },
			executeTarget: async () => { throw new Error("DONE must not execute"); },
		};
		const policy: JevPolicy = {
			decide: async (input) => {
				decisions += 1;
				const candidate = input.space.byOperation.get("DONE")?.[0];
				if (!candidate) throw new Error("Missing DONE candidate");
				return { operation: "DONE", candidateId: candidate.id, operationConfidence: 0.99, latencyMs: 1, inputTokens: 1, outputTokens: 1, model: "test-jev" };
			},
		};
		const result = await runAgent({ goal: "Finish", browser, policy });
		assert.equal(result.status, "completed");
		assert.equal(result.finalObservation.fingerprint, changed.fingerprint);
		assert.equal(decisions, 2);
	});

	it("validates the selected target without taking a full pre-action observation", async () => {
		const complete = observationFromElements({ url: "https://example.com/done", title: "Complete", text: "Finished" });
		let observations = 0;
		let decisions = 0;
		const executed: JevCandidate[] = [];
		const browser: BrowserRuntime = {
			observe: async () => ++observations === 1 ? form : complete,
			isFresh: async () => true,
			execute: async () => {},
			executeTarget: async (candidate) => { executed.push(candidate); },
		};
		const policy: JevPolicy = {
			decide: async (input) => {
				const operation = decisions++ === 0 ? "CLICK" : "DONE";
				const candidate = input.space.byOperation.get(operation)?.find((item) => operation !== "CLICK" || item.id === "click:n2");
				if (!candidate) throw new Error(`Missing ${operation}`);
				return { operation, candidateId: candidate.id, operationConfidence: 0.99, latencyMs: 1, inputTokens: 1, outputTokens: 1, model: "test-jev" };
			},
		};
		const result = await runAgent({ goal: "Search", browser, policy });
		assert.equal(result.status, "completed");
		assert.equal(observations, 2);
		assert.equal(executed[0]?.id, "click:n2");
	});

	it("re-observes instead of remapping a stale target by candidate id", async () => {
		const replacement = observationFromElements({
			url: form.url,
			elements: [element("n9", "button", "Search", ["CLICK"])],
		});
		let observations = 0;
		let checks = 0;
		let decisions = 0;
		const executed: string[] = [];
		const browser: BrowserRuntime = {
			observe: async () => ++observations === 1 ? form : replacement,
			isFresh: async (_observation, candidate) => candidate.kind === "terminal" || ++checks > 1,
			execute: async () => {},
			executeTarget: async (candidate) => { executed.push(candidate.id); },
		};
		const policy: JevPolicy = {
			decide: async (input) => {
				const operation = decisions++ < 2 ? "CLICK" : "DONE";
				const candidate = input.space.byOperation.get(operation)?.find((item) => operation !== "CLICK" || item.label.includes("Search"));
				if (!candidate) throw new Error(`Missing ${operation}`);
				return { operation, candidateId: candidate.id, operationConfidence: 0.99, latencyMs: 1, inputTokens: 1, outputTokens: 1, model: "test-jev" };
			},
		};
		const result = await runAgent({ goal: "Search", browser, policy });
		assert.equal(result.status, "completed");
		assert.deepEqual(executed, ["click:n9"]);
	});

	it("suppresses an action repeated from the same interactive state", async () => {
		const reservation = element("n1", "link", "Make a Reservation", ["CLICK"]);
		const top = observationFromElements({
			url: "https://restaurant.example/",
			text: "Homepage",
			elements: [reservation],
			scroll: { y: 0, height: 1_000, viewport: 800, width: 1_200, x: 600, pointY: 650 },
		});
		const bottom = observationFromElements({
			url: top.url,
			text: "Footer",
			elements: [reservation],
			scroll: { y: 200, height: 1_000, viewport: 800, width: 1_200, x: 600, pointY: 650 },
		});
		const complete = observationFromElements({ url: `${top.url}reservations`, text: "Reservation form" });
		let observation = top;
		const decisions: string[] = [];
		const browser: BrowserRuntime = {
			observe: async () => observation,
			isFresh: async () => true,
			execute: async (action) => {
				if (action.type !== "browser_scroll") throw new Error(`Unexpected ${action.type}`);
				observation = action.direction === "down" ? bottom : top;
			},
			executeTarget: async () => { observation = complete; },
		};
		const policy: JevPolicy = {
			decide: async (input) => {
				const operation = input.space.byOperation.has("SCROLL") ? "SCROLL" : input.space.byOperation.has("CLICK") ? "CLICK" : "DONE";
				decisions.push(operation);
				const candidate = input.space.byOperation.get(operation)?.[0];
				if (!candidate) throw new Error(`Missing ${operation}`);
				return { operation, candidateId: candidate.id, operationConfidence: 0.99, latencyMs: 1, inputTokens: 1, outputTokens: 1, model: "test-jev" };
			},
		};

		const result = await runAgent({ goal: "Open the reservation form", browser, policy });
		assert.equal(result.status, "completed");
		assert.deepEqual(result.history.map((entry) => entry.operation), ["SCROLL", "SCROLL", "CLICK"]);
		assert.deepEqual(decisions, ["SCROLL", "SCROLL", "SCROLL", "CLICK", "DONE"]);
	});

	it("allows repeated navigation-safe waits", async () => {
		const actions: BrowserAction[] = [];
		let decision = 0;
		const browser: BrowserRuntime = {
			observe: async () => form,
			isFresh: async () => true,
			execute: async (action) => { actions.push(action); },
			executeTarget: async () => {},
		};
		const policy: JevPolicy = {
			decide: async (input) => {
				const operation = decision++ < 2 ? "WAIT" : "DONE";
				const candidate = input.space.byOperation.get(operation)?.[0];
				if (!candidate) throw new Error(`Missing ${operation}`);
				return { operation, candidateId: candidate.id, operationConfidence: 0.99, latencyMs: 1, inputTokens: 1, outputTokens: 1, model: "test-jev" };
			},
		};
		const result = await runAgent({ goal: "Wait", browser, policy });
		assert.equal(result.status, "completed");
		assert.deepEqual(actions, [
			{ type: "browser_act", steps: [{ type: "wait", ms: 100 }] },
			{ type: "browser_act", steps: [{ type: "wait", ms: 100 }] },
		]);
	});

	it("keeps navigation in the loop and resolves text after target selection", async () => {
		const browser = new FakeBrowser();
		const textResolver = new ScriptedTextResolver();
		const result = await runAgent({ goal: "Open flights and set From to SFO", browser, policy: new ScriptedPolicy(), textResolver });
		assert.equal(result.status, "completed");
		assert.deepEqual(browser.actions, [{ type: "browser_navigate", url: "https://flights.example/" }]);
		assert.equal(browser.targets[0]?.candidate.id, "type:n1");
		assert.equal(browser.targets[0]?.value, "SFO");
		assert.deepEqual(textResolver.calls.map((call) => call.purpose), ["navigation", "field"]);
	});

	it("runs grouped credential actions without sending values through text resolution", async () => {
		const credentialForm = {
			id: "form:login",
			name: "Sign in",
			fields: [{
				id: "credential:1",
				name: "Password",
				semantic: "password" as const,
				type: "password",
				autocomplete: "current-password",
				sensitive: true,
				hasValue: false,
				target: { documentId: "doc", node: 1, guard: "guard" },
			}],
		};
		const before = observationFromElements({ url: "https://example.com/login", documentId: "doc", credentialForms: [credentialForm] });
		const after = observationFromElements({
			url: before.url,
			documentId: "doc",
			credentialForms: [{ ...credentialForm, fields: [{ ...credentialForm.fields[0]!, hasValue: true }] }],
		});
		let current = before;
		let brokerCalls = 0;
		const browser: BrowserRuntime = {
			observe: async () => current,
			isFresh: async () => true,
			execute: async () => assert.fail("browser action not expected"),
			executeTarget: async () => assert.fail("target action not expected"),
		};
		const credentialBroker: CredentialBroker = {
			use: async () => { brokerCalls += 1; current = after; },
		};
		let decisions = 0;
		const policy: JevPolicy = {
			decide: async (input) => {
				const operation = decisions++ === 0 ? "USE_CREDENTIALS" : "DONE";
				const selected = input.space.byOperation.get(operation)?.[0];
				if (!selected) throw new Error(`Missing ${operation}`);
				return { operation, candidateId: selected.id, operationConfidence: 0.99, latencyMs: 1, inputTokens: 1, outputTokens: 1, model: "test-jev" };
			},
		};
		const result = await runAgent({ goal: "Sign in", browser, policy, credentialBroker, textResolver: { resolve: async () => assert.fail("text resolver not expected") } });
		assert.equal(result.status, "completed");
		assert.equal(brokerCalls, 1);
		assert.deepEqual(result.history.map((entry) => entry.operation), ["USE_CREDENTIALS"]);
	});

	it("reports a credential no-match as blocked", async () => {
		const credentialForm = {
			id: "form:login",
			name: "Sign in",
			fields: [{ id: "credential:1", name: "Password", semantic: "password" as const, type: "password", autocomplete: "current-password", sensitive: true, hasValue: false, target: { documentId: "doc", node: 1, guard: "guard" } }],
		};
		const current = observationFromElements({ url: "https://example.com/login", documentId: "doc", credentialForms: [credentialForm] });
		const browser: BrowserRuntime = { observe: async () => current, isFresh: async () => true, execute: async () => {}, executeTarget: async () => {} };
		const policy: JevPolicy = {
			decide: async (input) => {
				const selected = input.space.byOperation.get("USE_CREDENTIALS")?.[0];
				if (!selected) throw new Error("Missing USE_CREDENTIALS");
				return { operation: "USE_CREDENTIALS", candidateId: selected.id, operationConfidence: 0.99, latencyMs: 1, inputTokens: 1, outputTokens: 1, model: "test-jev" };
			},
		};
		const result = await runAgent({ goal: "Sign in", browser, policy, credentialBroker: { use: async () => { throw new CredentialBlockedError("No matching credential"); } } });
		assert.equal(result.status, "blocked");
		assert.equal(result.reason, "No matching credential");
	});

	it("rejects non-HTTP navigation values before execution", async () => {
		const browser = new FakeBrowser();
		const result = await runAgent({ goal: "Open the site", browser, policy: new ScriptedPolicy(), textResolver: { resolve: async () => "javascript:alert(1)" } });
		assert.equal(result.status, "failed");
		assert.match(result.reason, /unsupported URL/);
		assert.deepEqual(browser.actions, []);
	});
});
