import type Kernel from "@onkernel/sdk";
import type { BrowserCreateResponse, BrowserRetrieveResponse } from "@onkernel/sdk/resources/browsers";
import {
	isCuaBrowserAction,
	normalizeGotoUrl,
	type ComputerToolCoordinateSystem,
	type CuaAction,
	type CuaActionClick,
	type CuaActionDoubleClick,
	type CuaActionDrag,
	type CuaActionMouseDown,
	type CuaActionMouseUp,
	type CuaActionMove,
	type CuaActionScroll,
	type CuaActionTypeText,
	type CuaActionWait,
	type CuaActionZoom,
	type CuaBrowserAction,
	type CuaDragMouseButton,
	type CuaMode,
	type CuaMouseButton,
	type CuaScreenshotSpec,
} from "@onkernel/cua-ai";
import sharp from "sharp";
import { BrowserExecutor, type BrowserExecutorOptions } from "./browser";
import { isKernelModifierKey, normalizeKernelKey, normalizeKernelKeyCombo } from "./keys";
import type { BatchExecutionResult } from "./types";

export type KernelBrowser = BrowserCreateResponse | BrowserRetrieveResponse;

export interface InternalComputerTranslatorOptions {
	browser: KernelBrowser;
	client: Kernel;
	coordinateSystem?: ComputerToolCoordinateSystem;
	screenshot?: CuaScreenshotSpec;
	/** Action plane(s) in play; browser-executor extras like cursor hints are gated to "browser". */
	mode?: CuaMode;
	/** Mark cursor:pointer elements as clickable hints in browser snapshots. Only honored in "browser" mode. Default false. */
	cursorHints?: boolean;
	/** Browser executor factory, overridable for tests. Defaults to a raw-CDP executor on the browser's cdp_ws_url. */
	createBrowserExecutor?: (cdpWsUrl: string, options: BrowserExecutorOptions) => BrowserExecutor;
}

export class InternalComputerTranslator {
	private readonly sessionId: string;
	private readonly client: Kernel;
	private readonly coordinateSystem: ComputerToolCoordinateSystem;
	private readonly screenshotSpec?: CuaScreenshotSpec;
	private readonly viewport: { width: number; height: number };
	private readonly cdpWsUrl?: string;
	private readonly browserExecutorOptions: BrowserExecutorOptions;
	private readonly browserExecutorFactory: (cdpWsUrl: string, options: BrowserExecutorOptions) => BrowserExecutor;
	private browserExecutor?: BrowserExecutor;

	constructor(opts: InternalComputerTranslatorOptions) {
		this.sessionId = opts.browser.session_id;
		this.client = opts.client;
		this.coordinateSystem = opts.coordinateSystem ?? { type: "pixel" };
		this.screenshotSpec = opts.screenshot;
		this.viewport = opts.browser.viewport ?? { width: 1920, height: 1080 };
		this.cdpWsUrl = opts.browser.cdp_ws_url;
		this.browserExecutorOptions = { cursorHints: opts.cursorHints === true && opts.mode === "browser" };
		this.browserExecutorFactory = opts.createBrowserExecutor ?? ((cdpWsUrl, options) => new BrowserExecutor(cdpWsUrl, options));
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
			this.browserExecutor = this.browserExecutorFactory(this.cdpWsUrl, this.browserExecutorOptions);
		}
		return this.browserExecutor;
	}

	async screenshotRaw(): Promise<Buffer> {
		return (await this.screenshot()).data;
	}

	async screenshot(): Promise<{ data: Buffer; mimeType: string }> {
		const response = await this.client.browsers.computer.captureScreenshot(this.sessionId, {});
		let data: Buffer<ArrayBufferLike> = Buffer.from(await response.arrayBuffer());
		let mimeType = "image/png";
		const transform = this.screenshotSpec?.transform;
		if (transform) {
			let pipeline = sharp(data).resize(transform.width, transform.height, { fit: "fill" });
			if (transform.format === "webp") {
				pipeline = pipeline.webp({ quality: transform.quality });
				mimeType = "image/webp";
			} else if (transform.format === "jpeg") {
				pipeline = pipeline.jpeg({ quality: transform.quality });
				mimeType = "image/jpeg";
			} else {
				pipeline = pipeline.png();
				mimeType = "image/png";
			}
			data = await pipeline.toBuffer();
		}
		return { data, mimeType };
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

	async executeBatch(actions: CuaAction[]): Promise<BatchExecutionResult> {
		const result: BatchExecutionResult = { readResults: [] };
		const pending: KernelBatchAction[] = [];

		const flush = async (): Promise<void> => {
			if (pending.length === 0) return;
			await this.runKernelBatch(pending.splice(0));
		};

		for (const action of actions) {
			if (isCuaBrowserAction(action)) {
				await flush();
				result.readResults.push(...(await this.browser().execute(action)));
				continue;
			}
			switch (action.type) {
				case "screenshot":
					await flush();
					result.readResults.push({ type: "screenshot", ...(await this.screenshot()) });
					break;
				case "zoom":
					await flush();
					result.readResults.push({ type: "screenshot", ...(await this.zoom(action)) });
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
						pending.push(this.toSdkAction({ ...action, x: action.x ?? position.x, y: action.y ?? position.y }));
						break;
					}
					pending.push(this.toSdkAction(action));
					break;
			}
		}

		await flush();
		return result;
	}

	/** Crop the OS screenshot to a region; coordinates stay in the full-screenshot frame. */
	async zoom(action: CuaActionZoom): Promise<{ data: Buffer; mimeType: string }> {
		const screenshot = await this.screenshot();
		const [x0, y0, x1, y1] = action.region;
		const left = Math.max(0, Math.trunc(Math.min(x0, x1)));
		const top = Math.max(0, Math.trunc(Math.min(y0, y1)));
		const width = Math.max(1, Math.trunc(Math.abs(x1 - x0)));
		const height = Math.max(1, Math.trunc(Math.abs(y1 - y0)));
		const data = await sharp(screenshot.data).extract({ left, top, width, height }).png().toBuffer();
		return { data, mimeType: "image/png" };
	}

	private toSdkAction(
		action: Exclude<CuaAction, CuaBrowserAction | { type: "screenshot" | "zoom" | "url" | "cursor_position" | "goto" | "back" | "forward" }>,
	): KernelBatchAction {
		switch (action.type) {
			case "click":
				return this.clickAction(action, {
					button: mouseButton(action.button),
					...(action.num_clicks !== undefined && action.num_clicks > 1 ? { num_clicks: Math.trunc(action.num_clicks) } : {}),
				});
			case "double_click":
				return this.clickAction(action, { num_clicks: 2 });
			case "mouse_down":
				return this.clickAction(action, { button: mouseButton(action.button), click_type: "down" });
			case "mouse_up":
				return this.clickAction(action, { button: mouseButton(action.button), click_type: "up" });
			case "type":
				return typeText(action);
			case "keypress":
				return keypress(action.keys, action.duration);
			case "scroll":
				return this.scrollAction(action);
			case "move":
				return this.moveAction(action);
			case "drag":
				return this.dragAction(action);
			case "wait":
				return waitAction(action);
			default:
				return unreachable(action);
		}
	}

	private clickAction(
		action: CuaActionClick | CuaActionDoubleClick | CuaActionMouseDown | CuaActionMouseUp,
		extra: { button?: CuaMouseButton; num_clicks?: number; click_type?: "down" | "up" },
	): KernelBatchAction {
		const point = this.toViewportPoint(action.x ?? 0, action.y ?? 0);
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

	private scrollAction(action: CuaActionScroll): KernelBatchAction {
		const point = this.toViewportPoint(action.x ?? 0, action.y ?? 0);
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

	private moveAction(action: CuaActionMove): KernelBatchAction {
		const point = this.toViewportPoint(action.x, action.y);
		return { type: "move_mouse", move_mouse: { x: point.x, y: point.y } };
	}

	private dragAction(action: CuaActionDrag): KernelBatchAction {
		return {
			type: "drag_mouse",
			drag_mouse: {
				path: action.path.map((point) => {
					const transformed = this.toViewportPoint(point.x, point.y);
					return [transformed.x, transformed.y] as [number, number];
				}),
				button: dragButton(action.button),
				...holdKeys(action.hold_keys),
			},
		};
	}

	private toViewportPoint(x: number, y: number): { x: number; y: number } {
		if (this.coordinateSystem.type === "pixel") return { x: Math.trunc(x), y: Math.trunc(y) };
		const [min, max] = this.coordinateSystem.range;
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

const CLICK_BUTTONS: ReadonlySet<string> = new Set<CuaMouseButton>(["left", "right", "middle", "back", "forward"]);
const DRAG_BUTTONS: ReadonlySet<string> = new Set<CuaDragMouseButton>(["left", "right", "middle"]);

// The wire schemas keep button as an open string for provider compatibility;
// per the documented CuaMouseButton contract, values outside the set coerce
// to "left".
function mouseButton(value: string | undefined): CuaMouseButton {
	return value !== undefined && CLICK_BUTTONS.has(value) ? (value as CuaMouseButton) : "left";
}

function dragButton(value: string | undefined): CuaDragMouseButton {
	return value !== undefined && DRAG_BUTTONS.has(value) ? (value as CuaDragMouseButton) : "left";
}

function typeText(action: CuaActionTypeText): KernelBatchAction {
	return { type: "type_text", type_text: { text: action.text } };
}

function waitAction(action: CuaActionWait): KernelBatchAction {
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

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function unreachable(action: never): never {
	throw new Error(`unknown computer action type: ${JSON.stringify(action)}`);
}
