import { describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { applyReloadCommand, type InteractiveOptions } from "../src/tui/main";
import { MessageList } from "../src/tui/message-list";
import type { HarnessExtensionHost } from "../src/extensions/host";

// `applyReloadCommand` is the glue the `/reload` dispatch runs (tui/main.ts):
// it bridges the parsed command to `host.reload()` and reports the outcome.
// MessageList colorizes via pi's theme singleton, so init it once.
initTheme();

/** Build the `applyReloadCommand` arg pair with a spyable host and message log. */
function setup(host: HarnessExtensionHost | undefined): {
	opts: InteractiveOptions;
	messages: MessageList;
	notices: string[];
	errors: string[];
} {
	const messages = new MessageList();
	const notices: string[] = [];
	const errors: string[] = [];
	vi.spyOn(messages, "addNotice").mockImplementation((text) => void notices.push(text));
	vi.spyOn(messages, "addError").mockImplementation((text) => void errors.push(text));
	return { opts: { host } as InteractiveOptions, messages, notices, errors };
}

describe("applyReloadCommand (/reload glue)", () => {
	it("invokes host.reload() and reports a clean reload", async () => {
		const reload = vi.fn(async () => {});
		const host = { reload, loadErrors: [], isDisposed: () => false } as unknown as HarnessExtensionHost;
		const { opts, messages, notices, errors } = setup(host);

		await applyReloadCommand(opts, messages);

		expect(reload).toHaveBeenCalledTimes(1);
		expect(notices).toContain("extensions reloaded");
		expect(errors).toHaveLength(0);
	});

	it("surfaces loadErrors after reload", async () => {
		const reload = vi.fn(async () => {});
		const host = {
			reload,
			loadErrors: [{ path: "/ext/broken.ts", error: "boom" }],
			isDisposed: () => false,
		} as unknown as HarnessExtensionHost;
		const { opts, messages, errors, notices } = setup(host);

		await applyReloadCommand(opts, messages);

		expect(reload).toHaveBeenCalledTimes(1);
		expect(errors).toContain("/ext/broken.ts: boom");
		expect(notices).not.toContain("extensions reloaded");
	});

	it("reports an in-progress reload instead of claiming success", async () => {
		// A reload already in flight (e.g. a self-extend drain) coalesces this
		// request; the command must not print "extensions reloaded" for work it
		// didn't actually perform.
		const reload = vi.fn(async () => "coalesced" as const);
		const host = { reload, loadErrors: [], isDisposed: () => false } as unknown as HarnessExtensionHost;
		const { opts, messages, notices } = setup(host);

		await applyReloadCommand(opts, messages);

		expect(notices.some((n) => n.includes("already in progress"))).toBe(true);
		expect(notices).not.toContain("extensions reloaded");
	});

	it("does not report success when the host disposed during reload", async () => {
		const reload = vi.fn(async () => {});
		const host = { reload, loadErrors: [], isDisposed: () => true } as unknown as HarnessExtensionHost;
		const { opts, messages, notices } = setup(host);

		await applyReloadCommand(opts, messages);

		expect(notices).not.toContain("extensions reloaded");
		expect(notices.some((n) => n.includes("shutting down"))).toBe(true);
	});

	it("no-ops with a notice when no host is loaded", async () => {
		const { opts, messages, notices } = setup(undefined);

		await applyReloadCommand(opts, messages);

		expect(notices).toContain("extensions are disabled");
	});
});
