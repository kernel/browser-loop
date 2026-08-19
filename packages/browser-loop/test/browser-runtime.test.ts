import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), deleteByID: vi.fn(), dispose: vi.fn() }));
vi.mock("@onkernel/sdk", () => ({
	default: class Kernel {
		browsers = { create: state.create, retrieve: state.retrieve, deleteByID: state.deleteByID };
	},
}));
vi.mock("@onkernel/browser-loop", () => ({
	LoopExecutionResources: class {
		dispose = state.dispose;
		constructor(_options: unknown) {}
	},
}));

import { LoopBrowserRuntime } from "../src/pi-extension/browser-runtime";

const owned = { session_id: "owned", created_at: "2026-01-01T00:00:00Z", browser_live_view_url: "https://live" };

beforeEach(() => {
	state.create.mockReset();
	state.retrieve.mockReset();
	state.deleteByID.mockReset();
	state.dispose.mockReset();
});

describe("LoopBrowserRuntime", () => {
	it("creates one shared owned browser for concurrent first calls and deletes it on close", async () => {
		state.create.mockResolvedValue(owned);
		const runtime = new LoopBrowserRuntime({ timeoutSeconds: 60, saveProfileChanges: false }, { KERNEL_API_KEY: "test" });
		const [first, second] = await Promise.all([runtime.get(), runtime.get()]);
		expect(first).toBe(second);
		expect(state.create).toHaveBeenCalledTimes(1);
		expect(runtime.getStatus()).toMatchObject({ sessionId: "owned", owned: true, liveUrl: "https://live" });
		await runtime.close();
		expect(state.dispose).toHaveBeenCalledTimes(1);
		expect(state.deleteByID).toHaveBeenCalledWith("owned");
	});

	it("deletes an owned browser when resource disposal fails", async () => {
		state.create.mockResolvedValue(owned);
		state.dispose.mockRejectedValue(new Error("dispose failed"));
		const runtime = new LoopBrowserRuntime({ timeoutSeconds: 60, saveProfileChanges: false }, { KERNEL_API_KEY: "test" });
		await runtime.get();
		await expect(runtime.close()).rejects.toThrow("dispose failed");
		expect(state.deleteByID).toHaveBeenCalledWith("owned");
	});

	it("does not delete an attached browser", async () => {
		state.retrieve.mockResolvedValue({ ...owned, session_id: "attached" });
		const runtime = new LoopBrowserRuntime(
			{ sessionId: "attached", timeoutSeconds: 60, saveProfileChanges: false },
			{ KERNEL_API_KEY: "test" },
		);
		await runtime.get();
		await runtime.close();
		expect(state.retrieve).toHaveBeenCalledWith("attached");
		expect(state.deleteByID).not.toHaveBeenCalled();
	});

	it("waits for in-flight provisioning during close and cleans up the resulting browser", async () => {
		let resolve!: (value: typeof owned) => void;
		state.create.mockReturnValue(
			new Promise<typeof owned>((done) => {
				resolve = done;
			}),
		);
		const runtime = new LoopBrowserRuntime({ timeoutSeconds: 60, saveProfileChanges: false }, { KERNEL_API_KEY: "test" });
		const pending = runtime.get().catch(() => undefined);
		const closing = runtime.close();
		resolve(owned);
		await Promise.all([pending, closing]);
		expect(state.deleteByID).toHaveBeenCalledWith("owned");
	});

	it("fails before provisioning when cancelled or unconfigured", async () => {
		const cancelled = new AbortController();
		cancelled.abort();
		await expect(
			new LoopBrowserRuntime({ timeoutSeconds: 60, saveProfileChanges: false }, { KERNEL_API_KEY: "test" }).get(cancelled.signal),
		).rejects.toThrow("cancelled");
		await expect(new LoopBrowserRuntime({ timeoutSeconds: 60, saveProfileChanges: false }, {}).get()).rejects.toThrow("KERNEL_API_KEY");
	});
});
