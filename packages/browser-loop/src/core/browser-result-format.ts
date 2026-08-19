import type { BrowserActResult } from "./translator/types";

const BROWSER_ACT_DIFF_ENTRY_LIMIT = 200;
const BROWSER_ACT_DIFF_CHAR_LIMIT = 20_000;
const BROWSER_ACT_RESULT_CHAR_LIMIT = 50_000;

/** Format model-facing plan feedback with bounded diff entries, diff characters, and total characters. */
export function formatBrowserActResult(result: BrowserActResult): string {
	const lines = [`browser_act: ${result.outcome}`];
	if (result.stopped_at !== undefined) lines.push(`stopped_at: ${result.stopped_at} (${result.stop_reason ?? "unknown"})`);
	else if (result.stop_reason) lines.push(`stop_reason: ${result.stop_reason}`);
	for (const step of result.steps) {
		lines.push(`step ${step.index} ${step.type}: ${step.outcome} — ${step.diagnostics.join("; ")}`);
		for (const diagnostic of step.expectation?.diagnostics ?? []) lines.push(`  ${diagnostic}`);
	}
	if (result.final_expectation) {
		lines.push(`final expectation: ${result.final_expectation.status}`);
		for (const diagnostic of result.final_expectation.diagnostics) lines.push(`  ${diagnostic}`);
	}
	if (result.successor.status === "unavailable") {
		lines.push(`successor unavailable: ${result.successor.error}`);
		return boundedBrowserActOutput(lines);
	}
	const { diff } = result.successor;
	const addedCount = diff.added.reduce((total, entry) => total + entry.count, 0);
	const removedCount = diff.removed.reduce((total, entry) => total + entry.count, 0);
	lines.push(`successor: ${result.successor.title} (${result.successor.url})`);
	lines.push(`diff: ${diff.changed ? `+${addedCount} -${removedCount}` : "unchanged"}`);
	if (diff.url) lines.push(`  url: ${diff.url.before} -> ${diff.url.after}`);
	if (diff.title) lines.push(`  title: ${diff.title.before} -> ${diff.title.after}`);
	const changes = [
		...diff.added.map((entry) => `  + ${entry.line}${entry.count === 1 ? "" : ` ×${entry.count}`}`),
		...diff.removed.map((entry) => `  - ${entry.line}${entry.count === 1 ? "" : ` ×${entry.count}`}`),
	];
	let emittedChars = 0;
	let emittedEntries = 0;
	for (const change of changes) {
		if (emittedEntries >= BROWSER_ACT_DIFF_ENTRY_LIMIT || emittedChars + change.length > BROWSER_ACT_DIFF_CHAR_LIMIT) break;
		lines.push(change);
		emittedEntries += 1;
		emittedChars += change.length;
	}
	if (emittedEntries < changes.length) lines.push(`  … ${changes.length - emittedEntries} more diff entries omitted`);
	lines.push(result.successor.text);
	return boundedBrowserActOutput(lines);
}

function boundedBrowserActOutput(lines: readonly string[]): string {
	const output = lines.join("\n");
	if (output.length <= BROWSER_ACT_RESULT_CHAR_LIMIT) return output;
	return `${output.slice(0, BROWSER_ACT_RESULT_CHAR_LIMIT)}\n… browser_act output truncated at ${BROWSER_ACT_RESULT_CHAR_LIMIT} characters`;
}
