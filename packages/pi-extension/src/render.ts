import type { BrowserStatus } from "./browser-runtime";
import type { SelectorAvailability } from "./selection";

export function statusText(selectors: readonly string[], active: readonly string[], browser: BrowserStatus, error?: string): string {
	const tools = active.length ? active.join(", ") : "none";
	const browserText = browser.sessionId
		? `${browser.owned ? "owned" : "attached"} ${browser.sessionId}${browser.liveUrl ? ` ${browser.liveUrl}` : ""}`
		: "not provisioned";
	return `cua: selected=${selectors.join(",") || "none"}; active=${tools}; browser=${browserText}${error ? `; unavailable=${error}` : ""}`;
}

/** One line per selector, so an unavailable one carries the compiler's own reason. */
export function availabilityText(entries: readonly SelectorAvailability[]): string {
	const lines = entries.map((entry) => {
		const mark = entry.selected ? "*" : " ";
		if (!entry.available) return `${mark} ${entry.selector} — unavailable: ${entry.reason ?? "unknown"}`;
		const conflict = entry.conflictsWith.length ? ` (cannot combine with ${entry.conflictsWith.join(", ")})` : "";
		return `${mark} ${entry.selector}${conflict}`;
	});
	return ["cua selectors for this model (* = selected):", ...lines].join("\n");
}
