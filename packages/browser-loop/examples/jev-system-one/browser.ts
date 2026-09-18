import { createHash, randomUUID } from "node:crypto";
import type { BrowserAction } from "../../src/core/actions/browser";
import type { BrowserExecutor } from "../../src/core/translator/browser";
import { IncompleteObservationError, ObservationChangedError } from "../../src/core/translator/browser-observation";
import type { BatchReadResult } from "../../src/core/translator/types";
import { elementsFromAccessibilitySnapshot } from "./accessibility";
import { cleanupCredentialFormCode, CREDENTIAL_FORM_SNAPSHOT, mergeCredentialForms, prepareCredentialFormCode } from "./credentials";
import { MARK_VISIBLE_FRAMES, RESTORE_FRAME_LABELS, selectOptionCode, SETTLE_AFTER_INPUT, targetFreshnessCode, targetPointCode, VIEWPORT_SNAPSHOT } from "./snapshot";
import type { BrowserRuntime, CredentialForm, JevCandidate, Observation, ObservationElement, PreparedCredentialForm, ScrollState } from "./types";

const OBSERVATION_RETRY_DELAYS_MS = [100, 200, 400, 800, 1_600];
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
const UNCHANGED_SNAPSHOT = "Page unchanged since the last snapshot; previous element refs are still valid.";

interface SnapshotPayload {
	url: string;
	title: string;
	documentId: string;
	text: string;
	elements: ObservationElement[];
	scroll: ScrollState;
	marker: string;
	omitted: number;
	credentialForms: CredentialForm[];
	hasVisibleFrame?: boolean;
}


export class ExecutorBrowserRuntime implements BrowserRuntime {
	readonly #executor: BrowserExecutor;
	readonly #actionTimeoutMs: number;
	#lastAccessibilitySnapshot?: string;
	#settlePending = false;

	constructor(executor: BrowserExecutor, options: { actionTimeoutMs?: number } = {}) {
		this.#executor = executor;
		this.#actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
	}

	async observe(): Promise<Observation> {
		if (this.#settlePending) {
			this.#settlePending = false;
			await this.#evaluate(SETTLE_AFTER_INPUT).catch(() => undefined);
		}
		const payload = await this.#snapshot();
		return observationFromPayload(payload);
	}

	async isFresh(observation: Observation, candidate: JevCandidate): Promise<boolean> {
		try {
			if (candidate.target?.ref) {
				return await this.#evaluateBoolean(`String(performance.timeOrigin) === ${JSON.stringify(observation.documentId)} && location.href === ${JSON.stringify(observation.url)}`);
			}
			if (candidate.target) return await this.#evaluateBoolean(targetFreshnessCode(candidate.target));
			if (candidate.kind === "terminal") return (await this.#snapshot()).marker === observation.marker;
			return await this.#evaluateBoolean(`String(performance.timeOrigin) === ${JSON.stringify(observation.documentId)} && location.href === ${JSON.stringify(observation.url)}`);
		} catch (error) {
			if (isRetryableObservationError(error)) return false;
			throw error;
		}
	}

	async execute(action: BrowserAction): Promise<void> {
		const reads = action.type === "browser_act" || action.type === "browser_navigate"
			? await this.#executor.execute(action)
			: await executeWithDeadline(this.#executor, action, this.#actionTimeoutMs);
		if (action.type === "browser_navigate") this.#lastAccessibilitySnapshot = undefined;
		if (action.type === "browser_scroll") this.#settlePending = true;
		const act = reads.find((read): read is Extract<BatchReadResult, { type: "browser_act" }> => read.type === "browser_act");
		if (act?.result.stop_reason && ["action_failed", "stale_ref", "step_timeout", "global_timeout"].includes(act.result.stop_reason)) {
			throw new Error(`browser_act stopped: ${act.result.stop_reason}`);
		}
	}

	async prepareCredentialForm(observation: Observation, form: CredentialForm): Promise<PreparedCredentialForm> {
		const attribute = `data-jev-vault-${randomUUID().replaceAll("-", "")}`;
		const prepared = JSON.parse(await this.#evaluate(prepareCredentialFormCode(observation.documentId, form, attribute))) as {
			pageUrl: string;
			selectors: string[];
		} | null;
		if (!prepared || prepared.pageUrl !== observation.url || prepared.selectors.length !== form.fields.length) {
			throw new Error("Credential target changed before fill");
		}
		return {
			pageUrl: prepared.pageUrl,
			fields: form.fields.map((field, index) => ({ field, selector: prepared.selectors[index]! })),
			cleanup: async () => {
				await this.#evaluate(cleanupCredentialFormCode(observation.documentId, attribute)).catch(() => undefined);
				this.#settlePending = true;
			},
		};
	}

	async executeTarget(candidate: JevCandidate, value?: string): Promise<void> {
		const target = candidate.target;
		if (!target) throw new Error(`Candidate ${candidate.id} has no browser target`);
		if (target.ref) {
			if (candidate.operation === "CLICK") await this.execute({ type: "browser_click", ref: target.ref });
			else {
				const targetValue = candidate.operation === "SELECT" ? candidate.value : value;
				if (targetValue === undefined) throw new Error(`Candidate ${candidate.id} has no input value`);
				await this.execute({ type: "browser_fill", ref: target.ref, value: targetValue });
			}
			this.#settlePending = true;
			return;
		}
		if (candidate.operation === "SELECT") {
			if (candidate.value === undefined) throw new Error(`Candidate ${candidate.id} has no option value`);
			const selected = await this.#evaluateBoolean(selectOptionCode({ ...target, value: candidate.value }));
			if (!selected) throw new Error("Browser target changed before selection");
			this.#settlePending = true;
			return;
		}
		const point = await this.#evaluatePoint(targetPointCode(target));
		if (!point) throw new Error("Browser target changed before input");
		await this.execute({ type: "browser_click", x: point.x, y: point.y });
		if (candidate.operation === "TYPE_TEXT") {
			if (value === undefined) throw new Error(`Candidate ${candidate.id} has no text value`);
			await this.execute({ type: "browser_key", text: "CTRL+A" });
			await this.execute({ type: "browser_type", text: value });
		}
		this.#settlePending = true;
	}

	async #snapshot(): Promise<SnapshotPayload> {
		for (let attempt = 0; ; attempt += 1) {
			try {
				const value = await this.#evaluate(VIEWPORT_SNAPSHOT);
				const payload = JSON.parse(value) as SnapshotPayload | null;
				if (!payload) throw new ObservationChangedError("Browser document was unavailable during observation");
				const credentialSnapshot = JSON.parse(await this.#evaluate(CREDENTIAL_FORM_SNAPSHOT)) as unknown;
				const credentialForms = Array.isArray(credentialSnapshot) ? credentialSnapshot as Parameters<typeof mergeCredentialForms>[1] : [];
				payload.credentialForms = mergeCredentialForms(payload.elements, credentialForms, payload.documentId);
				if (payload.hasVisibleFrame) await this.#addAccessibilityElements(payload);
				payload.marker = safeMarker(payload);
				return payload;
			} catch (error) {
				const delayMs = OBSERVATION_RETRY_DELAYS_MS[attempt];
				if (!isRetryableObservationError(error) || delayMs === undefined) throw error;
				await delay(delayMs);
			}
		}
	}

	async #addAccessibilityElements(payload: SnapshotPayload): Promise<void> {
		const frameLabels = JSON.parse(await this.#evaluate(MARK_VISIBLE_FRAMES)) as string[];
		try {
			const reads = await executeWithDeadline(
				this.#executor,
				{ type: "browser_snapshot", filter: "all", depth: Number.MAX_SAFE_INTEGER },
				this.#actionTimeoutMs,
			);
			const rendered = readText(reads, "snapshot");
			let snapshot = rendered;
			if (rendered === UNCHANGED_SNAPSHOT) {
				if (!this.#lastAccessibilitySnapshot) throw new ObservationChangedError("Browser returned an unchanged accessibility snapshot without a baseline");
				snapshot = this.#lastAccessibilitySnapshot;
			}
			this.#lastAccessibilitySnapshot = snapshot;
			const additions = elementsFromAccessibilitySnapshot(snapshot, frameLabels);
			payload.elements.push(...additions);
			const semantics = additions.map(({ id, node, guard, ref, rect, ...element }) => element);
			payload.marker = JSON.stringify([payload.marker, semantics]);
		} finally {
			await this.#evaluate(RESTORE_FRAME_LABELS).catch(() => undefined);
		}
	}

	async #evaluate(code: string): Promise<string> {
		return readText(
			await executeWithDeadline(this.#executor, { type: "browser_evaluate", code }, this.#actionTimeoutMs),
			"evaluate",
		);
	}

	async #evaluateBoolean(code: string): Promise<boolean> {
		return JSON.parse(await this.#evaluate(code)) === true;
	}

	async #evaluatePoint(code: string): Promise<{ x: number; y: number } | undefined> {
		const point = JSON.parse(await this.#evaluate(code)) as { x?: unknown; y?: unknown } | null;
		if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
		return { x: point.x as number, y: point.y as number };
	}
}

export function observationFromPayload(payload: SnapshotPayload): Observation {
	const elements = payload.elements.slice(0, 250).map((element) => ({
		...element,
		operations: [...element.operations],
		options: [...element.options],
	}));
	const scroll = normalizedScroll(payload.scroll);
	const snapshot = elements.map((element) => {
		const state = [
			element.credentialSemantic ? `credential=${element.credentialSemantic}` : undefined,
			element.hasValue === undefined ? (element.value ? `value=${JSON.stringify(element.value)}` : undefined) : `has_value=${element.hasValue}`,
			element.checked === undefined ? undefined : `checked=${element.checked}`,
			element.selected === undefined ? undefined : `selected=${element.selected}`,
			element.expanded === undefined ? undefined : `expanded=${element.expanded}`,
		].filter(Boolean).join(", ");
		return `${element.role} ${JSON.stringify(element.name)} [${element.id}]${state ? ` [${state}]` : ""}`;
	}).join("\n");
	const interactionState = elements.map((element) => ({
		role: element.role,
		name: element.name,
		...(element.hasValue === undefined ? { value: element.value } : { hasValue: element.hasValue }),
		credentialSemantic: element.credentialSemantic,
		sensitive: element.sensitive,
		operations: element.operations,
		options: element.options,
		checked: element.checked,
		selected: element.selected,
		expanded: element.expanded,
		disabled: element.disabled,
	}));
	return {
		url: payload.url,
		title: payload.title,
		documentId: payload.documentId,
		text: payload.text.slice(0, 6_000),
		snapshot,
		elements,
		credentialForms: payload.credentialForms,
		scroll,
		marker: payload.marker,
		fingerprint: createHash("sha256").update(payload.marker).digest("hex"),
		interactionFingerprint: createHash("sha256").update(JSON.stringify({ url: payload.url, elements: interactionState, scroll })).digest("hex"),
		omittedElements: Math.max(0, finite(payload.omitted)) + Math.max(0, payload.elements.length - elements.length),
	};
}

export function observationFromElements(input: {
	url: string;
	title?: string;
	text?: string;
	documentId?: string;
	elements?: ObservationElement[];
	credentialForms?: CredentialForm[];
	scroll?: Partial<ScrollState>;
	marker?: string;
}): Observation {
	const payload: SnapshotPayload = {
		url: input.url,
		title: input.title ?? "",
		documentId: input.documentId ?? "test-document",
		text: input.text ?? "",
		elements: input.elements ?? [],
		credentialForms: input.credentialForms ?? [],
		scroll: normalizedScroll(input.scroll),
		marker: input.marker ?? JSON.stringify([input.url, input.title ?? "", input.text ?? "", input.elements ?? [], normalizedScroll(input.scroll)]),
		omitted: 0,
	};
	return observationFromPayload(payload);
}

function safeMarker(payload: SnapshotPayload): string {
	const elements = payload.elements.map(({ rect, guard, ref, ...element }) => ({
		...element,
		...(element.hasValue === undefined ? {} : { value: "" }),
	}));
	const forms = payload.credentialForms.map((form) => ({
		id: form.id,
		name: form.name,
		fields: form.fields.map(({ target, ...field }) => field),
	}));
	return JSON.stringify([payload.documentId, payload.url, payload.title, payload.text, elements, forms, payload.scroll]);
}

function normalizedScroll(scroll: Partial<ScrollState> | undefined): ScrollState {
	return {
		y: finite(scroll?.y),
		height: finite(scroll?.height),
		viewport: finite(scroll?.viewport),
		width: finite(scroll?.width),
		x: finite(scroll?.x),
		pointY: finite(scroll?.pointY),
	};
}

function isRetryableObservationError(error: unknown): boolean {
	return error instanceof ObservationChangedError
		|| error instanceof IncompleteObservationError
		|| /context|document changed|navigat|unavailable/i.test(errorMessage(error));
}

function readText(reads: readonly BatchReadResult[], label: string): string {
	const result = reads.find((read): read is Extract<BatchReadResult, { type: "browser_text" }> => read.type === "browser_text" && read.label === label);
	if (!result) throw new Error(`Browser action did not return ${label} text`);
	return result.text;
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function executeWithDeadline(executor: BrowserExecutor, action: BrowserAction, timeoutMs: number): Promise<BatchReadResult[]> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const error = new Error(`Browser action ${action.type} timed out after ${timeoutMs}ms; execution outcome is unknown`);
			controller.abort(error);
			reject(error);
			executor.close();
		}, timeoutMs);
	});
	const execution = executor.execute(action, controller.signal);
	void execution.catch(() => undefined);
	try {
		return await Promise.race([execution, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
