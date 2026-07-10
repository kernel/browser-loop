import Kernel, { NotFoundError } from "@onkernel/sdk";
import { describe, expect, it } from "vitest";
import { resolveProxyId } from "../src/harness-browser";

const notFound = () => new NotFoundError(404, { message: "not found" }, "not found", new Headers());

function fakeClient(overrides: {
	retrieve?: (id: string) => Promise<{ id?: string }>;
	list?: () => Promise<Array<{ id?: string; name?: string }>>;
}): Kernel {
	return {
		proxies: {
			retrieve: overrides.retrieve ?? (async () => Promise.reject(notFound())),
			list: overrides.list ?? (async () => []),
		},
	} as unknown as Kernel;
}

describe("resolveProxyId", () => {
	it("returns the id when the selector is an existing proxy id", async () => {
		const client = fakeClient({ retrieve: async (id) => ({ id }) });
		await expect(resolveProxyId(client, "proxy_abc")).resolves.toBe("proxy_abc");
	});

	it("does not fall back to name matching when retrieve succeeds without an id", async () => {
		let listCalled = false;
		const client = fakeClient({
			retrieve: async () => ({}),
			list: async () => {
				listCalled = true;
				return [{ id: "proxy_1", name: "proxy_abc" }];
			},
		});
		await expect(resolveProxyId(client, "proxy_abc")).rejects.toThrow(/looking up proxy/);
		expect(listCalled).toBe(false);
	});

	it("falls back to a unique name match from the proxy list", async () => {
		const client = fakeClient({ list: async () => [{ id: "proxy_1", name: "residential-us" }, { id: "proxy_2", name: "other" }] });
		await expect(resolveProxyId(client, "residential-us")).resolves.toBe("proxy_1");
	});

	it("rejects an ambiguous name instead of guessing", async () => {
		const client = fakeClient({ list: async () => [{ id: "proxy_1", name: "us" }, { id: "proxy_2", name: "us" }] });
		await expect(resolveProxyId(client, "us")).rejects.toThrow(/ambiguous/);
	});

	it("never auto-creates: an unknown selector is an error", async () => {
		const client = fakeClient({});
		await expect(resolveProxyId(client, "does-not-exist")).rejects.toThrow(/was not found/);
	});

	it("propagates non-404 lookup failures", async () => {
		const client = fakeClient({
			retrieve: async () => Promise.reject(new Error("boom")),
		});
		await expect(resolveProxyId(client, "proxy_abc")).rejects.toThrow(/looking up proxy/);
	});
});
