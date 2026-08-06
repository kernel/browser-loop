import type { BrowserStatus } from "./browser-runtime";

export function statusText(selectors: readonly string[], active: readonly string[], browser: BrowserStatus, error?: string): string {
	const tools = active.length ? active.join(", ") : "none";
	const browserText = browser.sessionId
		? `${browser.owned ? "owned" : "attached"} ${browser.sessionId}${browser.liveUrl ? ` ${browser.liveUrl}` : ""}`
		: "not provisioned";
	return `cua: selected=${selectors.join(",") || "none"}; active=${tools}; browser=${browserText}${error ? `; unavailable=${error}` : ""}`;
}
