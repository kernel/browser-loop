import type { Api, Model } from "@earendil-works/pi-ai";
import { compileCuaToolCatalog, cua, type CuaToolCatalog, type CuaToolSpec } from "@onkernel/cua-ai";

export const BROWSER_BATCH_ACTIONS = [
	"snapshot",
	"text",
	"find",
	"click",
	"hover",
	"drag",
	"fill",
	"scroll_to",
	"scroll",
	"type",
	"key",
	"navigate",
	"list_tabs",
	"new_tab",
	"screenshot",
	"evaluate",
	"wait_for",
] as const;
export const COMPUTER_BATCH_ACTIONS = [
	"click",
	"double_click",
	"mouse_down",
	"mouse_up",
	"type",
	"keypress",
	"scroll",
	"move",
	"drag",
	"wait",
	"screenshot",
	"zoom",
	"goto",
	"back",
	"forward",
	"url",
	"cursor_position",
] as const;

type Coordinates = "pixels" | "normalized-1000";
type CoordinateSystem = ReturnType<typeof cua.coordinates.pixels> | ReturnType<typeof cua.coordinates.normalized>;

export interface CuaSelection {
	selectors: readonly string[];
	coordinates: Coordinates;
}

const generalTools = Object.freeze({
	browser_snapshot: () => cua.tools.browser.snapshot(),
	browser_text: () => cua.tools.browser.text(),
	browser_find: () => cua.tools.browser.find(),
	browser_click: () => cua.tools.browser.click(),
	browser_hover: () => cua.tools.browser.hover(),
	browser_drag: () => cua.tools.browser.drag(),
	browser_fill: () => cua.tools.browser.fill(),
	browser_scroll_to: () => cua.tools.browser.scrollTo(),
	browser_scroll: () => cua.tools.browser.scroll(),
	browser_type: () => cua.tools.browser.type(),
	browser_key: () => cua.tools.browser.key(),
	browser_navigate: () => cua.tools.browser.navigate(),
	browser_list_tabs: () => cua.tools.browser.listTabs(),
	browser_new_tab: () => cua.tools.browser.newTab(),
	browser_screenshot: () => cua.tools.browser.screenshot(),
	browser_evaluate: () => cua.tools.browser.evaluate(),
	browser_wait_for: () => cua.tools.browser.waitFor(),
	browser_act: () => cua.tools.browser.act(),
	playwright_execute: () => cua.tools.playwright(),
});

const computerTools = Object.freeze({
	computer_click: (coordinates: CoordinateSystem) => cua.tools.computer.click({ coordinates }),
	computer_double_click: (coordinates: CoordinateSystem) => cua.tools.computer.doubleClick({ coordinates }),
	computer_mouse_down: (coordinates: CoordinateSystem) => cua.tools.computer.mouseDown({ coordinates }),
	computer_mouse_up: (coordinates: CoordinateSystem) => cua.tools.computer.mouseUp({ coordinates }),
	computer_type: (coordinates: CoordinateSystem) => cua.tools.computer.type({ coordinates }),
	computer_keypress: (coordinates: CoordinateSystem) => cua.tools.computer.keypress({ coordinates }),
	computer_scroll: (coordinates: CoordinateSystem) => cua.tools.computer.scroll({ coordinates }),
	computer_move: (coordinates: CoordinateSystem) => cua.tools.computer.move({ coordinates }),
	computer_drag: (coordinates: CoordinateSystem) => cua.tools.computer.drag({ coordinates }),
	computer_wait: (coordinates: CoordinateSystem) => cua.tools.computer.wait({ coordinates }),
	computer_screenshot: (coordinates: CoordinateSystem) => cua.tools.computer.screenshot({ coordinates }),
	computer_zoom: (coordinates: CoordinateSystem) => cua.tools.computer.zoom({ coordinates }),
	computer_goto: (coordinates: CoordinateSystem) => cua.tools.computer.goto({ coordinates }),
	computer_back: (coordinates: CoordinateSystem) => cua.tools.computer.back({ coordinates }),
	computer_forward: (coordinates: CoordinateSystem) => cua.tools.computer.forward({ coordinates }),
	computer_url: (coordinates: CoordinateSystem) => cua.tools.computer.url({ coordinates }),
	computer_cursor_position: (coordinates: CoordinateSystem) => cua.tools.computer.cursorPosition({ coordinates }),
});

export const CUA_TOOL_NAMES = Object.freeze([...Object.keys(generalTools), ...Object.keys(computerTools)]);
export const CUA_SELECTORS = Object.freeze([
	"browser",
	"computer",
	"mixed",
	"browser-act",
	"browser-batch",
	"computer-batch",
	"playwright",
	"anthropic-computer",
	...CUA_TOOL_NAMES,
]);

export function parseSelection(value: string | undefined, coordinates: string | undefined): CuaSelection {
	const coordinateMode = coordinates ?? "pixels";
	if (coordinateMode !== "pixels" && coordinateMode !== "normalized-1000") {
		throw new Error('--cua-coordinates must be "pixels" or "normalized-1000"');
	}
	const selectors =
		value
			?.split(",")
			.map((item) => item.trim())
			.filter(Boolean) ?? [];
	if (new Set(selectors).size !== selectors.length) throw new Error("--cua-tools contains duplicate selectors");
	for (const selector of selectors) {
		if (!CUA_SELECTORS.includes(selector)) throw new Error(`unknown CUA tool selector "${selector}"`);
	}
	return Object.freeze({ selectors: Object.freeze(selectors), coordinates: coordinateMode });
}

/** Every function tool that can be selected, with declarations for one coordinate mode. */
export function allSelectableSpecs(coordinates: Coordinates): CuaToolSpec[] {
	const result = new Map<string, CuaToolSpec>();
	for (const selector of CUA_SELECTORS) {
		for (const spec of expandSelection(parseSelection(selector, coordinates))) result.set(spec.name, spec);
	}
	return [...result.values()];
}

export function expandSelection(selection: CuaSelection): CuaToolSpec[] {
	const coordinates = selection.coordinates === "pixels" ? cua.coordinates.pixels() : cua.coordinates.normalized([0, 1000]);
	const result: CuaToolSpec[] = [];
	for (const selector of selection.selectors) {
		switch (selector) {
			case "browser":
				result.push(...cua.toolsets.browser());
				break;
			case "computer":
				result.push(...cua.toolsets.computer({ coordinates }));
				break;
			case "mixed":
				result.push(...cua.toolsets.mixed({ coordinates }));
				break;
			case "browser-act":
				result.push(cua.tools.browser.act());
				break;
			case "browser-batch":
				result.push(cua.tools.browser.batch({ actions: BROWSER_BATCH_ACTIONS }));
				break;
			case "computer-batch":
				result.push(cua.tools.computer.batch({ actions: COMPUTER_BATCH_ACTIONS, coordinates }));
				break;
			case "playwright":
				result.push(cua.tools.playwright());
				break;
			case "anthropic-computer":
				result.push(
					cua.providers.anthropic.tools.computer({ version: "20251124", displayWidth: 1920, displayHeight: 1080, enableZoom: true }),
				);
				break;
			default:
				result.push(createIndividualTool(selector, coordinates));
		}
	}
	const identities = new Set<string>();
	for (const spec of result) {
		if (identities.has(spec.identity)) throw new Error(`CUA selection contains duplicate tool identity "${spec.identity}"`);
		identities.add(spec.identity);
	}
	return result;
}

function createIndividualTool(name: string, coordinates: CoordinateSystem): CuaToolSpec {
	const createComputerTool = computerTools[name as keyof typeof computerTools];
	if (createComputerTool) return createComputerTool(coordinates);
	const createGeneralTool = generalTools[name as keyof typeof generalTools];
	if (createGeneralTool) return createGeneralTool();
	throw new Error(`unknown CUA tool selector "${name}"`);
}

export function compileSpecs(model: Model<Api>, specs: readonly CuaToolSpec[], viewport = { width: 1920, height: 1080 }): CuaToolCatalog {
	return compileCuaToolCatalog({ model, requestedTools: specs, viewport });
}

export function compileSelection(
	model: Model<Api>,
	selection: CuaSelection,
	viewport = { width: 1920, height: 1080 },
): { specs: CuaToolSpec[]; catalog: CuaToolCatalog } {
	const specs = expandSelection(selection);
	return { specs, catalog: compileSpecs(model, specs, viewport) };
}
