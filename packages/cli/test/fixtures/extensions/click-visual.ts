import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Example pi extension exercising both Tier-A primitives the host proves:
 * event subscription (`pi.on`) and tool registration (`pi.registerTool`).
 *
 * Parameters are declared as a plain JSON Schema object so the extension has no
 * runtime imports: it is loaded from an arbitrary directory by the jiti loader,
 * which resolves imports relative to that directory, not the cua workspace.
 *
 * Safe headless: the `agent_end` notification is guarded by `ctx.hasUI`, which
 * is false under the host's no-op UI context, so it never runs in print mode.
 * The `click_visual` tool reports the bridged `agent_start` count so a test can
 * observe that harness events reach extension handlers.
 */
export default function clickVisual(pi: ExtensionAPI): void {
	let agentRuns = 0;

	pi.on("agent_start", () => {
		agentRuns += 1;
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.notify(`agent runs: ${agentRuns}`, "info");
	});

	pi.registerTool({
		name: "click_visual",
		label: "Click (visual)",
		description: "Stub: click an on-screen element by visual description.",
		parameters: {
			type: "object",
			properties: {
				description: { type: "string", description: "What to click" },
			},
			required: ["description"],
			additionalProperties: false,
		},
		async execute(_toolCallId, params) {
			const description = (params as { description: string }).description;
			return {
				content: [{ type: "text", text: `would click: ${description} (runs=${agentRuns})` }],
				details: { agentRuns },
			};
		},
	});
}
