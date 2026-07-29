import { beforeAll, describe, expect, it } from "vitest";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { installCuaKeybindings } from "../src/tui/keybindings";
import { ToolsPickerComponent } from "../src/tui/tools-picker";
import type { ToolSelectionItem } from "../src/tui/tool-selection";

/**
 * The picker only ever calls `requestRender()` on its TUI, so a counter stands
 * in for the real terminal and keeps these tests free of a PTY.
 */
function fakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

const items: readonly ToolSelectionItem[] = [
	{ key: "cua.browser.snapshot", label: "browser_snapshot", group: "cua", description: "Capture a page snapshot" },
	{ key: "cua.browser.act", label: "browser_act", group: "cua", description: "Run an action plan" },
	{ key: "caller.read_file", label: "read_file", group: "application", description: "Read a stale ref safely" },
];

interface Harness {
	picker: ToolsPickerComponent;
	applied: ReadonlySet<string>[];
	cancels: number;
}

function mount(enabled: readonly string[] = items.map((item) => item.key)): Harness {
	installCuaKeybindings();
	const applied: ReadonlySet<string>[] = [];
	let cancels = 0;
	const picker = new ToolsPickerComponent({
		tui: fakeTui(),
		items,
		enabledKeys: new Set(enabled),
		defaultKeys: new Set(items.map((item) => item.key)),
		onApply: (next) => applied.push(next),
		onCancel: () => {
			cancels += 1;
		},
	});
	return {
		picker,
		applied,
		get cancels() {
			return cancels;
		},
	};
}

const CTRL_A = "\x01";
const CTRL_C = "\x03";
const CTRL_S = "\x13";
const CTRL_X = "\x18";
const ESCAPE = "\x1b";
const ENTER = "\r";

// The picker bakes themed strings into its Text children, so the theme has to
// exist before one is constructed — exactly as `runInteractive` arranges.
beforeAll(() => {
	initTheme();
});

describe("ToolsPickerComponent input handling", () => {
	it("toggles on space while the search box is empty", () => {
		const h = mount();
		h.picker.handleInput(" ");
		h.picker.handleInput(CTRL_S);
		// The first row was toggled off, not typed into the search box.
		expect(h.picker.getSearchInput().getValue()).toBe("");
		expect([...(h.applied[0] ?? [])]).toEqual(["cua.browser.act", "caller.read_file"]);
	});

	it("types spaces into a non-empty search instead of toggling", () => {
		const h = mount();
		// Descriptions are searchable, so a multi-word query has to be typeable.
		for (const ch of "stale ref") h.picker.handleInput(ch);
		expect(h.picker.getSearchInput().getValue()).toBe("stale ref");
		h.picker.handleInput(CTRL_S);
		// Nothing was toggled: the space landed in the query.
		expect([...(h.applied[0] ?? [])].sort()).toEqual(items.map((item) => item.key).sort());
	});

	it("still toggles with enter while a search is active", () => {
		const h = mount();
		for (const ch of "stale ref") h.picker.handleInput(ch);
		h.picker.handleInput(ENTER);
		h.picker.handleInput(CTRL_S);
		expect([...(h.applied[0] ?? [])]).toEqual(["cua.browser.snapshot", "cua.browser.act"]);
	});

	it("clears an active search on ctrl+c before cancelling", () => {
		const h = mount();
		for (const ch of "act") h.picker.handleInput(ch);
		h.picker.handleInput(CTRL_C);
		expect(h.picker.getSearchInput().getValue()).toBe("");
		expect(h.cancels).toBe(0);
		// A second ctrl+c, with the search empty, cancels.
		h.picker.handleInput(CTRL_C);
		expect(h.cancels).toBe(1);
	});

	it("cancels on escape even with an active search", () => {
		const h = mount();
		for (const ch of "act") h.picker.handleInput(ch);
		h.picker.handleInput(ESCAPE);
		expect(h.cancels).toBe(1);
		expect(h.applied).toHaveLength(0);
	});

	it("never applies on cancel", () => {
		const h = mount();
		h.picker.handleInput(" ");
		h.picker.handleInput(ESCAPE);
		expect(h.applied).toHaveLength(0);
	});

	it("scopes bulk actions to an active filter", () => {
		const h = mount([]);
		for (const ch of "browser") h.picker.handleInput(ch);
		h.picker.handleInput(CTRL_A);
		h.picker.handleInput(CTRL_S);
		// read_file was filtered out, so ctrl+a left it disabled.
		expect([...(h.applied[0] ?? [])].sort()).toEqual(["cua.browser.act", "cua.browser.snapshot"]);
	});

	it("clears every listed row with ctrl+x and allows an empty selection", () => {
		const h = mount();
		h.picker.handleInput(CTRL_X);
		h.picker.handleInput(CTRL_S);
		expect([...(h.applied[0] ?? [])]).toEqual([]);
	});

	it("honours a rebound tui.select.cancel so the footer hint stays truthful", () => {
		const h = mount();
		const kb = getKeybindings();
		try {
			kb.setUserBindings({ "tui.select.cancel": "ctrl+g" });
			// The rebound key cancels...
			h.picker.handleInput("\x07");
			expect(h.cancels).toBe(1);
			// ...and the key it replaced no longer does.
			h.picker.handleInput("\x1b");
			expect(h.cancels).toBe(1);
		} finally {
			kb.setUserBindings({});
		}
	});
});
