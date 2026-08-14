import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn, type IPty } from "node-pty";
import { KeyEnter, type Key, type SpecialKey } from "./keys";
import { createTerminal, type SnapshotOptions, type TerminalSnapshot, type TerminalSurface } from "./terminal";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const TRANSCRIPT_TAIL = 2000;

export interface SpawnSessionOptions {
	command: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	cols?: number;
	rows?: number;
	scrollback?: number;
	name?: string;
}

export interface SessionSnapshot extends TerminalSnapshot {
	transcript: string;
}

export interface ProcessStatus {
	pid: number;
	running: boolean;
	exitCode?: number;
	signal?: number;
	startedAt: string;
	exitedAt?: string;
}

export interface WaitOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export class PtySession {
	private readonly terminal: TerminalSurface;
	private readonly events = new EventEmitter();
	private transcript = "";
	private closed = false;
	private revision = 0;
	private exitCode: number | undefined;
	private exitSignal: number | undefined;
	private exitedAt: Date | undefined;
	private readonly startedAt = new Date();

	constructor(
		private readonly pty: IPty,
		private readonly options: Required<Pick<SpawnSessionOptions, "command" | "args">> & SpawnSessionOptions,
	) {
		this.terminal = createTerminal({
			cols: options.cols ?? DEFAULT_COLS,
			rows: options.rows ?? DEFAULT_ROWS,
			scrollback: options.scrollback ?? 0,
		});

		this.pty.onData((data) => {
			if (this.closed) {
				return;
			}
			this.transcript += data;
			const { replyBytes } = this.terminal.feed(data);
			if (replyBytes && replyBytes.length > 0) {
				this.pty.write(Buffer.from(replyBytes).toString("utf8"));
			}
			this.noteUpdate();
		});

		this.pty.onExit((event) => {
			this.exitCode = event.exitCode;
			this.exitSignal = event.signal;
			this.exitedAt = new Date();
			this.noteUpdate();
		});
	}

	send(text: string): void {
		this.ensureOpen();
		this.pty.write(text);
	}

	line(text: string): void {
		this.send(text);
		this.press(KeyEnter);
	}

	press(key: Key): void {
		this.send(key);
	}

	pressKey(key: SpecialKey): void {
		this.ensureOpen();
		const bytes = this.terminal.encodeSpecialKey(key);
		this.pty.write(Buffer.from(bytes).toString("latin1"));
	}

	resize(cols: number, rows: number): void {
		this.ensureOpen();
		if (cols <= 0 || rows <= 0) {
			throw new Error(`invalid PTY size ${cols}x${rows}`);
		}
		this.pty.resize(cols, rows);
		this.terminal.resize(cols, rows);
		this.noteUpdate();
	}

	snapshot(options: SnapshotOptions = {}): SessionSnapshot {
		const screen = this.terminal.snapshot(options);
		return {
			transcript: this.transcript,
			...screen,
		};
	}

	status(): ProcessStatus {
		return {
			pid: this.pty.pid,
			running: this.exitCode === undefined && this.exitedAt === undefined,
			exitCode: this.exitCode,
			signal: this.exitSignal,
			startedAt: this.startedAt.toISOString(),
			exitedAt: this.exitedAt?.toISOString(),
		};
	}

	async waitForVisible(text: string, options?: WaitOptions): Promise<SessionSnapshot> {
		return this.waitFor(`visible screen to contain ${JSON.stringify(text)}`, (snapshot) => snapshot.visible.includes(text), options);
	}

	async waitForTranscript(text: string, options?: WaitOptions): Promise<SessionSnapshot> {
		return this.waitFor(`transcript to contain ${JSON.stringify(text)}`, (snapshot) => snapshot.transcript.includes(text), options);
	}

	async waitFor(
		description: string,
		match: (snapshot: SessionSnapshot) => boolean,
		options?: WaitOptions,
	): Promise<SessionSnapshot> {
		const controller = createWaitController(options);
		try {
			while (true) {
				const seen = this.revision;
				const snapshot = this.snapshot();
				if (match(snapshot)) {
					return snapshot;
				}
				if (this.exitedAt) {
					throw this.buildWaitError(description, snapshot, new Error("process exited before condition was satisfied"));
				}
				if (this.revision !== seen) {
					continue;
				}
				await waitForUpdate(this.events, controller.signal);
			}
		} catch (error) {
			if (controller.signal.aborted) {
				throw this.buildWaitError(description, this.snapshot(), abortReason(controller.signal));
			}
			throw error;
		} finally {
			controller.cleanup();
		}
	}

	async waitForStable(stableForMs: number, options?: WaitOptions): Promise<SessionSnapshot> {
		if (stableForMs <= 0) {
			throw new Error("stableForMs must be positive");
		}

		const controller = createWaitController(options);
		let lastVisible = this.snapshot().visible;
		let lastChangeAt = Date.now();

		try {
			while (true) {
				const seen = this.revision;
				const snapshot = this.snapshot();
				if (snapshot.visible !== lastVisible) {
					lastVisible = snapshot.visible;
					lastChangeAt = Date.now();
				}
				if (Date.now() - lastChangeAt >= stableForMs) {
					return snapshot;
				}
				if (this.exitedAt) {
					return snapshot;
				}
				if (this.revision !== seen) {
					continue;
				}
				await waitForUpdate(this.events, controller.signal, stableForMs);
			}
		} catch (error) {
			if (controller.signal.aborted) {
				throw this.buildWaitError(
					`visible screen to remain stable for ${stableForMs}ms`,
					this.snapshot(),
					abortReason(controller.signal),
				);
			}
			throw error;
		} finally {
			controller.cleanup();
		}
	}

	async waitForExit(options?: WaitOptions): Promise<ProcessStatus> {
		const controller = createWaitController(options);
		try {
			while (!this.exitedAt) {
				const seen = this.revision;
				if (this.exitedAt) {
					break;
				}
				if (this.revision !== seen) {
					continue;
				}
				await waitForUpdate(this.events, controller.signal);
			}
			return this.status();
		} catch (error) {
			if (controller.signal.aborted) {
				throw new Error(`waiting for process exit: ${abortReason(controller.signal).message}`);
			}
			throw error;
		} finally {
			controller.cleanup();
		}
	}

	async writeArtifacts(dir: string): Promise<void> {
		if (!dir.trim()) {
			throw new Error("artifact directory is required");
		}
		await mkdir(dir, { recursive: true });

		const snapshot = this.snapshot();
		await writeFile(`${dir}/transcript.txt`, snapshot.transcript, "utf8");
		await writeFile(`${dir}/visible.txt`, snapshot.visible, "utf8");
		await writeFile(
			`${dir}/metadata.json`,
			JSON.stringify(
				{
					command: this.options.command,
					args: this.options.args ?? [],
					cwd: this.options.cwd,
					width: snapshot.width,
					height: snapshot.height,
					title: snapshot.title,
					pwd: snapshot.pwd,
					totalRows: snapshot.totalRows,
					scrollbackRows: snapshot.scrollbackRows,
					cursor: snapshot.cursor,
					status: this.status(),
					capturedAt: new Date().toISOString(),
				},
				null,
				2,
			),
			"utf8",
		);
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		try {
			this.pty.kill();
		} catch {
			// Best-effort teardown only.
		}
		this.terminal.dispose();
		this.noteUpdate();
	}

	private noteUpdate(): void {
		this.revision += 1;
		this.events.emit("update");
	}

	private ensureOpen(): void {
		if (this.closed) {
			throw new Error("session already closed");
		}
	}

	private buildWaitError(description: string, snapshot: SessionSnapshot, cause: Error): Error {
		const status = this.status();
		return new Error(
			[
				`waiting for ${description}: ${cause.message}`,
				`process status: pid=${status.pid} running=${status.running} exitCode=${status.exitCode ?? "nil"} signal=${status.signal ?? "nil"}`,
				`cursor: x=${snapshot.cursor.x} y=${snapshot.cursor.y} visible=${snapshot.cursor.visible}`,
				`title: ${snapshot.title ?? ""}`,
				`pwd: ${snapshot.pwd ?? ""}`,
				"last visible screen:",
				snapshot.visible,
				"last transcript tail:",
				transcriptTail(snapshot.transcript),
			].join("\n"),
		);
	}
}

export function spawnSession(options: SpawnSessionOptions): PtySession {
	if (!options.command.trim()) {
		throw new Error("command is required");
	}

	const cols = options.cols ?? DEFAULT_COLS;
	const rows = options.rows ?? DEFAULT_ROWS;
	const pty = spawn(options.command, options.args ?? [], {
		name: options.name ?? "xterm-256color",
		cols,
		rows,
		cwd: options.cwd,
		env: {
			...process.env,
			TERM: options.name ?? "xterm-256color",
			...(options.env ?? {}),
		},
	});

	return new PtySession(pty, {
		...options,
		cols,
		rows,
		args: options.args ?? [],
		command: options.command,
	});
}

function createWaitController(options?: WaitOptions): { signal: AbortSignal; cleanup: () => void } {
	const timeoutMs = options?.timeoutMs;
	if (timeoutMs === undefined) {
		return {
			signal: options?.signal ?? new AbortController().signal,
			cleanup: () => {},
		};
	}

	const timeout = new AbortController();
	const timer = setTimeout(() => {
		timeout.abort(new Error(`timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	const signal = options?.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
	return {
		signal,
		cleanup: () => clearTimeout(timer),
	};
}

async function waitForUpdate(events: EventEmitter, signal: AbortSignal, timeoutMs?: number): Promise<void> {
	if (signal.aborted) {
		throw abortReason(signal);
	}

	await new Promise<void>((resolve, reject) => {
		let timer: NodeJS.Timeout | undefined;
		const onUpdate = () => {
			cleanup();
			resolve();
		};
		const onAbort = () => {
			cleanup();
			reject(abortReason(signal));
		};
		const cleanup = () => {
			events.off("update", onUpdate);
			signal.removeEventListener("abort", onAbort);
			if (timer) {
				clearTimeout(timer);
			}
		};

		events.once("update", onUpdate);
		signal.addEventListener("abort", onAbort, { once: true });
		if (timeoutMs !== undefined) {
			timer = setTimeout(() => {
				cleanup();
				resolve();
			}, Math.min(timeoutMs, 50));
		}
	});
}

function abortReason(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) {
		return signal.reason;
	}
	if (typeof signal.reason === "string" && signal.reason.length > 0) {
		return new Error(signal.reason);
	}
	return new Error("aborted");
}

function transcriptTail(transcript: string): string {
	if (transcript.length <= TRANSCRIPT_TAIL) {
		return transcript;
	}
	return transcript.slice(-TRANSCRIPT_TAIL);
}
