import type { BrowserRefState, KernelBrowser } from "@onkernel/cua-agent";
import Kernel from "@onkernel/sdk";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelClient, resolveProfileId } from "./harness-browser";

/**
 * Named sessions: durable, slug-keyed pointers to a Kernel cloud browser
 * session that can be reused across `cua` invocations (e.g. `cua -s login
 * open ...` then `cua -s login click ...`). The metadata file lives under
 * `$XDG_DATA_HOME/cua/named-sessions/<name>.json`; the browser itself is
 * server-side on Kernel.
 */

export interface NamedSessionMetadata {
	name: string;
	kernel_session_id: string;
	live_url?: string;
	profile_id?: string;
	transcript_path?: string;
	/** Model ref last used with this session; chained invocations without -m default to it. */
	model?: string;
	mode?: string;
	native_tool?: string;
	created_at: number;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function namedSessionsDir(): string {
	const xdg = process.env.XDG_DATA_HOME;
	if (xdg) return join(xdg, "cua", "named-sessions");
	return join(homedir(), ".local", "share", "cua", "named-sessions");
}

function sessionFilePath(name: string): string {
	return join(namedSessionsDir(), `${name}.json`);
}

export function validateSlug(name: string): void {
	if (!SLUG_PATTERN.test(name)) {
		throw new Error(
			`invalid session name "${name}": must match ${SLUG_PATTERN} (lowercase a-z, 0-9, hyphens; 1-63 chars; cannot start with a hyphen)`,
		);
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export async function readNamedSession(name: string): Promise<NamedSessionMetadata | undefined> {
	const path = sessionFilePath(name);
	if (!(await fileExists(path))) return undefined;
	const raw = await readFile(path, "utf8");
	return JSON.parse(raw) as NamedSessionMetadata;
}

export async function writeNamedSession(meta: NamedSessionMetadata): Promise<string> {
	validateSlug(meta.name);
	const path = sessionFilePath(meta.name);
	await mkdir(namedSessionsDir(), { recursive: true });
	await writeFile(path, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
	return path;
}

export async function deleteNamedSession(name: string): Promise<boolean> {
	const path = sessionFilePath(name);
	await unlink(refsFilePath(name)).catch(() => {});
	if (!(await fileExists(path))) return false;
	await unlink(path);
	return true;
}

function refsFilePath(name: string): string {
	return join(namedSessionsDir(), `${name}.refs.json`);
}

/**
 * Element refs minted by one invocation (snapshot/find) survive to the next
 * via this per-session file, so `cua -s x snapshot` then `cua -s x click e12`
 * works across processes. Scoped to the named session's browser; stale state
 * is caught by the executor's generation/self-heal machinery.
 */
export async function readNamedSessionRefs(name: string): Promise<BrowserRefState | undefined> {
	try {
		return JSON.parse(await readFile(refsFilePath(name), "utf8")) as BrowserRefState;
	} catch {
		return undefined;
	}
}

export async function writeNamedSessionRefs(name: string, state: BrowserRefState): Promise<void> {
	await mkdir(namedSessionsDir(), { recursive: true });
	await writeFile(refsFilePath(name), JSON.stringify(state) + "\n", { mode: 0o600 });
}

export async function listNamedSessions(): Promise<NamedSessionMetadata[]> {
	const dir = namedSessionsDir();
	if (!(await fileExists(dir))) return [];
	const entries = await readdir(dir);
	const out: NamedSessionMetadata[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		try {
			const raw = await readFile(join(dir, entry), "utf8");
			out.push(JSON.parse(raw) as NamedSessionMetadata);
		} catch {
			// skip unreadable / malformed entries
		}
	}
	out.sort((a, b) => b.created_at - a.created_at);
	return out;
}

export interface StartNamedSessionOptions {
	name: string;
	apiKey: string;
	baseUrl?: string;
	browserTimeoutSeconds?: number;
	/** Profile id or name (created if missing). Same semantics as `--profile`. */
	profileSelector?: string;
	saveProfileChanges?: boolean;
	/** Canonical model ref to seed the session with (same semantics as `-m`). */
	model?: string;
}

export interface StartNamedSessionResult {
	meta: NamedSessionMetadata;
	metadataPath: string;
	client: Kernel;
	browser: KernelBrowser;
}

/** Provision a fresh Kernel browser and persist a named-session metadata file. */
export async function startNamedSession(opts: StartNamedSessionOptions): Promise<StartNamedSessionResult> {
	validateSlug(opts.name);
	const existing = await readNamedSession(opts.name);
	if (existing) {
		throw new Error(
			`named session "${opts.name}" already exists (kernel_session_id=${existing.kernel_session_id}). Run \`cua session stop ${opts.name}\` first.`,
		);
	}

	const client = createKernelClient(opts.apiKey, opts.baseUrl);
	const timeoutSeconds = opts.browserTimeoutSeconds && opts.browserTimeoutSeconds > 0 ? opts.browserTimeoutSeconds : 300;
	let profileId: string | undefined;
	if (opts.profileSelector && opts.profileSelector.trim()) {
		profileId = await resolveProfileId(client, opts.profileSelector);
	}
	const params: Parameters<typeof client.browsers.create>[0] = {
		stealth: true,
		timeout_seconds: timeoutSeconds,
	};
	if (profileId) {
		params.profile = { id: profileId, save_changes: opts.saveProfileChanges ?? false };
	}
	const browser = await client.browsers.create(params);

	const meta: NamedSessionMetadata = {
		name: opts.name,
		kernel_session_id: browser.session_id,
		live_url: browser.browser_live_view_url,
		profile_id: profileId,
		model: opts.model,
		created_at: Date.now(),
	};
	const metadataPath = await writeNamedSession(meta);
	return { meta, metadataPath, client, browser };
}

export interface AttachNamedSessionOptions {
	name: string;
	apiKey: string;
	baseUrl?: string;
}

export interface AttachNamedSessionResult {
	meta: NamedSessionMetadata;
	client: Kernel;
	browser: KernelBrowser;
}

/**
 * Attach to a previously-started named session. Performs a liveness check
 * via `client.browsers.retrieve` so the caller can fail fast when the
 * server-side session has timed out or been deleted.
 */
export async function attachNamedSession(opts: AttachNamedSessionOptions): Promise<AttachNamedSessionResult> {
	const meta = await readNamedSession(opts.name);
	if (!meta) {
		throw new Error(
			`unknown named session "${opts.name}". Run \`cua session list\` to see available sessions, or \`cua session start ${opts.name}\` to create one.`,
		);
	}
	const client = createKernelClient(opts.apiKey, opts.baseUrl);
	let browser: KernelBrowser;
	try {
		browser = await client.browsers.retrieve(meta.kernel_session_id);
	} catch (err) {
		const status = (err as { status?: unknown }).status;
		if (status === 404) {
			throw new Error(
				`named session "${opts.name}" is no longer alive on Kernel (browser timed out or was deleted). Run \`cua session stop ${opts.name} && cua session start ${opts.name}\` to provision a fresh one.`,
			);
		}
		throw new Error(`liveness check for named session "${opts.name}" failed: ${(err as Error).message}`, { cause: err });
	}
	const deletedAt = (browser as { deleted_at?: unknown }).deleted_at;
	if (deletedAt) {
		throw new Error(
			`named session "${opts.name}" is no longer alive on Kernel (browser timed out or was deleted). Run \`cua session stop ${opts.name} && cua session start ${opts.name}\` to provision a fresh one.`,
		);
	}
	return { meta, client, browser };
}

export interface StopNamedSessionOptions {
	name: string;
	apiKey: string;
	baseUrl?: string;
}

export interface StopNamedSessionResult {
	existed: boolean;
	kernelDeleted: boolean;
}

/** Tear down a named session: delete the Kernel browser and remove the metadata file. */
export async function stopNamedSession(opts: StopNamedSessionOptions): Promise<StopNamedSessionResult> {
	const meta = await readNamedSession(opts.name);
	if (!meta) return { existed: false, kernelDeleted: false };
	const client = createKernelClient(opts.apiKey, opts.baseUrl);
	let kernelDeleted = false;
	try {
		await client.browsers.deleteByID(meta.kernel_session_id);
		kernelDeleted = true;
	} catch (err) {
		const status = (err as { status?: unknown }).status;
		if (status !== 404) {
			throw new Error(
				`failed to delete Kernel browser ${meta.kernel_session_id} for named session "${opts.name}": ${(err as Error).message}`,
				{ cause: err },
			);
		}
	}
	await deleteNamedSession(opts.name);
	return { existed: true, kernelDeleted };
}

/** Update the persisted `transcript_path` on a named session. */
export async function recordTranscriptPath(name: string, transcriptPath: string): Promise<void> {
	const meta = await readNamedSession(name);
	if (!meta) return;
	if (meta.transcript_path === transcriptPath) return;
	meta.transcript_path = transcriptPath;
	await writeNamedSession(meta);
}

/** Persist the model/mode/native-tool used with a named session so chained invocations reuse them. */
export async function recordSessionModel(
	name: string,
	runtime: { model: string; mode?: string; native_tool?: string },
): Promise<void> {
	const meta = await readNamedSession(name);
	if (!meta) return;
	if (meta.model === runtime.model && meta.mode === runtime.mode && meta.native_tool === runtime.native_tool) return;
	meta.model = runtime.model;
	meta.mode = runtime.mode;
	meta.native_tool = runtime.native_tool;
	await writeNamedSession(meta);
}

/** Patch individual runtime fields (e.g. after a TUI /mode or /model switch) without clobbering the rest. */
export async function updateNamedSessionRuntime(name: string, patch: { model?: string; mode?: string }): Promise<void> {
	const meta = await readNamedSession(name);
	if (!meta) return;
	const model = patch.model ?? meta.model;
	const mode = patch.mode ?? meta.mode;
	if (meta.model === model && meta.mode === mode) return;
	meta.model = model;
	meta.mode = mode;
	await writeNamedSession(meta);
}

export function shortKernelId(id: string): string {
	return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

export function formatRelativeAge(createdAt: number): string {
	const diff = Date.now() - createdAt;
	const sec = Math.max(0, Math.floor(diff / 1000));
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h`;
	const d = Math.floor(hr / 24);
	return `${d}d`;
}
