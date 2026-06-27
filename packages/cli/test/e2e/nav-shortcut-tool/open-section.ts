import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Meta-agent-authored learned tool: `open_section`.
 *
 * Stands in for what a self-improve meta-agent would write after watching an
 * agent reach a deep settings page the slow way: a goto to the site root
 * followed by a chain of menu clicks (menu -> submenu -> the settings entry).
 * The meta-agent notices the destination of that drill-down is a stable deep
 * URL and distills the section -> URL mapping it observed, so the next run
 * navigates straight there in one call instead of replaying the click chain.
 *
 * Why a plain JSON-Schema object literal and `import type` only: the file is
 * loaded from an isolated temp directory by the jiti loader, which resolves
 * imports relative to that directory, not the cua workspace. A runtime import of
 * a workspace package would be unresolvable there. Keeping the import type-only
 * (erased at load) and declaring parameters inline avoids any runtime resolution.
 *
 * Why pure JS rather than playwright_execute: this is a navigation/deep-link
 * resolver, not a DOM parse or page script. The map below is the destination
 * knowledge the meta-agent learned by observing the first run's drill-down, and
 * resolving a section name against it is the real routine the learned tool runs.
 * The `navigate to <url>` plan it returns is what the next run issues in place of
 * the goto-plus-clicks chain.
 */

// The section -> deep-URL map the meta-agent distilled from the observed
// drill-down. Baked into the tool because the destination is stable across runs
// — this resolved URL is the artifact a self-improve pass produces.
const SECTIONS: Record<string, string> = {
	settings: "https://app.test/settings/profile",
};

export default function openSection(pi: ExtensionAPI): void {
	let agentRuns = 0;

	pi.on("agent_start", () => {
		agentRuns += 1;
	});

	pi.on("agent_end", (_event, ctx) => {
		// Headless host: ctx.hasUI is false, so this notify never fires here. The
		// guard keeps the same extension usable under a TUI host unchanged.
		if (ctx.hasUI) ctx.ui.notify(`section navigations: ${agentRuns}`, "info");
	});

	pi.registerTool({
		name: "open_section",
		label: "Open section",
		description:
			"Resolve a known section name to its deep URL and navigate there in one " +
			"call. Replaces a goto-to-root plus a menu/submenu click chain with a " +
			"single deep-link navigation.",
		parameters: {
			type: "object",
			properties: {
				section: {
					type: "string",
					description: "Name of the section to open, e.g. 'settings'.",
				},
			},
			required: ["section"],
			additionalProperties: false,
		},
		async execute(_toolCallId, params) {
			const { section } = params as { section: string };
			const url = SECTIONS[section];
			if (!url) {
				// Degrade safely on an unknown section instead of guessing a URL:
				// report the miss so the agent can fall back to manual navigation.
				return {
					content: [{ type: "text", text: `no known deep link for section: ${section}` }],
					details: { found: false, section, agentRuns },
				};
			}
			return {
				content: [{ type: "text", text: `navigate to ${url}` }],
				details: { found: true, section, url, agentRuns },
			};
		},
	});
}
