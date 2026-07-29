import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { CuaModelInfo, CuaModelRef } from "@onkernel/cua-ai";
import { colors } from "./themes";

/** Rows shown at once in a picker list, matching pi's model selector. */
export const PICKER_MAX_VISIBLE = 10;

/**
 * Fit a picker's list to the viewport. A picker replaces the editor, so a tall
 * frame on a short terminal would push its own footer off-screen; cap the list
 * instead of letting the frame overflow.
 */
export function fitMaxVisible(terminalRows: number, reservedRows: number, cap = PICKER_MAX_VISIBLE): number {
	return Math.max(3, Math.min(cap, terminalRows - reservedRows));
}

/**
 * cua-ref analogue of pi's `getModelSelectorSearchText`. Provider is repeated
 * and the bare model id kept out of leading position for the same reason pi
 * does it: a provider-qualified query should outrank an incidental substring
 * match on another provider's id.
 */
export function modelSearchText(item: CuaModelInfo): string {
	return `${item.provider} ${item.ref} ${item.provider} ${item.model}${item.name ? ` ${item.name}` : ""}`;
}

/**
 * Current model first, then {@link listCuaModels}' own order (provider order
 * from `CUA_PROVIDERS`, then model id). pi sorts by provider name; keeping
 * cua's catalog order instead means the picker lists models exactly like
 * `cua models` does.
 */
export function sortModelsForPicker(items: readonly CuaModelInfo[], currentRef: string | undefined): CuaModelInfo[] {
	const current = items.filter((item) => item.ref === currentRef);
	const rest = items.filter((item) => item.ref !== currentRef);
	return [...current, ...rest];
}

/** Fuzzy-filter over {@link modelSearchText}; an empty query keeps every row. */
export function filterModelsForPicker(items: readonly CuaModelInfo[], query: string): CuaModelInfo[] {
	return query ? fuzzyFilter([...items], query, modelSearchText) : [...items];
}

/** Wrap-around cursor movement; a no-op on an empty list. */
export function moveSelection(index: number, delta: 1 | -1, length: number): number {
	if (length === 0) return 0;
	if (delta === -1) return index === 0 ? length - 1 : index - 1;
	return index === length - 1 ? 0 : index + 1;
}

/** Keep the cursor inside a list that just shrank. */
export function clampSelection(index: number, length: number): number {
	return Math.max(0, Math.min(index, length - 1));
}

/** Centred-cursor scroll window, matching pi's model selector arithmetic. */
export function visibleWindow(
	selectedIndex: number,
	length: number,
	maxVisible: number = PICKER_MAX_VISIBLE,
): { start: number; end: number } {
	const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), length - maxVisible));
	return { start, end: Math.min(start + maxVisible, length) };
}

export interface ModelPickerConfig {
	tui: TUI;
	/** Active ref, rendered with a ✓ and sorted first. Undefined when unresolvable. */
	currentRef: CuaModelRef | undefined;
	items: readonly CuaModelInfo[];
	onSelect: (ref: CuaModelRef) => void;
	onCancel: () => void;
	/** Prefills the search box, as pi does for an unmatched `/model <arg>`. */
	initialSearch?: string;
	/** List height; defaults to pi's 10. See {@link fitMaxVisible}. */
	maxVisible?: number;
}

/**
 * Searchable model picker modelled on pi's `ModelSelectorComponent`: same
 * frame, same bare search input, same 10-row centred scroll window, same
 * `→ `/`[provider]`/` ✓` row format, same wrap-around navigation and
 * single-press cancel.
 *
 * Deliberate differences from pi: cua's catalog ({@link listCuaModels}) is a
 * static synchronous table, so there is no background refresh, no abort
 * controller and no refresh status line; and selecting a model never writes
 * pi's global `settings.json` — persistence is the caller's business.
 */
export class ModelPickerComponent extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly currentRef: CuaModelRef | undefined;
	private readonly allModels: readonly CuaModelInfo[];
	private readonly onSelectCallback: (ref: CuaModelRef) => void;
	private readonly onCancelCallback: () => void;
	private readonly searchInput: Input;
	private readonly listContainer: Container;
	private readonly hintText: Text;
	private filtered: CuaModelInfo[];
	private selectedIndex = 0;
	private readonly maxVisible: number;

	// Focusable: propagate to the search input so the hardware cursor (and IME
	// composition) lands in the search box, per pi's container-with-input pattern.
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(config: ModelPickerConfig) {
		super();
		this.tui = config.tui;
		this.currentRef = config.currentRef;
		this.allModels = sortModelsForPicker(config.items, config.currentRef);
		this.onSelectCallback = config.onSelect;
		this.onCancelCallback = config.onCancel;
		this.maxVisible = config.maxVisible ?? PICKER_MAX_VISIBLE;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.hintText = new Text(this.getHintText(), 0, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (config.initialSearch) this.searchInput.setValue(config.initialSearch);
		this.searchInput.onSubmit = () => {
			const item = this.filtered[this.selectedIndex];
			if (item) this.handleSelect(item);
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.filtered = filterModelsForPicker(this.allModels, config.initialSearch ?? "");
		const currentIndex = this.filtered.findIndex((item) => item.ref === this.currentRef);
		this.selectedIndex = currentIndex >= 0 ? currentIndex : clampSelection(0, this.filtered.length);
		this.updateList();
	}

	/**
	 * Themed strings are baked into child `Text` nodes, so a theme change has
	 * to rebuild them. pi's own model selector omits this; cua does it so the
	 * picker repaints correctly.
	 */
	override invalidate(): void {
		super.invalidate();
		this.hintText.setText(this.getHintText());
		this.updateList();
	}

	private getHintText(): string {
		return colors.warning(
			"Showing every CUA-capable model. The provider's API key must be set; run `cua models` for the catalog.",
		);
	}

	private filterModels(query: string): void {
		this.filtered = filterModelsForPicker(this.allModels, query);
		this.selectedIndex = clampSelection(this.selectedIndex, this.filtered.length);
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		const { start, end } = visibleWindow(this.selectedIndex, this.filtered.length, this.maxVisible);
		for (let i = start; i < end; i += 1) {
			const item = this.filtered[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			const badge = colors.muted(`[${item.provider}]`);
			const check = item.ref === this.currentRef ? colors.success(" ✓") : "";
			const label = isSelected ? colors.accent("→ ") + colors.accent(item.model) : `  ${item.model}`;
			this.listContainer.addChild(new Text(`${label} ${badge}${check}`, 0, 0));
		}
		if (start > 0 || end < this.filtered.length) {
			this.listContainer.addChild(
				new Text(colors.muted(`  (${this.selectedIndex + 1}/${this.filtered.length})`), 0, 0),
			);
		}
		if (this.filtered.length === 0) {
			this.listContainer.addChild(new Text(colors.muted("  No matching models"), 0, 0));
		} else {
			const selected = this.filtered[this.selectedIndex];
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(colors.muted(`  Model Name: ${selected?.name ?? ""}`), 0, 0));
			this.listContainer.addChild(new Text(colors.muted(`  Ref: ${selected?.ref ?? ""}`), 0, 0));
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			if (this.filtered.length === 0) return;
			this.selectedIndex = moveSelection(this.selectedIndex, -1, this.filtered.length);
			this.updateList();
		} else if (kb.matches(data, "tui.select.down")) {
			if (this.filtered.length === 0) return;
			this.selectedIndex = moveSelection(this.selectedIndex, 1, this.filtered.length);
			this.updateList();
		} else if (kb.matches(data, "tui.select.confirm")) {
			const item = this.filtered[this.selectedIndex];
			if (item) this.handleSelect(item);
			return;
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		} else {
			this.searchInput.handleInput(data);
			this.filterModels(this.searchInput.getValue());
		}
		this.tui.requestRender();
	}

	private handleSelect(item: CuaModelInfo): void {
		this.onSelectCallback(item.ref);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
