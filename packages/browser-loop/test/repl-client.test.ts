import { describe, expect, it, vi } from "vitest";
import { executeBrowserRepl } from "../src/core/repl";

const browser = {
	base_url: "https://metro.example/browser/kernel/",
	cdp_ws_url: "wss://metro.example/browser/cdp?jwt=secret-token",
};

describe("executeBrowserRepl", () => {
	it("authenticates through the browser JWT and preserves the response", async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({
			success: true,
			repl_id: "repl_1",
			content: [{ type: "text", channel: "write", text: "ok" }],
		}), { status: 200, headers: { "content-type": "application/json" } }));
		const result = await executeBrowserRepl(browser, { code: "repl.write('ok')" }, { fetch });
		expect(result.repl_id).toBe("repl_1");
		const [url, init] = fetch.mock.calls[0]!;
		expect(String(url)).toBe("https://metro.example/browser/kernel/repl?jwt=secret-token");
		expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ code: "repl.write('ok')" }) });
	});

	it("rejects requests locally before dispatch", async () => {
		const fetch = vi.fn();
		await expect(executeBrowserRepl(browser, { code: "", timeout_sec: 0 }, { fetch })).rejects.toThrow(/empty only when reset/);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects malformed typed content", async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({
			success: true,
			repl_id: "repl_1",
			content: [{ type: "text", channel: "unknown", text: "bad" }],
		}), { status: 200 }));
		await expect(executeBrowserRepl(browser, { code: "1" }, { fetch })).rejects.toThrow("invalid response");
	});

	it("surfaces structured HTTP errors", async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ message: "REPL unavailable" }), { status: 500 }));
		await expect(executeBrowserRepl(browser, { code: "1" }, { fetch })).rejects.toThrow("Browser REPL request failed (500): REPL unavailable");
	});
});
