import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

export interface NativeCursor {
	x: number;
	y: number;
	visible: boolean;
}

export interface NativeSnapshot {
	visible: string;
	width: number;
	height: number;
	cursor: NativeCursor;
	title?: string;
	pwd?: string;
	totalRows: number;
	scrollbackRows: number;
}

export interface NativeTerminalHandle {
	feed(data: string | Uint8Array): Uint8Array | undefined;
	resize(cols: number, rows: number): void;
	snapshot(options?: { trim?: boolean; unwrap?: boolean }): NativeSnapshot;
	encodeSpecialKey(name: string): Uint8Array | undefined;
	dispose(): void;
}

interface NativeBinding {
	createTerminal(options: {
		cols: number;
		rows: number;
		scrollback: number;
	}): NativeTerminalHandle;
}

let cachedBinding: NativeBinding | undefined;

export function loadNativeBinding(): NativeBinding {
	if (cachedBinding) {
		return cachedBinding;
	}

	const candidates = [join(here, "..", "native", "build", "Release", "ptywright_native.node")];
	const errors: string[] = [];

	for (const candidate of candidates) {
		try {
			cachedBinding = require(candidate) as NativeBinding;
			return cachedBinding;
		} catch (error) {
			errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	throw new Error(
		`Unable to load the ptywright native binding. Run \`npm run build:native -w @onkernel/ptywright\`. ${errors.join(" | ")}`,
	);
}
