import { randomUUID } from "node:crypto";
import type Kernel from "@onkernel/sdk";
import type {
	CredentialCollectionAction,
	CredentialVaultFieldDefinition,
	CredentialVaultFieldInput,
	CredentialVaultItem,
	VaultItem,
} from "@onkernel/sdk/resources/vaults/items";
import { CredentialBlockedError } from "./types";
import type {
	CredentialBroker,
	CredentialField,
	CredentialForm,
	CredentialUseInput,
} from "./types";

export const CREATE_NEW_CREDENTIAL = "create_new";
export const NO_SAFE_CREDENTIAL_MATCH = "no_safe_match";

export interface CredentialItemChoice {
	choice: string;
	confidence: number;
}

export interface CredentialFieldMapping {
	formFieldId: string;
	itemField: string;
}

export interface VaultCredentialPolicy {
	choose(input: {
		goal: string;
		url: string;
		title: string;
		form: CredentialForm;
		items: CredentialVaultItem[];
	}): Promise<CredentialItemChoice>;
	map(input: {
		goal: string;
		url: string;
		title: string;
		form: CredentialForm;
		item: CredentialVaultItem;
	}): Promise<CredentialFieldMapping[]>;
}

export interface VaultCredentialBrokerOptions {
	client: Kernel;
	vault: string;
	browserId: string;
	policy: VaultCredentialPolicy;
	onCollection(action: CredentialCollectionAction): Promise<void>;
	now?: () => number;
}

export class KernelVaultCredentialBroker implements CredentialBroker {
	readonly #client: Kernel;
	readonly #vault: string;
	readonly #browserId: string;
	readonly #policy: VaultCredentialPolicy;
	readonly #onCollection: (action: CredentialCollectionAction) => Promise<void>;
	readonly #now: () => number;

	constructor(options: VaultCredentialBrokerOptions) {
		this.#client = options.client;
		this.#vault = options.vault;
		this.#browserId = options.browserId;
		this.#policy = options.policy;
		this.#onCollection = options.onCollection;
		this.#now = options.now ?? Date.now;
	}

	async use(input: CredentialUseInput): Promise<void> {
		const form = input.candidate.credentialForm;
		if (!form) throw new Error("Credential candidate has no form");
		const items = (await this.#client.vaults.items.list(this.#vault)).filter(isCredentialItem);
		const selected = await this.#policy.choose({
			goal: input.goal,
			url: input.observation.url,
			title: input.observation.title,
			form,
			items,
		});
		if (selected.choice === NO_SAFE_CREDENTIAL_MATCH) throw new CredentialBlockedError("No vault credential safely matches the visible form");

		let item: CredentialVaultItem;
		let mappings: CredentialFieldMapping[];
		if (selected.choice === CREATE_NEW_CREDENTIAL) {
			const created = await this.#create(form, input.observation.url);
			item = created.item;
			mappings = created.mappings;
		} else {
			const index = parseItemChoice(selected.choice);
			item = items[index] ?? fail(`Credential policy selected unavailable item ${selected.choice}`);
			mappings = await this.#policy.map({
				goal: input.goal,
				url: input.observation.url,
				title: input.observation.title,
				form,
				item,
			});
		}
		validateMappings(form, item, mappings);
		item = await this.#collectIfNeeded(item, mappings);
		if (!item.available_operations.some((operation) => operation.type === "fill")) {
			throw new CredentialBlockedError("Selected credential is not available for browser fill");
		}

		if (!input.browser.prepareCredentialForm) throw new Error("Browser runtime does not support vault credential forms");
		const prepared = await input.browser.prepareCredentialForm(input.observation, form);
		try {
			const selectors = new Map(prepared.fields.map(({ field, selector }) => [field.id, selector]));
			const result = await this.#client.vaults.items.performOperation(item.key, {
				id_or_name: this.#vault,
				type: "fill",
				browser_id: this.#browserId,
				page_url: prepared.pageUrl,
				timeout_ms: 10_000,
				fields: mappings.map((mapping) => ({
					field: mapping.itemField,
					selector: selectors.get(mapping.formFieldId) ?? fail(`Credential target ${mapping.formFieldId} disappeared`),
				})),
			});
			if (result.type !== "fill" || result.status !== "completed") {
				throw new Error(`Vault fill outcome is ${result.type === "fill" ? result.status : "unknown"}; not retrying`);
			}
		} finally {
			await prepared.cleanup();
		}
	}

	async #create(form: CredentialForm, pageUrl: string): Promise<{ item: CredentialVaultItem; mappings: CredentialFieldMapping[] }> {
		if (form.fields.some((field) => field.semantic === "otp")) {
			throw new CredentialBlockedError("A TOTP seed cannot be collected from the hosted credential form");
		}
		const fields = credentialFieldInputs(form.fields);
		const key = `jev-${randomUUID()}`;
		const created = await this.#client.vaults.items.upsert(key, {
			id_or_name: this.#vault,
			type: "credential",
			spec: {
				description: new URL(pageUrl).hostname,
				fields: fields.map(({ input }) => input),
			},
		});
		if (!isCredentialItem(created)) throw new Error("Vault created a non-credential item");
		return {
			item: created,
			mappings: fields.map(({ formField, input }) => ({ formFieldId: formField.id, itemField: input.name })),
		};
	}

	async #collectIfNeeded(item: CredentialVaultItem, mappings: CredentialFieldMapping[]): Promise<CredentialVaultItem> {
		const missing = mappings.some((mapping) => item.state.fields[mapping.itemField]?.has_value !== true);
		if (item.state.status === "ready" && !missing) return item;
		let observedVersion = item.version;
		const collected = await this.#client.vaults.items.performOperation(item.key, {
			id_or_name: this.#vault,
			type: "collect",
		});
		if (!isCredentialResponse(collected) || collected.action?.name !== "collect") {
			throw new Error("Vault did not return a credential collection action");
		}
		await this.#onCollection(collected.action);
		const expiresAt = Date.parse(collected.action.expires_at);
		if (!Number.isFinite(expiresAt)) throw new Error("Vault returned an invalid credential collection expiry");
		for (;;) {
			if (this.#now() >= expiresAt) throw new CredentialBlockedError("Credential collection expired");
			const current = await this.#client.vaults.items.retrieve(item.key, {
				id_or_name: this.#vault,
				...(collected.state.status === "pending_collection" ? { wait: 30 } : {}),
			}, { timeout: 45_000 });
			if (!isCredentialItem(current)) throw new Error("Vault returned a non-credential item");
			const fieldsReady = mappings.every((mapping) => current.state.fields[mapping.itemField]?.has_value === true);
			if (current.version > observedVersion) {
				observedVersion = current.version;
				if (current.state.status === "ready" && fieldsReady) return current;
				if (current.state.status === "ready") throw new CredentialBlockedError("Credential collection completed without every mapped field");
			}
			await delay(1_000);
		}
	}
}

function credentialFieldInputs(fields: CredentialField[]): Array<{ formField: CredentialField; input: CredentialVaultFieldInput }> {
	const counts = new Map<string, number>();
	return fields.map((field) => {
		const base = credentialFieldName(field);
		const count = (counts.get(base) ?? 0) + 1;
		counts.set(base, count);
		const name = count === 1 ? base : `${base}_${count}`;
		return {
			formField: field,
			input: {
				name,
				type: field.semantic === "password" ? "password" : field.semantic === "identifier" && field.type === "email" ? "email" : "text",
				required: true,
				sensitive: field.sensitive,
			},
		};
	});
}

function credentialFieldName(field: CredentialField): string {
	if (field.semantic === "password") return "password";
	if (field.semantic === "otp") return "totp";
	if (field.semantic === "identifier") {
		if (field.type === "email" || /e-?mail/i.test(field.name)) return "email";
		if (/user(?:name| name)/i.test(field.name)) return "username";
		if (/phone|mobile|tel/i.test(field.name)) return "phone";
		return "identifier";
	}
	const slug = field.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return /^[a-z][a-z0-9_]{0,63}$/.test(slug) ? slug : "text";
}

export function compatibleCredentialField(formField: CredentialField, itemField: CredentialVaultFieldDefinition): boolean {
	if (formField.sensitive !== itemField.sensitive) return false;
	if (formField.semantic === "password") return itemField.type === "password";
	if (formField.semantic === "otp") return itemField.type === "totp";
	if (formField.semantic === "identifier") return itemField.type === "text" || itemField.type === "email";
	return itemField.type === "text" || itemField.type === "email";
}

function validateMappings(form: CredentialForm, item: CredentialVaultItem, mappings: CredentialFieldMapping[]): void {
	if (!mappings.length) throw new CredentialBlockedError("Credential policy did not map any fields");
	const formFields = new Set(form.fields.map((field) => field.id));
	const itemFields = new Map(item.spec.fields.map((field) => [field.name, field]));
	const seenForm = new Set<string>();
	const seenItem = new Set<string>();
	for (const mapping of mappings) {
		const formField = form.fields.find((field) => field.id === mapping.formFieldId);
		const itemField = itemFields.get(mapping.itemField);
		if (!formFields.has(mapping.formFieldId) || !formField || !itemField) throw new CredentialBlockedError("Credential policy returned an unavailable field mapping");
		if (!compatibleCredentialField(formField, itemField)) throw new CredentialBlockedError("Credential policy returned an incompatible field mapping");
		if (seenForm.has(mapping.formFieldId) || seenItem.has(mapping.itemField)) throw new CredentialBlockedError("Credential policy returned duplicate field mappings");
		seenForm.add(mapping.formFieldId);
		seenItem.add(mapping.itemField);
	}
	if (seenForm.size !== form.fields.length) throw new CredentialBlockedError("Credential policy did not map every visible form field");
}

function parseItemChoice(choice: string): number {
	const match = /^item:(\d+)$/.exec(choice);
	if (!match) throw new Error(`Credential policy returned unsupported choice ${choice}`);
	return Number(match[1]);
}

function isCredentialItem(item: VaultItem): item is CredentialVaultItem {
	return item.type === "credential";
}

function isCredentialResponse(item: Awaited<ReturnType<Kernel["vaults"]["items"]["performOperation"]>>): item is CredentialVaultItem {
	return item.type === "credential";
}

function fail(message: string): never {
	throw new Error(message);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
