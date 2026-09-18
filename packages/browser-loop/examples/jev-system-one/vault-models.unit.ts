import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { CredentialVaultItem } from "@onkernel/sdk/resources/vaults/items";
import type { CredentialForm } from "./types";
import { SystemOneVaultCredentialPolicy } from "./vault-models";

const form: CredentialForm = {
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
		target: { documentId: "doc", node: 1, guard: "guard" },
	}],
};

const item: CredentialVaultItem = {
	id: "item",
	key: "custom-user-key",
	type: "credential",
	version: 1,
	spec: { description: "Example", fields: [{ name: "email", type: "email", required: true, sensitive: false }] },
	state: { status: "ready", fields: { email: { has_value: true, value: "person@example.com" } } },
	available_operations: [{ type: "fill", description: "Fill" }],
	available_expansions: [],
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
};

describe("System One vault credential policy", () => {
	it("blocks forms that cannot receive a distinct item field mapping", async () => {
		const client = new TypeSafeClient({
			apiKey: "test",
			fetch: async () => assert.fail("System One should not run without a distinct mapping"),
		});
		const secondField = { ...form.fields[0]!, id: "credential:2", name: "Username", type: "text" };
		await assert.rejects(
			new SystemOneVaultCredentialPolicy(client).map({
				goal: "Sign in",
				url: "https://example.com/login",
				title: "Sign in",
				form: { ...form, fields: [...form.fields, secondField] },
				item,
			}),
			/cannot map distinct fields/,
		);
	});

	it("passes credential items through exactly as returned by the API", async () => {
		let request: { state?: { credential_items?: CredentialVaultItem[] } } | undefined;
		const client = new TypeSafeClient({
			apiKey: "test",
			fetch: async (_input, init) => {
				request = JSON.parse(String(init?.body)) as typeof request;
				return new Response(JSON.stringify({
					model: "jev-test",
					answers: { credential: { type: "choice", choice: "item:0", confidence: 0.99, probabilities: { "item:0": 0.99 } } },
					usage: { input_tokens: 1, output_tokens: 1 },
				}), { status: 200, headers: { "Content-Type": "application/json" } });
			},
		});
		const choice = await new SystemOneVaultCredentialPolicy(client).choose({
			goal: "Sign in",
			url: "https://example.com/login",
			title: "Sign in",
			form,
			items: [item],
		});

		assert.equal(choice.choice, "item:0");
		assert.deepEqual(request?.state?.credential_items, [item]);
	});
});
