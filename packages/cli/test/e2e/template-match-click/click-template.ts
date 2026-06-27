import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Meta-agent-authored learned tool: `click_template`.
 *
 * Stands in for what a self-improve meta-agent writes after watching a
 * pixel-only agent hunt for the same visually-distinct control across runs:
 * screenshot, scroll, screenshot again, then click by a guessed coordinate.
 * After the first successful click the meta-agent persists a small crop of the
 * pixels around that click as a template, then authors this tool to locate that
 * template in the current frame and return the exact click coordinate. The next
 * run collapses the screenshot/scroll/screenshot/click hunt into one call.
 *
 * Why a plain JSON-Schema object literal and `import type` only: the file is
 * loaded from an isolated temp directory by the jiti loader, which resolves
 * imports relative to that directory, not the cua workspace. A runtime import of
 * a workspace package would be unresolvable there and deadlocks the loader.
 * Keeping the import type-only (erased at load) and declaring parameters inline
 * avoids any runtime resolution.
 *
 * Why pure JS rather than driving the cursor: this test harness is built without
 * `playwright: true`, and the fake Kernel client exposes no real screenshot
 * pixels — its captureScreenshot/batch are reachable only through the base
 * computer tools, not from an extension tool. So the live frame and the saved
 * crop are passed in as grayscale `number[]` buffers (`screenshot`/`template`),
 * standing in for the captured frame and the persisted patch. Returning the
 * located coordinate (rather than moving the mouse) is the honest seam: an
 * extension tool produces data the agent acts on. The exact-match scan below is
 * the real routine the learned tool would run against captured pixels.
 */
export default function clickTemplate(pi: ExtensionAPI): void {
	let agentRuns = 0;

	pi.on("agent_start", () => {
		agentRuns += 1;
	});

	pi.on("agent_end", (_event, ctx) => {
		// Headless host: ctx.hasUI is false, so this notify never fires here. The
		// guard keeps the same extension usable under a TUI host unchanged.
		if (ctx.hasUI) ctx.ui.notify(`template clicks: ${agentRuns}`, "info");
	});

	pi.registerTool({
		name: "click_template",
		label: "Click by template match",
		description:
			"Locate a saved template patch in the current screenshot and return its " +
			"center as exact click coordinates. Replaces a scroll/screenshot hunt " +
			"for a fixed-icon control with one deterministic locate.",
		parameters: {
			type: "object",
			properties: {
				screenshot: {
					type: "array",
					items: { type: "number" },
					description: "Row-major grayscale pixels of the current frame",
				},
				hw: { type: "number", description: "Screenshot width in pixels" },
				hh: { type: "number", description: "Screenshot height in pixels" },
				template: {
					type: "array",
					items: { type: "number" },
					description: "Row-major grayscale pixels of the saved patch",
				},
				nw: { type: "number", description: "Template width in pixels" },
				nh: { type: "number", description: "Template height in pixels" },
			},
			required: ["screenshot", "hw", "hh", "template", "nw", "nh"],
			additionalProperties: false,
		},
		async execute(_toolCallId, params) {
			const p = params as {
				screenshot: number[];
				hw: number;
				hh: number;
				template: number[];
				nw: number;
				nh: number;
			};
			const hit = locate(p.screenshot, p.hw, p.hh, p.template, p.nw, p.nh);
			if (!hit) {
				return {
					content: [{ type: "text", text: "template not found" }],
					details: { found: false, agentRuns },
				};
			}
			return {
				content: [{ type: "text", text: `located at ${hit.x},${hit.y}` }],
				details: { found: true, x: hit.x, y: hit.y, agentRuns },
			};
		},
	});
}

/**
 * Exact-match scan of a row-major grayscale buffer for a template patch.
 *
 * Slides the `nw`x`nh` template over every position in the `hw`x`hh` haystack and
 * returns the patch center on the first exact pixel match, or `undefined` if the
 * patch is absent. The center is the click target: `floor(nw/2)`/`floor(nh/2)`
 * offset from the matched top-left, matching how a crop's anchor maps back to the
 * control's clickable middle. Exact match (not a similarity threshold) keeps the
 * result deterministic, which is the property the learned tool buys the next run.
 */
function locate(
	haystack: number[],
	hw: number,
	hh: number,
	needle: number[],
	nw: number,
	nh: number,
): { x: number; y: number } | undefined {
	if (nw <= 0 || nh <= 0 || nw > hw || nh > hh) return undefined;
	if (needle.length !== nw * nh || haystack.length !== hw * hh) return undefined;
	for (let oy = 0; oy <= hh - nh; oy++) {
		for (let ox = 0; ox <= hw - nw; ox++) {
			let match = true;
			for (let ty = 0; ty < nh && match; ty++) {
				for (let tx = 0; tx < nw; tx++) {
					if (haystack[(oy + ty) * hw + (ox + tx)] !== needle[ty * nw + tx]) {
						match = false;
						break;
					}
				}
			}
			if (match) return { x: ox + Math.floor(nw / 2), y: oy + Math.floor(nh / 2) };
		}
	}
	return undefined;
}
