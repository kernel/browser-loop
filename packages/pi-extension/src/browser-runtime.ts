import Kernel from "@onkernel/sdk";
import { CuaExecutionResources } from "@onkernel/cua-agent";

export interface BrowserOptions {
	sessionId?: string;
	profileId?: string;
	proxyId?: string;
	timeoutSeconds: number;
	saveProfileChanges: boolean;
}
export interface BrowserStatus {
	sessionId?: string;
	owned?: boolean;
	liveUrl?: string;
	createdAt?: string;
}

/**
 * Lazily provisions one browser for one pi session. Attached sessions are never
 * deleted.
 *
 * This holds `CuaExecutionResources` rather than a full `attach()` handle: pi
 * owns the model collection and the agent loop here, so the handle's `models`
 * wrapper, retry, and harness behaviors have nothing to attach to. What the
 * extension needs is the executor and the catalog compiler — the part of the
 * library that is not pi-shaped.
 */
export class CuaBrowserRuntime {
	private pending?: Promise<CuaExecutionResources>;
	private resources?: CuaExecutionResources;
	private client?: Kernel;
	private status: BrowserStatus = {};
	private closed = false;
	constructor(
		private readonly options: BrowserOptions,
		private readonly env: NodeJS.ProcessEnv = process.env,
	) {}

	getStatus(): BrowserStatus {
		return { ...this.status };
	}
	async get(signal?: AbortSignal): Promise<CuaExecutionResources> {
		if (signal?.aborted) throw new Error("CUA browser provisioning cancelled");
		if (this.closed) throw new Error("CUA browser runtime is closed");
		if (this.resources) return this.resources;
		this.pending ??= this.provision();
		try {
			const resources = await this.pending;
			if (this.closed) throw new Error("CUA browser runtime is closed");
			this.resources = resources;
			return resources;
		} catch (error) {
			this.pending = undefined;
			throw error;
		}
	}
	private async provision(): Promise<CuaExecutionResources> {
		const apiKey = this.env.KERNEL_API_KEY;
		if (!apiKey) throw new Error("KERNEL_API_KEY is required when a CUA tool first executes");
		const client = new Kernel({ apiKey, ...(this.env.KERNEL_BASE_URL ? { baseURL: this.env.KERNEL_BASE_URL } : {}) });
		const attached = Boolean(this.options.sessionId);
		const browser = attached
			? await client.browsers.retrieve(this.options.sessionId!)
			: await client.browsers.create({
					stealth: true,
					timeout_seconds: this.options.timeoutSeconds,
					...(this.options.profileId ? { profile: { id: this.options.profileId, save_changes: this.options.saveProfileChanges } } : {}),
					...(this.options.proxyId ? { proxy_id: this.options.proxyId } : {}),
				});
		this.client = client;
		this.status = {
			sessionId: browser.session_id,
			owned: !attached,
			liveUrl: browser.browser_live_view_url,
			createdAt: browser.created_at,
		};
		return new CuaExecutionResources({ browser, client });
	}
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		// A shutdown can race the first tool call. Wait for provisioning so an owned
		// browser created after shutdown starts is still disposed and deleted.
		let pendingResources: CuaExecutionResources | undefined;
		try {
			pendingResources = await this.pending;
		} catch {
			/* provisioning failure needs no cleanup */
		}
		const resources = this.resources ?? pendingResources;
		this.resources = undefined;
		try {
			await resources?.dispose();
		} finally {
			if (this.status.owned && this.status.sessionId && this.client) await this.client.browsers.deleteByID(this.status.sessionId);
		}
	}
}
