import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Meta-agent-authored learned tool: `collect_unique_items`.
 *
 * Stands in for what a self-improve meta-agent would write after watching an
 * agent paginate a list by screenshotting each page and re-reading content that
 * overlaps the previous page. That loop both wastes steps and double-counts the
 * rows straddling a page boundary. This tool takes the concatenated page HTML in
 * one call, pulls every `<li>` item text, and returns the de-duplicated set, so
 * the next run resolves the whole list in a single step without double-counting.
 *
 * It also keeps an `agent_start`-incremented run counter and reports it in the
 * tool result text. The counter is the observable proof that the host re-binds
 * an extension's `pi.on` handlers after `reload()`: the tool runs on the second
 * prompt, which is the first run of the post-reload module instance, so the
 * freshly-bound handler has fired exactly once and the result encodes `runs=1`.
 * It is 1 rather than 2 because the loader imports each extension fresh on reload
 * (moduleCache:false), resetting this counter; RUN 1's increment lived on the
 * prior module generation. What survives reload is the binding, not the count —
 * `runs=1` (vs `runs=0`) is what proves the handler was re-bound.
 *
 * Why a plain JSON-Schema object literal and `import type` only: the file is
 * loaded from an isolated temp directory by the jiti loader, which resolves
 * imports relative to that directory, not the cua workspace. A runtime import of
 * a workspace package would be unresolvable there. Keeping the import type-only
 * (erased at load) and declaring parameters inline avoids any runtime resolution.
 *
 * Why pure JS rather than playwright_execute: this test harness is built without
 * `playwright: true` and its fake Kernel client has no daemon, so there is no
 * page to script. The `html` parameter is the content the agent would otherwise
 * have stitched together across screenshots; the parsing below is the real
 * routine the learned tool would run against captured page HTML.
 */
export default function collectItems(pi: ExtensionAPI): void {
	let agentRuns = 0;

	pi.on("agent_start", () => {
		agentRuns += 1;
	});

	pi.on("agent_end", (_event, ctx) => {
		// Headless host: ctx.hasUI is false, so this notify never fires here. The
		// guard keeps the same extension usable under a TUI host unchanged.
		if (ctx.hasUI) ctx.ui.notify(`list collections: ${agentRuns}`, "info");
	});

	pi.registerTool({
		name: "collect_unique_items",
		label: "Collect unique items",
		description:
			"Parse a concatenated multi-page HTML blob into the de-duplicated set of " +
			"<li> item texts. Replaces a screenshot/scroll pagination loop, and folds " +
			"away the rows that overlap across page boundaries, with one structured read.",
		parameters: {
			type: "object",
			properties: {
				html: {
					type: "string",
					description: "Concatenated HTML of every visited page, containing the <li> items",
				},
			},
			required: ["html"],
			additionalProperties: false,
		},
		async execute(_toolCallId, params) {
			const { html } = params as { html: string };
			const items = collectUniqueListItems(html);
			return {
				content: [
					{
						type: "text",
						text: `collected ${items.length} unique (runs=${agentRuns})`,
					},
				],
				details: { items, agentRuns },
			};
		},
	});
}

/**
 * Pull every `<li>` item's text from a (possibly multi-page) HTML blob and
 * return them de-duplicated in first-seen order. De-duplication is what collapses
 * the page-boundary overlap the pixel agent double-counted: an item that appears
 * as the last row of one page and the first row of the next is kept once.
 */
function collectUniqueListItems(html: string): string[] {
	const seen = new Set<string>();
	const ordered: string[] = [];
	const itemPattern = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;

	for (const match of html.matchAll(itemPattern)) {
		const text = stripTags(match[1]);
		if (text.length === 0 || seen.has(text)) continue;
		seen.add(text);
		ordered.push(text);
	}
	return ordered;
}

/** Remove any nested tags from an item and collapse surrounding whitespace. */
function stripTags(item: string): string {
	return item.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}
