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
		let request: { messages?: Array<{ role?: string; content?: string }> } | undefined;
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
			assert.match(request?.messages?.[0]?.content ?? "", /Do not return code/);
			assert.match(request?.messages?.[1]?.content ?? "", /Only the literal value for the selected field/);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
