import type { CredentialForm, CredentialSemantic, ObservationElement } from "./types";

interface CredentialSnapshotField {
	id: string;
	node: number;
	name: string;
	semantic: CredentialSemantic;
	type: string;
	autocomplete: string;
	sensitive: boolean;
	hasValue: boolean;
	guard: string;
}

interface CredentialSnapshotForm {
	id: string;
	name: string;
	fields: CredentialSnapshotField[];
}

export const CREDENTIAL_FORM_SNAPSHOT = String.raw`(() => {
	const state = window.__jevLoopSnapshot;
	if (!state || !document.body) return [];
	state.redacted ||= new WeakSet();
	const controls = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')]
		.filter((element) => {
			if (['hidden', 'submit', 'button', 'reset', 'file', 'checkbox', 'radio'].includes(element.type)) return false;
			return state.visible(element) && !element.matches(':disabled') && !element.closest('[aria-disabled="true"]') && state.actionPoint(element) !== null;
		});
	const text = (element) => (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
	const nameOf = (element) => {
		const root = element.getRootNode();
		const labelled = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
			.map((id) => text(root.getElementById?.(id) || document.getElementById(id))).filter(Boolean).join(' ');
		return element.getAttribute('aria-label') || labelled || [...(element.labels || [])].map(text).filter(Boolean).join(' ')
			|| element.getAttribute('placeholder') || element.getAttribute('name') || element.id || 'credential field';
	};
	const semanticOf = (element) => {
		const autocomplete = (element.autocomplete || '').toLowerCase().split(/\s+/);
		const haystack = [nameOf(element), element.name, element.id, element.placeholder].filter(Boolean).join(' ').toLowerCase();
		if (autocomplete.includes('one-time-code') || /\b(?:otp|one[ -]?time|verification|authenticator)\s*(?:code|passcode)?\b/.test(haystack)) return 'otp';
		if (element.type === 'password' || autocomplete.includes('current-password') || autocomplete.includes('new-password') || /password|passphrase|passcode/.test(haystack)) return 'password';
		if (element.type === 'email' || autocomplete.some((token) => ['username', 'email', 'tel'].includes(token)) || /\b(?:email|e-mail|username|user name|identifier|login|account|phone)\b/.test(haystack)) return 'identifier';
		return 'text';
	};
	const actionLabel = (element) => (text(element) || element.value || element.getAttribute('aria-label') || '').toLowerCase();
	const primaryAction = (root) => [...root.querySelectorAll('button,[role="button"],input[type="submit"]')]
		.filter((element) => state.visible(element) && state.actionPoint(element) !== null)
		.some((element) => /\b(?:sign in|log in|login|continue|next|verify|submit|send code)\b/.test(actionLabel(element)) && !/\b(?:show|hide|forgot|trouble)\b/.test(actionLabel(element)));
	const groupRoot = (element) => {
		if (element.form) return element.form;
		let current = element.parentElement;
		const fallback = element.closest('[role="dialog"],main');
		for (let depth = 0; current && current !== document.body && depth < 10; depth++, current = current.parentElement) {
			const count = controls.filter((candidate) => current.contains(candidate)).length;
			if (count <= 8 && primaryAction(current)) return current;
		}
		if (fallback && controls.filter((candidate) => fallback.contains(candidate)).length <= 8) return fallback;
		return null;
	};
	const candidates = [];
	for (const control of controls) {
		const semantic = semanticOf(control);
		if (semantic === 'text') continue;
		const root = groupRoot(control);
		if (root && !candidates.includes(root)) candidates.push(root);
	}
	const seen = new Set();
	const forms = [];
	for (const root of candidates) {
		const members = controls.filter((element) => root.contains(element));
		const classified = members.map((element) => ({ element, semantic: semanticOf(element) }));
		const semanticCount = classified.filter(({ semantic }) => semantic !== 'text').length;
		const hasPasswordOrOtp = classified.some(({ semantic }) => semantic === 'password' || semantic === 'otp');
		const authTitle = /\b(?:sign in|log in|login|authenticate|verify)\b/i.test(document.title);
		const authUrl = /(?:^|[\/#?._-])(?:login|signin|sign-in|auth)(?:[\/#?._=&-]|$)/i.test(location.href);
		const authAction = [...root.querySelectorAll('button,[role="button"],input[type="submit"]')]
			.filter((element) => state.visible(element) && state.actionPoint(element) !== null)
			.some((element) => /\b(?:sign in|log in|login|verify|send code)\b/.test(actionLabel(element)));
		const usernameAutocomplete = classified.some(({ element }) => (element.autocomplete || '').toLowerCase().split(/\s+/).includes('username'));
		if (!hasPasswordOrOtp && !(semanticCount > 0 && (authTitle || authUrl || authAction || usernameAutocomplete))) continue;
		const nodes = classified.map(({ element }) => {
			if (!state.ids.has(element)) state.ids.set(element, state.next++);
			const node = state.ids.get(element);
			state.nodes.set(node, element);
			return node;
		});
		const identity = [...nodes].sort((left, right) => left - right).join(':');
		if (seen.has(identity)) continue;
		seen.add(identity);
		const heading = [...root.querySelectorAll('h1,h2,h3,[role="heading"]')].find((element) => state.visible(element));
		const formName = root.getAttribute('aria-label') || text(heading) || document.title || 'credential form';
		const fields = classified.map(({ element, semantic }, index) => {
			state.redacted.add(element);
			const node = nodes[index];
			const autocomplete = (element.autocomplete || '').toLowerCase();
			return {
				id: 'credential:' + node,
				node,
				name: nameOf(element),
				semantic,
				type: element.type || 'text',
				autocomplete,
				sensitive: semantic === 'password' || semantic === 'otp',
				hasValue: String(element.value ?? element.innerText ?? '').length > 0,
				guard: state.guard(element),
			};
		});
		forms.push({ id: 'form:' + identity, name: formName, fields });
	}
	return forms.filter((form, index) => !forms.some((other, otherIndex) =>
		index !== otherIndex && form.fields.length < other.fields.length
		&& form.fields.every((field) => other.fields.some((otherField) => otherField.node === field.node))
	));
})()`;

export function prepareCredentialFormCode(documentId: string, form: CredentialForm, attribute: string): string {
	const fields = form.fields.map((field, index) => ({ node: field.target.node, guard: field.target.guard, value: String(index) }));
	return `(() => {
		const state = window.__jevLoopSnapshot;
		if (!state || String(performance.timeOrigin) !== ${JSON.stringify(documentId)}) return null;
		const fields = ${JSON.stringify(fields)};
		const elements = fields.map((field) => state.nodes.get(field.node));
		if (elements.some((element, index) => !element?.isConnected || state.guard(element) !== fields[index].guard || state.actionPoint(element) === null)) return null;
		for (let index = 0; index < elements.length; index++) {
			state.redacted.add(elements[index]);
			elements[index].setAttribute(${JSON.stringify(attribute)}, fields[index].value);
		}
		return { pageUrl: location.href, selectors: fields.map((field) => '[' + ${JSON.stringify(attribute)} + '=\"' + field.value + '\"]') };
	})()`;
}

export function cleanupCredentialFormCode(documentId: string, attribute: string): string {
	return `(() => {
		if (String(performance.timeOrigin) !== ${JSON.stringify(documentId)}) return true;
		for (const element of document.querySelectorAll('[' + ${JSON.stringify(attribute)} + ']')) element.removeAttribute(${JSON.stringify(attribute)});
		return true;
	})()`;
}

export function mergeCredentialForms(elements: ObservationElement[], forms: CredentialSnapshotForm[], documentId: string): CredentialForm[] {
	const byNode = new Map(elements.map((element) => [element.node, element]));
	return forms.map((form) => ({
		id: form.id,
		name: form.name,
		fields: form.fields.map((field) => {
			const existing = byNode.get(field.node);
			if (existing) {
				existing.value = "";
				existing.hasValue = field.hasValue;
				existing.credentialSemantic = field.semantic;
				existing.sensitive = field.sensitive;
				existing.guard = field.guard;
				if (field.sensitive) existing.operations = existing.operations.filter((operation) => operation !== "TYPE_TEXT");
			} else {
				elements.push({
					id: `n${field.node}`,
					node: field.node,
					role: "textbox",
					name: field.name,
					value: "",
					hasValue: field.hasValue,
					credentialSemantic: field.semantic,
					sensitive: field.sensitive,
					operations: [],
					options: [],
					guard: field.guard,
					rect: { x: 0, y: 0, width: 0, height: 0 },
				});
			}
			return {
				id: field.id,
				name: field.name,
				semantic: field.semantic,
				type: field.type,
				autocomplete: field.autocomplete,
				sensitive: field.sensitive,
				hasValue: field.hasValue,
				target: { documentId, node: field.node, guard: field.guard },
			};
		}),
	}));
}
