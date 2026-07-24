import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpConnection, CdpProtocolError } from "../src/translator/cdp";

class FakeSocket {
	static instances: FakeSocket[] = [];
	readyState = 0;
	sent: string[] = [];
	private listeners = new Map<string, Array<(event: unknown) => void>>();

	constructor(public url: string) {
		FakeSocket.instances.push(this);
		queueMicrotask(() => {
			this.readyState = 1;
			this.emit("open", {});
		});
	}

	addEventListener(type: string, listener: (event: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(listener);
		this.listeners.set(type, list);
	}

	emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}

	send(message: string): void {
		// Mirrors the WebSocket spec: a non-OPEN socket discards silently.
		if (this.readyState !== 1) return;
		this.sent.push(message);
	}

	close(): void {
		this.readyState = 3;
		this.emit("close", {});
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
	FakeSocket.instances = [];
});

describe("CdpConnection send", () => {
	it("rejects instead of hanging when the socket closed between connect and send", async () => {
		vi.stubGlobal("WebSocket", Object.assign(FakeSocket, { OPEN: 1 }));
		const cdp = new CdpConnection("wss://fake.test/cdp");

		const first = cdp.send("Target.getTargets");
		await vi.waitFor(() => expect(FakeSocket.instances[0]!.sent).toHaveLength(1));
		const socket = FakeSocket.instances[0]!;
		socket.emit("message", { data: JSON.stringify({ id: 1, result: { targetInfos: [] } }) });
		await first;

		// Close silently (no close event yet): send() would be discarded.
		socket.readyState = 3;
		await expect(cdp.send("Target.getTargets")).rejects.toThrow(/closed before/);
	});

	it("rejects in-flight commands when the connection closes", async () => {
		vi.stubGlobal("WebSocket", Object.assign(FakeSocket, { OPEN: 1 }));
		const cdp = new CdpConnection("wss://fake.test/cdp");
		const pending = cdp.send("Target.getTargets");
		await Promise.resolve();
		FakeSocket.instances[0]!.close();
		await expect(pending).rejects.toThrow(/closed/);
	});

	it("preserves command and protocol error metadata", async () => {
		vi.stubGlobal("WebSocket", Object.assign(FakeSocket, { OPEN: 1 }));
		const cdp = new CdpConnection("wss://fake.test/cdp");
		const pending = cdp.send("Accessibility.getFullAXTree", { frameId: "F1" }, "session-1");
		await vi.waitFor(() => expect(FakeSocket.instances[0]!.sent).toHaveLength(1));
		FakeSocket.instances[0]!.emit("message", {
			data: JSON.stringify({ id: 1, error: { code: -32000, message: "Frame with the given id was not found.", data: "gone" } }),
		});

		const error = await pending.catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(CdpProtocolError);
		expect(error).toMatchObject({
			method: "Accessibility.getFullAXTree",
			code: -32000,
			protocolMessage: "Frame with the given id was not found.",
			data: "gone",
		});
	});
});
