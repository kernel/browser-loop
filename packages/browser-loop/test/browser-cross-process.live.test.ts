import Kernel from "@onkernel/sdk";
import { describe, expect, it } from "vitest";
import type { BrowserAction } from "../src/index";
import { BrowserExecutor } from "../src/core/translator/browser";
import type { BatchReadResult } from "../src/core/translator/types";

/**
 * Live regression for cross-process named-session ref staleness (Defect 2).
 *
 * Faithfully exercises the process boundary that unit tests can only fake:
 * each BrowserExecutor opens its own CDP connection to the same Kernel
 * browser, so exported ref state is reconciled against real `loaderId`s and
 * real navigations. Gated on LOOP_E2E_LIVE=1 + KERNEL_API_KEY so it never
 * provisions a browser in a normal test run.
 */
const LIVE = process.env.LOOP_E2E_LIVE === "1";
const KERNEL_API_KEY = process.env.KERNEL_API_KEY;

const PAGE_A = "https://example.com/";
const PAGE_B = "https://example.org/";

function textOf(reads: BatchReadResult[]): string {
	return reads
		.filter((read): read is Extract<BatchReadResult, { type: "browser_text" }> => read.type === "browser_text")
		.map((read) => read.text)
		.join("\n");
}

async function withLiveBrowser(run: (cdpWsUrl: string) => Promise<void>): Promise<void> {
	const client = new Kernel({ apiKey: KERNEL_API_KEY! });
	const browser = await client.browsers.create({ stealth: true });
	try {
		const cdpWsUrl = browser.cdp_ws_url;
		if (!cdpWsUrl) throw new Error("browser has no cdp_ws_url");
		await run(cdpWsUrl);
	} finally {
		await client.browsers.deleteByID(browser.session_id).catch(() => {});
	}
}

describe.skipIf(!(LIVE && KERNEL_API_KEY))("BrowserExecutor cross-process document identity (live)", () => {
	it(
		"reuses a ref across processes on the unchanged document but stales it after a navigation",
		async () => {
			await withLiveBrowser(async (cdpWsUrl) => {
				// Process 1: land on page A, mint a ref, export ref state.
				const first = new BrowserExecutor(cdpWsUrl);
				await first.execute({ type: "browser_navigate", url: PAGE_A });
				const snapshot = textOf(await first.execute({ type: "browser_snapshot", filter: "interactive" } as BrowserAction));
				const ref = /\[(e\d+)\]/.exec(snapshot)?.[1];
				expect(ref, `expected a minted ref in:\n${snapshot}`).toBeTruthy();
				const state = first.exportRefState();
				expect(state.documents?.length ?? 0).toBeGreaterThan(0);
				first.close();

				// Process 2: same browser, document unchanged -> imported ref resolves.
				const second = new BrowserExecutor(cdpWsUrl);
				second.importRefState(state);
				const scoped = textOf(await second.execute({ type: "browser_snapshot", ref } as BrowserAction));
				expect(scoped.length).toBeGreaterThan(0);
				second.close();

				// Legacy fail-safe: state serialized without document identity cannot be
				// verified, so its refs stale even though the document is unchanged — never
				// resolving by process-local generation against a possibly-reused node id.
				const legacy = new BrowserExecutor(cdpWsUrl);
				legacy.importRefState({ ...state, documents: undefined });
				await expect(legacy.execute({ type: "browser_click", ref } as BrowserAction)).rejects.toThrow(/stale/);
				legacy.close();

				// A navigation changes the document after the ref was minted, standing
				// in for a click-induced navigation that raced the exporting process.
				const navigator = new BrowserExecutor(cdpWsUrl);
				await navigator.execute({ type: "browser_navigate", url: PAGE_B });
				navigator.close();

				// Process 3: imports the pre-navigation state; reconcile against the live
				// document detects the change and stales the ref rather than resolving it
				// against a different document with possibly-reused backend node ids.
				const third = new BrowserExecutor(cdpWsUrl);
				third.importRefState(state);
				await expect(third.execute({ type: "browser_click", ref } as BrowserAction)).rejects.toThrow(/stale/);
				third.close();
			});
		},
		120_000,
	);
});
