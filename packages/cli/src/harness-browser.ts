import type { KernelBrowser } from "@onkernel/cua-agent";
import Kernel, { NotFoundError } from "@onkernel/sdk";

/** Plain SDK-backed Kernel browser handle for the new harness wiring. */
export interface CuaBrowserHandle {
	client: Kernel;
	browser: KernelBrowser;
	/** Resolved Kernel profile id when --profile was used, otherwise undefined. */
	profileId?: string;
	close(): Promise<void>;
}

export interface ProvisionBrowserOptions {
	apiKey: string;
	baseUrl?: string;
	timeoutSeconds?: number;
	/** Profile id or name. If a name is supplied that does not exist, it is created. */
	profileSelector?: string;
	/** Explicit profile id (skips lookup). */
	profileId?: string;
	/** Persist changes back to the profile when the session ends. Defaults to false. */
	saveChanges?: boolean;
	/** Proxy id or name. Must already exist; never auto-created. */
	proxySelector?: string;
}

const CUID2_LENGTH = 24;
const CUID2_PATTERN = /^[a-z][a-z0-9]{23}$/;

function looksLikeProfileId(selector: string): boolean {
	const trimmed = selector.trim();
	return trimmed.length === CUID2_LENGTH && CUID2_PATTERN.test(trimmed);
}

/**
 * Resolve a `--profile <name|id>` selector to a concrete profile id.
 * Looks up by id first; if the API reports not-found and the selector does
 * not look like a CUID2 id, the profile is created with that name.
 */
export async function resolveProfileId(client: Kernel, selector: string): Promise<string> {
	const trimmed = selector.trim();
	if (!trimmed) throw new Error("profile selector is empty");
	try {
		const existing = await client.profiles.retrieve(trimmed);
		return existing.id;
	} catch (err) {
		if (!(err instanceof NotFoundError)) {
			throw new Error(`looking up browser profile "${trimmed}": ${(err as Error).message}`, { cause: err });
		}
		if (looksLikeProfileId(trimmed)) {
			throw new Error(`browser profile "${trimmed}" was not found`);
		}
		const created = await client.profiles.create({ name: trimmed });
		return created.id;
	}
}

/**
 * Resolve a proxy selector (id or name) to a proxy id. Unlike profiles,
 * proxies are never auto-created — creating one requires type/location/
 * credential configuration that does not fit a bare name.
 */
export async function resolveProxyId(client: Kernel, selector: string): Promise<string> {
	const trimmed = selector.trim();
	if (!trimmed) throw new Error("proxy selector is empty");
	try {
		const existing = await client.proxies.retrieve(trimmed);
		if (existing.id) return existing.id;
	} catch (err) {
		if (!(err instanceof NotFoundError)) {
			throw new Error(`looking up proxy "${trimmed}": ${(err as Error).message}`, { cause: err });
		}
	}
	const proxies = await client.proxies.list();
	const matches = proxies.filter((proxy) => proxy.name === trimmed && proxy.id);
	if (matches.length === 1) return matches[0]!.id!;
	if (matches.length > 1) throw new Error(`proxy name "${trimmed}" is ambiguous (${matches.length} proxies); pass the proxy id`);
	throw new Error(`proxy "${trimmed}" was not found; create one first (e.g. kernel proxies create)`);
}

/** Create a Kernel SDK client with the supplied auth. */
export function createKernelClient(apiKey: string, baseUrl?: string): Kernel {
	return new Kernel({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
}

/** Provision a fresh Kernel cloud browser session and return a handle. */
export async function provisionBrowser(opts: ProvisionBrowserOptions): Promise<CuaBrowserHandle> {
	const client = createKernelClient(opts.apiKey, opts.baseUrl);
	const timeoutSeconds = opts.timeoutSeconds && opts.timeoutSeconds > 0 ? opts.timeoutSeconds : 300;

	let profileId = (opts.profileId ?? "").trim();
	if (!profileId && opts.profileSelector && opts.profileSelector.trim()) {
		profileId = await resolveProfileId(client, opts.profileSelector);
	}

	const params: Parameters<typeof client.browsers.create>[0] = {
		stealth: true,
		timeout_seconds: timeoutSeconds,
	};
	if (profileId) {
		params.profile = { id: profileId, save_changes: opts.saveChanges ?? false };
	}
	if (opts.proxySelector && opts.proxySelector.trim()) {
		params.proxy_id = await resolveProxyId(client, opts.proxySelector);
	}

	const browser = await client.browsers.create(params);
	return {
		client,
		browser,
		profileId: profileId || undefined,
		async close(): Promise<void> {
			await client.browsers.deleteByID(browser.session_id);
		},
	};
}

/**
 * Capture a screenshot through the SDK. Falls back to undefined when the
 * call fails — first-prompt images are best-effort.
 */
export async function captureScreenshot(client: Kernel, sessionId: string): Promise<Buffer | undefined> {
	try {
		const response = await client.browsers.computer.captureScreenshot(sessionId);
		const arrayBuffer = await response.arrayBuffer();
		return Buffer.from(arrayBuffer);
	} catch {
		return undefined;
	}
}
