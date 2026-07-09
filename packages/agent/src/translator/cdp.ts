/**
 * Minimal raw-CDP client for the browser action plane.
 *
 * Connects to a Kernel browser's `cdp_ws_url` over a plain WebSocket and
 * speaks the DevTools JSON-RPC protocol directly — no Playwright and no
 * driver dependency. Only what the browser executor needs: command dispatch on
 * the browser connection and on attached page sessions.
 */

interface PendingCommand {
	resolve(result: unknown): void;
	reject(error: Error): void;
}

export interface CdpEventMessage {
	method: string;
	params: Record<string, unknown>;
	sessionId?: string;
}

export interface CdpTargetInfo {
	targetId: string;
	type: string;
	title: string;
	url: string;
	attached?: boolean;
}

export type CdpEventListener = (event: CdpEventMessage) => void;

export class CdpConnection {
	private socket?: WebSocket;
	private opening?: Promise<WebSocket>;
	private nextId = 1;
	private readonly pending = new Map<number, PendingCommand>();
	private readonly listeners = new Set<CdpEventListener>();
	private readonly sessionsByTarget = new Map<string, string>();

	constructor(private readonly wsUrl: string) {}

	onEvent(listener: CdpEventListener): void {
		this.listeners.add(listener);
	}

	async send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
		const socket = await this.connect();
		const id = this.nextId++;
		const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
			// A non-OPEN socket silently discards send() per the WebSocket spec,
			// which would leave this command pending forever.
			if (socket.readyState !== WebSocket.OPEN) {
				this.pending.delete(id);
				reject(new Error(`CDP connection closed before ${method} could be sent`));
				return;
			}
			try {
				socket.send(message);
			} catch (err) {
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	/** List page targets (tabs) on the browser connection. */
	async pageTargets(): Promise<CdpTargetInfo[]> {
		const { targetInfos } = await this.send<{ targetInfos: CdpTargetInfo[] }>("Target.getTargets");
		return targetInfos.filter((target) => target.type === "page");
	}

	/** Attach to a page target (flat protocol) and cache the session. */
	async attachToTarget(targetId: string): Promise<string> {
		const cached = this.sessionsByTarget.get(targetId);
		if (cached) return cached;
		const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
		this.sessionsByTarget.set(targetId, sessionId);
		return sessionId;
	}

	async createTarget(url: string): Promise<string> {
		const { targetId } = await this.send<{ targetId: string }>("Target.createTarget", { url });
		return targetId;
	}

	close(): void {
		this.socket?.close();
		this.socket = undefined;
		this.opening = undefined;
		this.sessionsByTarget.clear();
		this.rejectPending(new Error("CDP connection closed"));
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	private connect(): Promise<WebSocket> {
		if (this.socket && this.socket.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
		this.opening ??= new Promise<WebSocket>((resolve, reject) => {
			const socket = new WebSocket(this.wsUrl);
			socket.addEventListener("open", () => {
				this.socket = socket;
				resolve(socket);
			});
			socket.addEventListener("error", () => {
				this.opening = undefined;
				reject(new Error(`CDP connection to ${this.wsUrl} failed`));
			});
			socket.addEventListener("close", () => {
				this.socket = undefined;
				this.opening = undefined;
				this.sessionsByTarget.clear();
				this.rejectPending(new Error("CDP connection closed"));
			});
			socket.addEventListener("message", (event) => {
				this.handleMessage(typeof event.data === "string" ? event.data : String(event.data));
			});
		});
		return this.opening;
	}

	private handleMessage(data: string): void {
		let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
		try {
			message = JSON.parse(data);
		} catch {
			return;
		}
		if (typeof message.id === "number") {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) pending.reject(new Error(message.error.message ?? "CDP command failed"));
			else pending.resolve(message.result ?? {});
			return;
		}
		if (typeof message.method === "string") {
			if (message.method === "Target.detachedFromTarget") {
				const detached = message.params?.sessionId;
				for (const [targetId, sessionId] of this.sessionsByTarget) {
					if (sessionId === detached) this.sessionsByTarget.delete(targetId);
				}
			}
			const event: CdpEventMessage = { method: message.method, params: message.params ?? {}, sessionId: message.sessionId };
			for (const listener of this.listeners) listener(event);
		}
	}
}
