import { getKeybindings, type Keybinding, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

/**
 * cua-specific keybinding ids, merged into pi-tui's global registry via
 * declaration merging (the mechanism pi-tui documents for downstream packages).
 * Without this augmentation `getKeybindings().matches(data, "cua.tools.…")`
 * would not type-check, and without {@link installCuaKeybindings} it would
 * silently return false because the lazily-built default manager only knows
 * {@link TUI_KEYBINDINGS}.
 */
declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"cua.tools.enableAll": true;
		"cua.tools.clearAll": true;
		"cua.tools.reset": true;
		"cua.tools.apply": true;
	}
}

/**
 * pi-tui's base bindings plus the bulk actions the `/tools` picker needs.
 * `ctrl+a` / `ctrl+x` / `ctrl+s` deliberately match pi's own
 * `app.models.enableAll` / `clearAll` / `save` defaults so the two selectors
 * feel identical; `ctrl+r` is cua-specific.
 */
export const CUA_TUI_KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	"cua.tools.enableAll": { defaultKeys: "ctrl+a", description: "Enable all listed tools" },
	"cua.tools.clearAll": { defaultKeys: "ctrl+x", description: "Disable all listed tools" },
	"cua.tools.reset": { defaultKeys: "ctrl+r", description: "Reset tools to the model defaults" },
	"cua.tools.apply": { defaultKeys: "ctrl+s", description: "Apply the staged tool selection" },
} as const;

/**
 * Publish {@link CUA_TUI_KEYBINDINGS} as the process-wide manager. Must run
 * before any component calls `getKeybindings()`, i.e. at TUI startup.
 */
export function installCuaKeybindings(): void {
	setKeybindings(new KeybindingsManager(CUA_TUI_KEYBINDINGS));
}

/**
 * Render the keys bound to `id` for a hint line.
 *
 * pi-coding-agent's own `keyText()` is not usable here: it reads the keybinding
 * registry through its own module instance of pi-tui, which is not the instance
 * {@link installCuaKeybindings} writes to, so cua-specific ids resolve to an
 * empty string there. Reading through the same import we register with keeps
 * the hints consistent with what {@link getKeybindings} actually matches.
 */
export function cuaKeyText(id: Keybinding): string {
	const bound = getKeybindings().getKeys(id);
	const keys = bound.length > 0 ? bound : normalizeDefaultKeys(id);
	return keys.join("/");
}

function normalizeDefaultKeys(id: Keybinding): string[] {
	const definition = (CUA_TUI_KEYBINDINGS as Record<string, { defaultKeys: string | readonly string[] }>)[id];
	if (!definition) return [];
	return Array.isArray(definition.defaultKeys) ? [...definition.defaultKeys] : [definition.defaultKeys as string];
}
