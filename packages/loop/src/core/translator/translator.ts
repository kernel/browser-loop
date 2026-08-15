import type Kernel from "@onkernel/sdk";
import type { BrowserCreateResponse, BrowserRetrieveResponse } from "@onkernel/sdk/resources/browsers";
import { isBrowserAction } from "../actions/index";
import type { LoopCoordinateContract } from "../tool-catalog";
import { normalizeGotoUrl } from "../url";
import type {
	ComputerUseAction,
	ComputerActionClick,
	ComputerActionDoubleClick,
	ComputerActionDrag,
	ComputerActionMouseDown,
	ComputerActionMouseUp,
	ComputerActionMove,
	ComputerActionScroll,
	ComputerActionTypeText,
	ComputerActionWait,
	ComputerActionZoom,
	BrowserAction,
	DragMouseButton,
	MouseButton,
} from "../actions/index";
import sharp from "sharp";
import { BrowserExecutor } from "./browser";
import { isKernelModifierKey, normalizeKernelKey, normalizeKernelKeyCombo } from "./keys";
import type { BatchExecutionResult } from "./types";

export type KernelBrowser = BrowserCreateResponse | BrowserRetrieveResponse;

export interface InternalComputerTranslatorOptions {
	browser: KernelBrowser;
	client: Kernel;
	/** Browser executor factory, overridable for tests. Defaults to a raw-CDP executor on the browser's cdp_ws_url. */
	createBrowserExecutor?: (cdpWsUrl: string) => BrowserExecutor;
}

export class BatchExecutionError extends Error {
	constructor(
		readonly result: BatchExecutionResult,
		readonly failedActionIndex: number,
		cause: unknown,
	) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "BatchExecutionError";
	}
}

export class InternalComputerTranslator {
	private readonly sessionId: string;
	private readonly client: Kernel;
	private readonly viewport: { width: number; height: number };
	private readonly cdpWsUrl?: string;
	private readonly browserExecutorFactory: (cdpWsUrl: string) => BrowserExecutor;
	private browserExecutor?: BrowserExecutor;

	constructor(opts: InternalComputerTranslatorOptions) {
		this.sessionId = opts.browser.session_id;
		this.client = opts.client;
		this.viewport = opts.browser.viewport ?? { width: 1920, height: 1080 };
		this.cdpWsUrl = opts.browser.cdp_ws_url;
		this.browserExecutorFactory = opts.createBrowserExecutor ?? ((cdpWsUrl) => new BrowserExecutor(cdpWsUrl));
	}

	/** Release held resources: closes the browser executor's CDP connection if one was opened. */
	dispose(): void {
		this.browserExecutor?.close();
		this.browserExecutor = undefined;
	}

	/** The browser-plane executor, connected lazily over the browser's CDP websocket. */
	browser(): BrowserExecutor {
		if (!this.browserExecutor) {
			if (!this.cdpWsUrl) throw new Error("browser has no cdp_ws_url; browser actions are unavailable");
			this.browserExecutor = this.browserExecutorFactory(this.cdpWsUrl);
		}
		return this.browserExecutor;
	}

	async screenshot(): Promise<{ data: Buffer; mimeType: string }> {
		const response = await this.client.browsers.computer.captureScreenshot(this.sessionId, {});
		return { data: Buffer.from(await response.arrayBuffer()), mimeType: "image/png" };
	}

	async currentUrl(): Promise<string> {
		await this.runKernelBatch([
			keypress(["Control", "l"]),
			keypress(["Control", "c"]),
		]);
		const response = await this.client.browsers.computer.readClipboard(this.sessionId);
		return (response.text ?? "").trim();
	}

	async currentMousePosition(): Promise<{ x: number; y: number }> {
		const pos = await this.client.browsers.computer.getMousePosition(this.sessionId);
		return { x: Math.trunc(pos.x), y: Math.trunc(pos.y) };
	}

	async executePlaywright(code: string, timeoutSec?: number): Promise<PlaywrightExecutionResult> {
		const truncated = timeoutSec !== undefined ? Math.trunc(timeoutSec) : undefined;
		const timeout = truncated !== undefined && truncated >= 1
			? Math.min(truncated, PLAYWRIGHT_MAX_TIMEOUT_SEC)
			: undefined;
		return this.client.browsers.playwright.execute(this.sessionId, {
			code,
			...(timeout !== undefined ? { timeout_sec: timeout } : {}),
		});
	}

	async executeBatch(
		actions: ComputerUseAction[],
		coordinateSystem: LoopCoordinateContract = { type: "pixel" },
		signal?: AbortSignal,
	): Promise<BatchExecutionResult> {
		const result: BatchExecutionResult = { readResults: [] };
		const pending: KernelBatchAction[] = [];
		let actionIndex = 0;

		const flush = async (): Promise<void> => {
			if (pending.length === 0) return;
			throwIfAborted(signal);
			await this.runKernelBatch(pending.splice(0));
		};

		try {
			for (let index = 0; index < actions.length; index += 1) {
				actionIndex = index;
				throwIfAborted(signal);
				const action = actions[index]!;
				if (isBrowserAction(action)) {
					await flush();
					const reads = await this.browser().execute(action, signal);
					result.readResults.push(...reads);
					// A worked plan can still end at a navigation/dialog boundary. Stop the
					// enclosing canonical batch so trailing actions cannot reuse old-page assumptions.
					const stopped = reads.some((read) =>
						read.type === "browser_wait_for"
							? read.result.status !== "satisfied"
							: read.type === "browser_act" && read.result.stop_reason !== undefined,
					);
					if (stopped) {
						result.stoppedActionIndex = index;
						const skippedActions = actions.length - index - 1;
						if (skippedActions > 0) result.skippedActions = skippedActions;
						break;
					}
					continue;
				}
				switch (action.type) {
					case "screenshot":
						await flush();
						result.readResults.push({ type: "screenshot", ...(await this.screenshot()) });
						break;
					case "zoom":
						await flush();
						result.readResults.push({ type: "screenshot", ...(await this.zoom(action, coordinateSystem)) });
						break;
					case "url":
						await flush();
						result.readResults.push({ type: "url", url: await this.currentUrl() });
						break;
					case "cursor_position":
						await flush();
						result.readResults.push({ type: "cursor_position", ...(await this.currentMousePosition()) });
						break;
					case "goto":
						pending.push(
							keypress(["Control", "l"]),
							{ type: "type_text", type_text: { text: normalizeGotoUrl(action.url) ?? "" } },
							keypress(["Enter"]),
						);
						break;
					case "back":
						pending.push(keypress(["Alt", "Left"]));
						break;
					case "forward":
						pending.push(keypress(["Alt", "Right"]));
						break;
					default:
						// Native computer mappings may omit click coordinates, meaning
						// "at the current cursor position" — resolve before batching.
						if (
							(action.type === "click" || action.type === "mouse_down" || action.type === "mouse_up") &&
							(action.x === undefined || action.y === undefined)
						) {
							await flush();
							const position = await this.currentMousePosition();
							pending.push(this.toSdkAction({ ...action, x: action.x ?? position.x, y: action.y ?? position.y }, coordinateSystem));
							break;
						}
						pending.push(this.toSdkAction(action, coordinateSystem));
						break;
				}
			}

			await flush();
			return result;
		} catch (cause) {
			const skippedActions = Math.max(0, actions.length - actionIndex - 1);
			if (skippedActions > 0) result.skippedActions = skippedActions;
			throw new BatchExecutionError(result, actionIndex, cause);
		}
	}

	/** Crop the OS screenshot to a region; coordinates stay in the full-screenshot frame. */
	async zoom(
		action: ComputerActionZoom,
		coordinateSystem: LoopCoordinateContract = { type: "pixel" },
	): Promise<{ data: Buffer; mimeType: string }> {
		const screenshot = await this.screenshot();
		const [rawX0, rawY0, rawX1, rawY1] = action.region;
		const start = this.toViewportPoint(rawX0, rawY0, coordinateSystem);
		const end = this.toViewportPoint(rawX1, rawY1, coordinateSystem);
		const left = Math.max(0, Math.trunc(Math.min(start.x, end.x)));
		const top = Math.max(0, Math.trunc(Math.min(start.y, end.y)));
		const width = Math.max(1, Math.trunc(Math.abs(end.x - start.x)));
		const height = Math.max(1, Math.trunc(Math.abs(end.y - start.y)));
		const data = await sharp(screenshot.data).extract({ left, top, width, height }).png().toBuffer();
		return { data, mimeType: "image/png" };
	}

	private toSdkAction(
		action: Exclude<ComputerUseAction, BrowserAction | { type: "screenshot" | "zoom" | "url" | "cursor_position" | "goto" | "back" | "forward" }>,
		coordinateSystem: LoopCoordinateContract,
	): KernelBatchAction {
		switch (action.type) {
			case "click":
				return this.clickAction(action, {
					button: mouseButton(action.button),
					...(action.num_clicks !== undefined && action.num_clicks > 1 ? { num_clicks: Math.trunc(action.num_clicks) } : {}),
				}, coordinateSystem);
			case "double_click":
				return this.clickAction(action, { num_clicks: 2 }, coordinateSystem);
			case "mouse_down":
				return this.clickAction(action, { button: mouseButton(action.button), click_type: "down" }, coordinateSystem);
			case "mouse_up":
				return this.clickAction(action, { button: mouseButton(action.button), click_type: "up" }, coordinateSystem);
			case "type":
				return typeText(action);
			case "keypress":
				return keypress(action.keys, action.duration);
			case "scroll":
				return this.scrollAction(action, coordinateSystem);
			case "move":
				return this.moveAction(action, coordinateSystem);
			case "drag":
				return this.dragAction(action, coordinateSystem);
			case "wait":
				return waitAction(action);
			default:
				return unreachable(action);
		}
	}

	private clickAction(
		action: ComputerActionClick | ComputerActionDoubleClick | ComputerActionMouseDown | ComputerActionMouseUp,
		extra: { button?: MouseButton; num_clicks?: number; click_type?: "down" | "up" },
		coordinateSystem: LoopCoordinateContract,
	): KernelBatchAction {
		const point = this.toViewportPoint(action.x ?? 0, action.y ?? 0, coordinateSystem);
		return {
			type: "click_mouse",
			click_mouse: {
				x: point.x,
				y: point.y,
				...extra,
				...holdKeys(action.hold_keys),
			},
		};
	}

	private scrollAction(action: ComputerActionScroll, coordinateSystem: LoopCoordinateContract): KernelBatchAction {
		const point = this.toViewportPoint(action.x ?? 0, action.y ?? 0, coordinateSystem);
		return {
			type: "scroll",
			scroll: {
				x: point.x,
				y: point.y,
				delta_x: Math.trunc(action.scroll_x ?? 0),
				delta_y: Math.trunc(action.scroll_y ?? 0),
				...holdKeys(action.hold_keys),
			},
		};
	}

	private moveAction(action: ComputerActionMove, coordinateSystem: LoopCoordinateContract): KernelBatchAction {
		const point = this.toViewportPoint(action.x, action.y, coordinateSystem);
		return { type: "move_mouse", move_mouse: { x: point.x, y: point.y } };
	}

	private dragAction(action: ComputerActionDrag, coordinateSystem: LoopCoordinateContract): KernelBatchAction {
		return {
			type: "drag_mouse",
			drag_mouse: {
				path: action.path.map((point) => {
					const transformed = this.toViewportPoint(point.x, point.y, coordinateSystem);
					return [transformed.x, transformed.y] as [number, number];
				}),
				button: dragButton(action.button),
				...holdKeys(action.hold_keys),
			},
		};
	}

	private toViewportPoint(
		x: number,
		y: number,
		coordinateSystem: LoopCoordinateContract,
	): { x: number; y: number } {
		if (coordinateSystem.type === "pixel") return { x: Math.trunc(x), y: Math.trunc(y) };
		const [min, max] = coordinateSystem.range;
		const scale = max - min;
		if (scale <= 0) return { x: Math.trunc(x), y: Math.trunc(y) };
		return {
			x: clamp(Math.round(((x - min) / scale) * this.viewport.width), 0, this.viewport.width - 1),
			y: clamp(Math.round(((y - min) / scale) * this.viewport.height), 0, this.viewport.height - 1),
		};
	}

	private async runKernelBatch(actions: KernelBatchAction[]): Promise<void> {
		await this.client.browsers.computer.batch(this.sessionId, { actions });
	}
}

type KernelBatchAction =
	Parameters<Kernel["browsers"]["computer"]["batch"]>[1]["actions"][number];

export type PlaywrightExecutionResult =
	Awaited<ReturnType<Kernel["browsers"]["playwright"]["execute"]>>;

const PLAYWRIGHT_MAX_TIMEOUT_SEC = 300;

const CLICK_BUTTONS: ReadonlySet<string> = new Set<MouseButton>(["left", "right", "middle", "back", "forward"]);
const DRAG_BUTTONS: ReadonlySet<string> = new Set<DragMouseButton>(["left", "right", "middle"]);

// The wire schemas keep button as an open string for provider compatibility;
// per the documented MouseButton contract, values outside the set coerce
// to "left".
function mouseButton(value: string | undefined): MouseButton {
	return value !== undefined && CLICK_BUTTONS.has(value) ? (value as MouseButton) : "left";
}

function dragButton(value: string | undefined): DragMouseButton {
	return value !== undefined && DRAG_BUTTONS.has(value) ? (value as DragMouseButton) : "left";
}

function typeText(action: ComputerActionTypeText): KernelBatchAction {
	return { type: "type_text", type_text: { text: action.text } };
}

function waitAction(action: ComputerActionWait): KernelBatchAction {
	return { type: "sleep", sleep: { duration_ms: Math.trunc(action.ms ?? 1000) } };
}

function holdKeys(keys: string[] | undefined): { hold_keys?: string[] } {
	if (!keys || keys.length === 0) return {};
	return { hold_keys: keys.map(normalizeKernelKey) };
}

function keypress(keys: string[], duration?: number): KernelBatchAction {
	const translated = keys.flatMap(normalizeKernelKeyCombo);
	const pressedKeys = translated.filter((key) => !isKernelModifierKey(key));
	const heldKeys = pressedKeys.length > 0 ? translated.filter(isKernelModifierKey) : translated.slice(0, -1);
	return {
		type: "press_key",
		press_key: {
			keys: pressedKeys.length > 0 ? pressedKeys : translated.slice(-1),
			...(heldKeys.length > 0 ? { hold_keys: heldKeys } : {}),
			...(typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? { duration: Math.trunc(duration) } : {}),
		},
	};
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error("computer action aborted");
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function unreachable(action: never): never {
	throw new Error(`unknown computer action type: ${JSON.stringify(action)}`);
}
