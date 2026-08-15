import type { Api, Model } from "@earendil-works/pi-ai";
import { compileLoopToolCatalog, loop, loopToolMenu, type LoopToolCatalog, type LoopToolSpec } from "@onkernel/loop";

type Coordinates = "pixels" | "normalized-1000";
type CoordinateSystem = ReturnType<typeof loop.coordinates.pixels> | ReturnType<typeof loop.coordinates.normalized>;

export interface LoopSelection {
	selectors: readonly string[];
	coordinates: Coordinates;
}

const BROWSER_BATCH_ACTIONS = [
	"snapshot", "text", "find", "click", "hover", "drag", "fill", "scroll_to", "scroll",
	"type", "key", "navigate", "list_tabs", "new_tab", "screenshot", "evaluate", "wait_for",
] as const;
const COMPUTER_BATCH_ACTIONS = [
	"click", "double_click", "mouse_down", "mouse_up", "type", "keypress", "scroll", "move",
	"drag", "wait", "screenshot", "zoom", "goto", "back", "forward", "url", "cursor_position",
] as const;

/**
 * The menu: one entry per capability a caller would actually choose between.
 *
 * Entries are capabilities, not packaging. Earlier revisions also offered `mixed`,
 * the two batch tools on their own, and all 37 individual tool names — which made
 * the menu long without offering anything the entries below do not already cover.
 * The batch tool now ships inside its generic entry, so selecting `browser` gets
 * both the primitives and the one-call batch form of them.
 *
 * Provider-native entries reach the wire because the extension owns the stream for
 * the providers it registers: it swaps pi's registry model for the compiled
 * catalog's model, which carries the transport the selected tools derive, and
 * passes the incoming native-call plan.
 */
const MENU: Readonly<Record<string, (coordinates: CoordinateSystem) => LoopToolSpec[]>> = Object.freeze({
	browser: () => [...loop.toolsets.browser(), loop.tools.browser.batch({ actions: BROWSER_BATCH_ACTIONS })],
	computer: (coordinates) => [
		...loop.toolsets.computer({ coordinates }),
		loop.tools.computer.batch({ actions: COMPUTER_BATCH_ACTIONS, coordinates }),
	],
	"browser-act": () => [loop.tools.browser.act()],
	playwright: () => [loop.tools.playwright()],
	"anthropic-computer": () => [loop.providers.anthropic.tools.computer({ version: "20260701", enableZoom: true })],
	"anthropic-browser": () => [loop.providers.anthropic.tools.browser({ version: "20260701", javascript: true })],
	"openai-computer": () => [loop.providers.openai.tools.computer()],
	"google-browser": () => loop.providers.google.toolsets.browser(),
});

export const LOOP_SELECTORS: readonly string[] = Object.freeze(Object.keys(MENU));

export function parseSelection(value: string | undefined, coordinates: string | undefined): LoopSelection {
	const coordinateMode = coordinates ?? "pixels";
	if (coordinateMode !== "pixels" && coordinateMode !== "normalized-1000") {
		throw new Error('--browser-coordinates must be "pixels" or "normalized-1000"');
	}
	const selectors =
		value
			?.split(",")
			.map((item) => item.trim())
			.filter(Boolean) ?? [];
	if (new Set(selectors).size !== selectors.length) throw new Error("--browser-tools contains duplicate selectors");
	for (const selector of selectors) {
		if (!LOOP_SELECTORS.includes(selector)) throw new Error(`unknown browser tool selector "${selector}"`);
	}
	return Object.freeze({ selectors: Object.freeze(selectors), coordinates: coordinateMode });
}

/**
 * Every tool any menu entry can contribute, for the up-front registration pi
 * requires before a tool can be activated. Keyed by model-facing name, so the
 * two providers that both call their native tool `computer` collapse to one
 * registration — harmless, because a native declaration is replaced by the
 * catalog's payload transform and only the selected spec is ever executed.
 */
export function allSelectableSpecs(coordinates: Coordinates): LoopToolSpec[] {
	const result = new Map<string, LoopToolSpec>();
	for (const selector of LOOP_SELECTORS) {
		for (const spec of expandSelection(parseSelection(selector, coordinates))) result.set(spec.name, spec);
	}
	return [...result.values()];
}

export function expandSelection(selection: LoopSelection): LoopToolSpec[] {
	const coordinates = selection.coordinates === "pixels" ? loop.coordinates.pixels() : loop.coordinates.normalized([0, 1000]);
	const result: LoopToolSpec[] = [];
	for (const selector of selection.selectors) {
		const entry = MENU[selector];
		if (!entry) throw new Error(`unknown browser tool selector "${selector}"`);
		result.push(...entry(coordinates));
	}
	const identities = new Set<string>();
	for (const spec of result) {
		if (identities.has(spec.identity)) throw new Error(`selection contains duplicate tool identity "${spec.identity}"`);
		identities.add(spec.identity);
	}
	return result;
}

/**
 * Compile a selection for a model. Declaration-only and browser-free, which is
 * what lets the extension validate a selection and generate headers before any
 * browser exists.
 */
export function compileSpecs(model: Model<Api>, specs: readonly LoopToolSpec[]): LoopToolCatalog<Model<Api>> {
	return compileLoopToolCatalog({ model, requestedTools: specs });
}

export interface SelectorAvailability {
	readonly selector: string;
	readonly tools: readonly string[];
	readonly available: boolean;
	readonly reason?: string;
	readonly selected: boolean;
	/** Selectors this one cannot be combined with for this model. */
	readonly conflictsWith: readonly string[];
}

/**
 * Every selector marked available or not for a model, decided by compiling that
 * selector *on its own*.
 *
 * Standalone is the right question here, and getting it wrong was a real bug: an
 * earlier version passed the current selection to `loopToolMenu`, whose verdicts
 * are deliberately pairwise — relative to what is already selected. When the
 * current selection itself failed to compile, that failure became the reason on
 * every row, including rows that then activated fine. The one command whose job
 * is "tell me what this model can take" misled precisely when it was needed.
 *
 * Pairwise conflicts still exist — Anthropic's native browser and computer cannot
 * coexist, and two providers' natives never can — so `conflictsWith` reports what
 * a selector cannot be *combined* with, separately from whether it is available.
 */
export function selectorAvailability(model: Model<Api>, selection: LoopSelection): SelectorAvailability[] {
	const selected = new Set(selection.selectors);
	return LOOP_SELECTORS.map((selector) => {
		const specs = expandSelection({ selectors: [selector], coordinates: selection.coordinates });
		const tools = specs.map((spec) => spec.name);
		const conflictsWith = LOOP_SELECTORS.filter((other) => {
			if (other === selector) return false;
			try {
				compileSpecs(model, expandSelection({ selectors: [selector, other], coordinates: selection.coordinates }));
				return false;
			} catch {
				// Only a genuine pairwise conflict counts: if `other` cannot compile on
				// its own, the pair failing says nothing about this selector.
				try {
					compileSpecs(model, expandSelection({ selectors: [other], coordinates: selection.coordinates }));
					return true;
				} catch {
					return false;
				}
			}
		});
		try {
			compileSpecs(model, specs);
			return { selector, tools, available: true, selected: selected.has(selector), conflictsWith };
		} catch (error) {
			return { selector, tools, available: false, reason: message(error), selected: selected.has(selector), conflictsWith };
		}
	});
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
