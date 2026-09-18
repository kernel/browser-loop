import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { observationFromElements } from "./browser";
import { OpenAICompatibleTextResolver } from "./text";

const observation = observationFromElements({
	url: "https://example.com/form",
	title: "Form",
	elements: [{
		id: "n1",
		node: 1,
		role: "combobox",
		name: "Destination",
		value: "",
		operations: ["TYPE_TEXT", "CLICK"],
		options: [],
		guard: "destination",
		rect: { x: 10, y: 10, width: 100, height: 30 },
	}],
});

describe("text resolver", () => {
	it("requests only the selected field's literal value", async () => {
		const originalFetch = globalThis.fetch;
		const originalReasoning = process.env.TEXT_MODEL_REASONING;
		delete process.env.TEXT_MODEL_REASONING;
		let request: { reasoning_effort?: string; messages?: Array<{ role?: string; content?: string }> } | undefined;
		globalThis.fetch = async (_input, init) => {
			request = JSON.parse(String(init?.body)) as typeof request;
			return new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"San Francisco"}' } }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};
		try {
			const value = await new OpenAICompatibleTextResolver({ apiKey: "test-key" }).resolve({
				purpose: "field",
				goal: 'Enter "San Francisco" in Destination, then submit',
				candidate: {
					id: "type:n1",
					kind: "target",
					operation: "TYPE_TEXT",
					label: 'Enter text in "Destination"',
					target: { documentId: observation.documentId, node: 1, guard: "destination" },
					textPurpose: "field",
				},
				observation,
				history: [],
			});
			assert.equal(value, "San Francisco");
			assert.equal(request?.reasoning_effort, "none");
			assert.match(request?.messages?.[0]?.content ?? "", /Do not return code/);
			assert.match(request?.messages?.[1]?.content ?? "", /Only the literal value for the selected field/);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalReasoning === undefined) delete process.env.TEXT_MODEL_REASONING;
			else process.env.TEXT_MODEL_REASONING = originalReasoning;
		}
	});

	it("honors the reasoning override for OpenRouter", async () => {
		const originalFetch = globalThis.fetch;
		const originalReasoning = process.env.TEXT_MODEL_REASONING;
		let request: { reasoning?: { effort?: string } } | undefined;
		process.env.TEXT_MODEL_REASONING = "low";
		globalThis.fetch = async (_input, init) => {
			request = JSON.parse(String(init?.body)) as typeof request;
			return new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"London"}' } }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};
		try {
			await new OpenAICompatibleTextResolver({ apiKey: "test-key", baseUrl: "https://openrouter.ai/api/v1" }).resolve({
				purpose: "field",
				goal: "Enter London in Destination",
				candidate: {
					id: "type:n1",
					kind: "target",
					operation: "TYPE_TEXT",
					label: 'Enter text in "Destination"',
					target: { documentId: observation.documentId, node: 1, guard: "destination" },
					textPurpose: "field",
				},
				observation,
				history: [],
			});
			assert.deepEqual(request?.reasoning, { effort: "low" });
		} finally {
			globalThis.fetch = originalFetch;
			if (originalReasoning === undefined) delete process.env.TEXT_MODEL_REASONING;
			else process.env.TEXT_MODEL_REASONING = originalReasoning;
		}
	});
});
