import {
	KeyArrowDown,
	KeyArrowLeft,
	KeyArrowRight,
	KeyArrowUp,
	KeyBacktab,
	KeyDelete,
	KeyEnd,
	KeyEscape,
	KeyHome,
	KeyInsert,
	KeyPageDown,
	KeyPageUp,
	SPECIAL_KEY_KIND,
	type SpecialKey,
	type SpecialKeyName,
} from "./keys";
import { loadNativeBinding, type NativeSnapshot, type NativeTerminalHandle } from "./native-loader";

export interface CreateTerminalOptions {
	cols: number;
	rows: number;
	scrollback?: number;
}

export interface Cursor {
	x: number;
	y: number;
	visible: boolean;
}

export interface SnapshotOptions {
	trim?: boolean;
	unwrap?: boolean;
}

export interface TerminalSnapshot {
	visible: string;
	lines: string[];
	width: number;
	height: number;
	cursor: Cursor;
	title?: string;
	pwd?: string;
	totalRows: number;
	scrollbackRows: number;
}

export interface FeedResult {
	replyBytes?: Uint8Array;
}

export class TerminalSurface {
	private readonly native: NativeTerminalHandle;
	private disposed = false;

	constructor(options: CreateTerminalOptions) {
		if (options.cols <= 0 || options.rows <= 0) {
			throw new Error(`invalid terminal size ${options.cols}x${options.rows}`);
		}

		this.native = loadNativeBinding().createTerminal({
			cols: options.cols,
			rows: options.rows,
			scrollback: options.scrollback ?? 0,
		});
	}

	feed(data: string | Uint8Array): FeedResult {
		this.ensureOpen();
		const replyBytes = this.native.feed(data);
		return replyBytes && replyBytes.length > 0 ? { replyBytes } : {};
	}

	resize(cols: number, rows: number): void {
		this.ensureOpen();
		this.native.resize(cols, rows);
	}

	snapshot(options: SnapshotOptions = {}): TerminalSnapshot {
		this.ensureOpen();
		const snapshot = this.native.snapshot(options);
		return normalizeSnapshot(snapshot);
	}

	encodeSpecialKey(key: SpecialKey): Uint8Array {
		this.ensureOpen();
		if (key.kind !== SPECIAL_KEY_KIND) {
			throw new Error("encodeSpecialKey expects a SpecialKey");
		}
		const encoded = this.native.encodeSpecialKey(key.name);
		if (encoded && encoded.length > 0) {
			return encoded;
		}
		return Buffer.from(legacySpecialKey(key.name), "latin1");
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.native.dispose();
	}

	private ensureOpen(): void {
		if (this.disposed) {
			throw new Error("terminal already disposed");
		}
	}
}

export function createTerminal(options: CreateTerminalOptions): TerminalSurface {
	return new TerminalSurface(options);
}

function normalizeSnapshot(snapshot: NativeSnapshot): TerminalSnapshot {
	return {
		visible: snapshot.visible,
		lines: splitLines(snapshot.visible),
		width: snapshot.width,
		height: snapshot.height,
		cursor: snapshot.cursor,
		title: snapshot.title,
		pwd: snapshot.pwd,
		totalRows: snapshot.totalRows,
		scrollbackRows: snapshot.scrollbackRows,
	};
}

function legacySpecialKey(name: SpecialKeyName): string {
	switch (name) {
		case "arrow_up":
			return KeyArrowUp;
		case "arrow_down":
			return KeyArrowDown;
		case "arrow_left":
			return KeyArrowLeft;
		case "arrow_right":
			return KeyArrowRight;
		case "home":
			return KeyHome;
		case "end":
			return KeyEnd;
		case "page_up":
			return KeyPageUp;
		case "page_down":
			return KeyPageDown;
		case "insert":
			return KeyInsert;
		case "delete":
			return KeyDelete;
		case "escape":
			return KeyEscape;
		case "backtab":
			return KeyBacktab;
	}
}

function splitLines(text: string): string[] {
	if (!text) {
		return [];
	}
	const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
	if (!trimmed) {
		return [""];
	}
	return trimmed.split("\n");
}
