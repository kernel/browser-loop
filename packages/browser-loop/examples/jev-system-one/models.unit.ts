import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { buildCandidateSpace } from "./actions";
import { observationFromElements } from "./browser";
import { SystemOneJevPolicy } from "./models";

const blank = observationFromElements({ url: "about:blank" });

describe("System One policy", () => {
	it("conditions the operation choice on the goal and observed page state", async () => {
		let request: Record<string, unknown> | undefined;
		const client = new TypeSafeClient({
			apiKey: "test-key",
			fetch: async (_input, init) => {
				request = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(JSON.stringify({
					model: "jev-test",
					answers: {
						operation: {
							type: "choice",
							choice: "NAVIGATE",
							confidence: 0.99,
							probabilities: { NAVIGATE: 0.99, WAIT: 0.003, DONE: 0.003, BLOCKED: 0.004 },
						},
					},
					usage: { input_tokens: 20, output_tokens: 4 },
				}), { status: 200, headers: { "Content-Type": "application/json" } });
			},
		});
		const goal = "Open Google Flights";
		const space = buildCandidateSpace(blank, goal);
		const decision = await new SystemOneJevPolicy(client).decide({ goal, observation: blank, space, history: [] });

		assert.equal(decision.operation, "NAVIGATE");
		assert.equal(decision.candidateId, "navigate:resolve");
		assert.deepEqual((request?.state as { goal?: string; page?: { url?: string } }), {
			goal,
			page: { url: "about:blank", title: "", text: "", scroll: blank.scroll, omitted_elements: 0 },
			elements: [],
			recent_actions: [],
		});
	});
});
