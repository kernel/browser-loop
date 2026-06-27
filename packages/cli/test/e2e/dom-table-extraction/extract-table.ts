import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Meta-agent-authored learned tool: `extract_table_rows`.
 *
 * Stands in for what a self-improve meta-agent would write after watching a
 * pixel-only agent walk a long results table by scrolling and screenshotting
 * one viewport at a time, then reasoning over the captured pixels. Instead of
 * that loop, this tool reads the table's HTML in a single call and returns the
 * rows as structured data, so the next run resolves the whole table in one step.
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
 * have stitched together across screenshots; the parsing logic below is the real
 * routine the learned tool would run against captured page HTML.
 */
export default function extractTable(pi: ExtensionAPI): void {
	let agentRuns = 0;

	pi.on("agent_start", () => {
		agentRuns += 1;
	});

	pi.on("agent_end", (_event, ctx) => {
		// Headless host: ctx.hasUI is false, so this notify never fires here. The
		// guard keeps the same extension usable under a TUI host unchanged.
		if (ctx.hasUI) ctx.ui.notify(`table extractions: ${agentRuns}`, "info");
	});

	pi.registerTool({
		name: "extract_table_rows",
		label: "Extract table rows",
		description:
			"Parse an HTML table into rows of cell text. Replaces a scroll/screenshot " +
			"loop with one structured read of the page's table markup.",
		parameters: {
			type: "object",
			properties: {
				html: {
					type: "string",
					description: "HTML containing the <table> to extract",
				},
			},
			required: ["html"],
			additionalProperties: false,
		},
		async execute(_toolCallId, params) {
			const { html } = params as { html: string };
			const rows = parseTableRows(html);
			return {
				content: [{ type: "text", text: `extracted ${rows.length} rows` }],
				details: { rows, agentRuns },
			};
		},
	});
}

/**
 * Extract a table's rows as cell-text strings. Each `<tr>` becomes a row; each
 * `<td>`/`<th>` becomes a cell whose inner markup is stripped and whitespace
 * collapsed. Returns `string[][]` so callers can index rows and columns directly
 * instead of re-deriving them from pixels.
 */
function parseTableRows(html: string): string[][] {
	const rows: string[][] = [];
	const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
	const cellPattern = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;

	for (const rowMatch of html.matchAll(rowPattern)) {
		const cells: string[] = [];
		for (const cellMatch of rowMatch[1].matchAll(cellPattern)) {
			cells.push(stripTags(cellMatch[2]));
		}
		if (cells.length > 0) rows.push(cells);
	}
	return rows;
}

/** Remove any nested tags from a cell and collapse surrounding whitespace. */
function stripTags(cell: string): string {
	return cell.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}
