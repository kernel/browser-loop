import { createHash } from "node:crypto";
import type { BrowserAction } from "../../src/core/actions/browser";
import type { BrowserExecutor } from "../../src/core/translator/browser";
import { IncompleteObservationError, ObservationChangedError } from "../../src/core/translator/browser-observation";
import type { BatchReadResult } from "../../src/core/translator/types";
import { selectOptionCode, SETTLE_AFTER_INPUT, targetFreshnessCode, targetPointCode, VIEWPORT_SNAPSHOT } from "./snapshot";
import type { BrowserRuntime, JevCandidate, Observation, ObservationElement, ScrollState } from "./types";

const OBSERVATION_RETRY_DELAYS_MS = [100, 200, 400, 800, 1_600];

interface SnapshotPayload {
	url: string;
	title: string;
	documentId: string;
	text: string;
	elements: ObservationElement[];
	scroll: ScrollState;
	marker: string;
	omitted: number;
}

export class ExecutorBrowserRuntime implements BrowserRuntime {
	readonly #executor: BrowserExecutor;
	#settlePending = false;

	constructor(executor: BrowserExecutor) {
		this.#executor = executor;
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
		if (candidate.target) {
			return this.#evaluateBoolean(targetFreshnessCode(candidate.target));
		}
		if (candidate.kind === "terminal") {
			const payload = await this.#snapshot();
			return payload.marker === observation.marker;
		}
		return this.#evaluateBoolean(`String(performance.timeOrigin) === ${JSON.stringify(observation.documentId)} && location.href === ${JSON.stringify(observation.url)}`);
	}

	async execute(action: BrowserAction): Promise<void> {
		const reads = await this.#executor.execute(action);
		if (action.type === "browser_scroll") this.#settlePending = true;
		const act = reads.find((read): read is Extract<BatchReadResult, { type: "browser_act" }> => read.type === "browser_act");
		if (act?.result.stop_reason && ["action_failed", "stale_ref", "step_timeout", "global_timeout"].includes(act.result.stop_reason)) {
			throw new Error(`browser_act stopped: ${act.result.stop_reason}`);
		}
	}

	async executeTarget(candidate: JevCandidate, value?: string): Promise<void> {
		const target = candidate.target;
		if (!target) throw new Error(`Candidate ${candidate.id} has no browser target`);
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
				return payload;
			} catch (error) {
				const delayMs = OBSERVATION_RETRY_DELAYS_MS[attempt];
				if (!isRetryableObservationError(error) || delayMs === undefined) throw error;
				await delay(delayMs);
			}
		}
	}

	async #evaluate(code: string): Promise<string> {
		return readText(await this.#executor.execute({ type: "browser_evaluate", code }), "evaluate");
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
			element.value ? `value=${JSON.stringify(element.value)}` : undefined,
			element.checked === undefined ? undefined : `checked=${element.checked}`,
			element.selected === undefined ? undefined : `selected=${element.selected}`,
			element.expanded === undefined ? undefined : `expanded=${element.expanded}`,
		].filter(Boolean).join(", ");
		return `${element.role} ${JSON.stringify(element.name)} [${element.id}]${state ? ` [${state}]` : ""}`;
	}).join("\n");
	return {
		url: payload.url,
		title: payload.title,
		documentId: payload.documentId,
		text: payload.text.slice(0, 6_000),
		snapshot,
		elements,
		scroll,
		marker: payload.marker,
		fingerprint: createHash("sha256").update(payload.marker).digest("hex"),
		omittedElements: Math.max(0, finite(payload.omitted)),
	};
}

export function observationFromElements(input: {
	url: string;
	title?: string;
	text?: string;
	documentId?: string;
	elements?: ObservationElement[];
	scroll?: Partial<ScrollState>;
	marker?: string;
}): Observation {
	const payload: SnapshotPayload = {
		url: input.url,
		title: input.title ?? "",
		documentId: input.documentId ?? "test-document",
		text: input.text ?? "",
		elements: input.elements ?? [],
		scroll: normalizedScroll(input.scroll),
		marker: input.marker ?? JSON.stringify([input.url, input.title ?? "", input.text ?? "", input.elements ?? [], normalizedScroll(input.scroll)]),
		omitted: 0,
	};
	return observationFromPayload(payload);
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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
