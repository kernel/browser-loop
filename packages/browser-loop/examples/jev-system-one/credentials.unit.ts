import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCandidateSpace } from "./actions";
import { observationFromElements } from "./browser";
import { mergeCredentialForms } from "./credentials";
import type { ObservationElement } from "./types";

function element(value: string): ObservationElement {
	return {
		id: "n1",
		node: 1,
		role: "textbox",
		name: "Password",
		value,
		operations: ["TYPE_TEXT", "CLICK"],
		options: [],
		guard: "raw-guard",
		rect: { x: 10, y: 10, width: 100, height: 30 },
	};
}

describe("credential form observations", () => {
	it("redacts sensitive values while retaining filled state", () => {
		const elements = [element("not-for-models")];
		const forms = mergeCredentialForms(elements, [{
			id: "form:1",
			name: "Sign in",
			fields: [{
				id: "credential:1",
				node: 1,
				name: "Password",
				semantic: "password",
				type: "password",
				autocomplete: "current-password",
				sensitive: true,
				hasValue: true,
				guard: "redacted-guard",
			}],
		}], "doc");
		const observation = observationFromElements({ url: "https://example.com/login", documentId: "doc", elements, credentialForms: forms });

		assert.equal(observation.elements[0]?.value, "");
		assert.equal(observation.elements[0]?.hasValue, true);
		assert.equal(observation.elements[0]?.operations.includes("TYPE_TEXT"), false);
		assert.doesNotMatch(JSON.stringify(observation), /not-for-models/);
	});

	it("offers one grouped credential action only when a broker is available", () => {
		const observation = observationFromElements({
			url: "https://example.com/login",
			credentialForms: [{
				id: "form:1",
				name: "Sign in",
				fields: [{
					id: "credential:1",
					name: "Email",
					semantic: "identifier",
					type: "email",
					autocomplete: "username",
					sensitive: false,
					hasValue: false,
					target: { documentId: "test-document", node: 1, guard: "guard" },
				}],
			}],
		});

		assert.equal(buildCandidateSpace(observation, "sign in").byOperation.has("USE_CREDENTIALS"), false);
		const candidates = buildCandidateSpace(observation, "sign in", [], { credentials: true }).byOperation.get("USE_CREDENTIALS");
		assert.equal(candidates?.length, 1);
		assert.equal(candidates?.[0]?.credentialForm?.fields.length, 1);
		observation.credentialForms[0]!.fields[0]!.hasValue = true;
		assert.equal(buildCandidateSpace(observation, "sign in", [], { credentials: true }).byOperation.has("USE_CREDENTIALS"), false);
	});
});
