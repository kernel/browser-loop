import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type Kernel from "@onkernel/sdk";
import type { CredentialVaultItem } from "@onkernel/sdk/resources/vaults/items";
import type { BrowserRuntime, CredentialForm, JevCandidate, Observation } from "./types";
import { observationFromElements } from "./browser";
import { CREATE_NEW_CREDENTIAL, KernelVaultCredentialBroker, type VaultCredentialPolicy } from "./vault";

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

const observation = observationFromElements({
	url: "https://example.com/login",
	title: "Sign in",
	documentId: "doc",
	credentialForms: [form],
});

const candidate: JevCandidate = {
	id: "credentials:form:1",
	kind: "credential",
	operation: "USE_CREDENTIALS",
	label: "Use a vault credential",
	credentialForm: form,
};

function credential(overrides: Partial<CredentialVaultItem> = {}): CredentialVaultItem {
	return {
		id: "item-id",
		key: "arbitrary-existing-key",
		type: "credential",
		version: 1,
		spec: { description: "Example", fields: [{ name: "email", type: "email", required: true, sensitive: false }] },
		state: { status: "ready", fields: { email: { has_value: true, value: "person@example.com" } } },
		available_operations: [{ type: "fill", description: "Fill this credential" }],
		available_expansions: [],
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function browser(): BrowserRuntime {
	return {
		observe: async () => observation,
		isFresh: async () => true,
		execute: async () => undefined,
		executeTarget: async () => undefined,
		prepareCredentialForm: async () => ({
			pageUrl: observation.url,
			fields: [{ field: form.fields[0]!, selector: '[data-test="0"]' }],
			cleanup: async () => undefined,
		}),
	};
}

function input(runtime = browser()) {
	return { goal: "Sign in", candidate, observation, history: [], browser: runtime };
}

describe("Kernel vault credential broker", () => {
	it("gives Jev the API item and fills the mapped visible form", async () => {
		const item = credential();
		let choiceItems: CredentialVaultItem[] = [];
		let fillRequest: unknown;
		const policy: VaultCredentialPolicy = {
			choose: async (request) => {
				choiceItems = request.items;
				return { choice: "item:0", confidence: 0.99 };
			},
			map: async () => [{ formFieldId: "credential:1", itemField: "email" }],
		};
		const client = {
			vaults: { items: {
				list: async () => [item],
				performOperation: async (_key: string, request: unknown) => {
					fillRequest = request;
					return { type: "fill", status: "completed", fields: [{ index: 0, status: "filled" }] };
				},
			} },
		} as unknown as Kernel;
		const broker = new KernelVaultCredentialBroker({ client, vault: "accounts", browserId: "browser", policy, onCollection: async () => assert.fail("collection not expected") });

		await broker.use(input());

		assert.deepEqual(choiceItems, [item]);
		assert.deepEqual(fillRequest, {
			id_or_name: "accounts",
			type: "fill",
			browser_id: "browser",
			page_url: "https://example.com/login",
			timeout_ms: 10_000,
			fields: [{ field: "email", selector: '[data-test="0"]' }],
		});
	});

	it("does not retry an unknown fill outcome", async () => {
		const item = credential();
		let attempts = 0;
		let cleaned = false;
		const client = {
			vaults: { items: {
				list: async () => [item],
				performOperation: async () => {
					attempts += 1;
					return { type: "fill", status: "unknown", fields: [{ index: 0, status: "unknown", error_code: "timeout" }] };
				},
			} },
		} as unknown as Kernel;
		const policy: VaultCredentialPolicy = {
			choose: async () => ({ choice: "item:0", confidence: 0.99 }),
			map: async () => [{ formFieldId: "credential:1", itemField: "email" }],
		};
		const runtime = browser();
		runtime.prepareCredentialForm = async () => ({
			pageUrl: observation.url,
			fields: [{ field: form.fields[0]!, selector: '[data-test="0"]' }],
			cleanup: async () => { cleaned = true; },
		});
		const broker = new KernelVaultCredentialBroker({ client, vault: "accounts", browserId: "browser", policy, onCollection: async () => assert.fail("collection not expected") });

		await assert.rejects(broker.use(input(runtime)), /unknown; not retrying/);
		assert.equal(attempts, 1);
		assert.equal(cleaned, true);
	});

	it("creates one item for the current form and pauses for collection", async () => {
		const pending = credential({
			key: "generated",
			state: { status: "pending_collection", fields: { email: { has_value: false } } },
			spec: { description: "example.com", fields: [{ name: "email", type: "email", required: true, sensitive: false }] },
			available_operations: [{ type: "collect", description: "Collect values" }],
		});
		const ready = credential({
			key: "generated",
			version: 2,
			state: { status: "ready", fields: { email: { has_value: true, value: "person@example.com" } } },
			spec: pending.spec,
		});
		let upsertRequest: unknown;
		let collected = false;
		let fillCount = 0;
		const client = {
			vaults: { items: {
				list: async () => [],
				upsert: async (_key: string, request: unknown) => {
					upsertRequest = request;
					return pending;
				},
				performOperation: async (_key: string, request: { type: string }) => {
					if (request.type === "collect") return { ...pending, action: { name: "collect", url: "https://vault.example/secret", expires_at: "2030-01-01T00:00:00Z" } };
					fillCount += 1;
					return { type: "fill", status: "completed", fields: [{ index: 0, status: "filled" }] };
				},
				retrieve: async () => ready,
			} },
		} as unknown as Kernel;
		const policy: VaultCredentialPolicy = {
			choose: async () => ({ choice: CREATE_NEW_CREDENTIAL, confidence: 0.98 }),
			map: async () => assert.fail("mapping not expected"),
		};
		const broker = new KernelVaultCredentialBroker({
			client,
			vault: "accounts",
			browserId: "browser",
			policy,
			now: () => Date.parse("2026-01-01T00:00:00Z"),
			onCollection: async () => { collected = true; },
		});

		await broker.use(input());

		assert.equal(collected, true);
		assert.equal(fillCount, 1);
		assert.deepEqual(upsertRequest, {
			id_or_name: "accounts",
			type: "credential",
			spec: {
				description: "example.com",
				fields: [{ name: "email", type: "email", required: true, sensitive: false }],
			},
		});
	});
});
