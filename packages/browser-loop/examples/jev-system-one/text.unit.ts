import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { observationFromSnapshot } from "./browser";
import { OpenAICompatibleTextResolver } from "./text";

const observation = observationFromSnapshot({
	url: "https://example.com/form",
	snapshot: 'RootWebArea "Form"\n  combobox "Destination" [e1]',
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
					id: "type:e1",
					kind: "browser-step",
					operation: "TYPE_TEXT",
					label: 'Enter text in "Destination"',
					ref: "e1",
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
