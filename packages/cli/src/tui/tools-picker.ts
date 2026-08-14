import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { cuaKeyText } from "./keybindings";
import { clampSelection, moveSelection, PICKER_MAX_VISIBLE, visibleWindow } from "./model-picker";
import { colors } from "./themes";
import { disableTools, enableTools, sameSelection, toggleTool, toolSearchText, type ToolSelectionItem } from "./tool-selection";

export interface ToolsPickerConfig {
	tui: TUI;
	/** Baseline rows: every tool the application composed for this model. */
	items: readonly ToolSelectionItem[];
	/** Keys currently live on the harness. */
	enabledKeys: ReadonlySet<string>;
	/** The model defaults `ctrl+r` restores. */
	defaultKeys: ReadonlySet<string>;
	/**
	 * Rebuild the menu for a staged selection. Availability is pairwise — two
	 * providers' native surfaces cannot coexist, and a native surface pins the
	 * transport — so rows are re-evaluated after every toggle rather than fixed
	 * when the picker opens.
	 */
	restage?: (staged: ReadonlySet<string>) => ToolSelectionItem[];
	/** Fired on apply only. Never called on cancel. */
	onApply: (enabled: ReadonlySet<string>) => void;
	onCancel: () => void;
	/** List height; defaults to 10. See `fitMaxVisible`. */
	maxVisible?: number;
}

/**
 * Session-local tool enable/disable picker, shaped after pi's
 * `ScopedModelsSelectorComponent` (the closest analogue: multi-select,
 * session-only, ✓/✗ rows, bulk actions, an "N/M enabled" footer, and a
 * `Focusable` search input that keeps the hardware cursor correct).
 *
 * Edits are staged: nothing reaches `harness.setTools()` until the user
 * applies, and cancelling discards the staging set so live state is untouched.
 */
export class ToolsPickerComponent extends Container implements Focusable {
	private readonly tui: TUI;
	private items: readonly ToolSelectionItem[];
	private readonly liveKeys: ReadonlySet<string>;
	private readonly defaultKeys: ReadonlySet<string>;
	private readonly onApplyCallback: (enabled: ReadonlySet<string>) => void;
	private readonly restage?: (staged: ReadonlySet<string>) => ToolSelectionItem[];
	private readonly onCancelCallback: () => void;
	private readonly searchInput: Input;
	private readonly listContainer: Container;
	private readonly titleText: Text;
	private readonly subtitleText: Text;
	private readonly footerText: Text;
	private staged: Set<string>;
	private filtered: readonly ToolSelectionItem[];
	private selectedIndex = 0;
	private readonly maxVisible: number;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(config: ToolsPickerConfig) {
		super();
		this.tui = config.tui;
		this.items = config.items;
		this.restage = config.restage;
		this.liveKeys = new Set(config.enabledKeys);
		this.defaultKeys = new Set(config.defaultKeys);
		this.onApplyCallback = config.onApply;
		this.onCancelCallback = config.onCancel;
		this.staged = new Set(config.enabledKeys);
		this.filtered = this.items;
		this.maxVisible = config.maxVisible ?? PICKER_MAX_VISIBLE;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.titleText = new Text(this.getTitleText(), 0, 0);
		this.addChild(this.titleText);
		this.subtitleText = new Text(this.getSubtitleText(), 0, 0);
		this.addChild(this.subtitleText);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.footerText = new Text(this.getFooterText(), 0, 0);
		this.addChild(this.footerText);
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	/** Rebuild pre-baked themed strings when the theme changes. */
	override invalidate(): void {
		super.invalidate();
		this.titleText.setText(this.getTitleText());
		this.subtitleText.setText(this.getSubtitleText());
		this.footerText.setText(this.getFooterText());
		this.updateList();
	}

	private getTitleText(): string {
		return colors.accent(colors.bold("Tool Configuration"));
	}

	private getSubtitleText(): string {
		return colors.muted("Session-only. Model-callable tools for this session; resets on /model.");
	}

	private isDirty(): boolean {
		return !sameSelection(this.staged, this.liveKeys);
	}

	private getFooterText(): string {
		// `space` is only a toggle while the search box is empty; drop it from the
		// hint once typing has claimed it.
		const confirm = cuaKeyText("tui.select.confirm");
		const toggleKeys = this.searchInput.getValue() ? confirm : `${confirm}/space`;
		const parts = [
			`${toggleKeys} toggle`,
			`${cuaKeyText("cua.tools.enableAll")} all`,
			`${cuaKeyText("cua.tools.clearAll")} none`,
			`${cuaKeyText("cua.tools.reset")} defaults`,
			`${cuaKeyText("cua.tools.apply")} apply`,
			`${cuaKeyText("tui.select.cancel")} cancel`,
			`${this.staged.size}/${this.items.filter((item) => item.available).length} enabled`,
		];
		const line = colors.dim(`  ${parts.join(" · ")}`);
		if (this.staged.size === 0) return `${line} ${colors.warning("(text-only agent)")}`;
		return this.isDirty() ? `${line} ${colors.warning("(unapplied)")}` : line;
	}

	private refresh(): void {
		const query = this.searchInput.getValue();
		this.filtered = query ? fuzzyFilter([...this.items], query, toolSearchText) : this.items;
		this.selectedIndex = clampSelection(this.selectedIndex, this.filtered.length);
		this.updateList();
		this.footerText.setText(this.getFooterText());
	}

	private updateList(): void {
		this.listContainer.clear();
		if (this.filtered.length === 0) {
			this.listContainer.addChild(new Text(colors.muted("  No matching tools"), 0, 0));
			return;
		}
		const { start, end } = visibleWindow(this.selectedIndex, this.filtered.length, this.maxVisible);
		for (let i = start; i < end; i += 1) {
			const item = this.filtered[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? colors.accent("→ ") : "  ";
			const label = isSelected ? colors.accent(item.label) : item.label;
			const badge = colors.muted(` [${item.group}]`);
			const status = !item.available
				? colors.muted(" — unavailable")
				: this.staged.has(item.key)
					? colors.success(" ✓ enabled")
					: colors.dim(" ✗ disabled");
			this.listContainer.addChild(new Text(`${prefix}${label}${badge}${status}`, 0, 0));
		}
		if (start > 0 || end < this.filtered.length) {
			this.listContainer.addChild(
				new Text(colors.muted(`  (${this.selectedIndex + 1}/${this.filtered.length})`), 0, 0),
			);
		}
		const selected = this.filtered[this.selectedIndex];
		if (selected) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(colors.muted(`  ${selected.key}`), 0, 0));
			if (selected.description) {
				this.listContainer.addChild(new Text(colors.muted(`  ${selected.description}`), 0, 0));
			}
			if (!selected.available && selected.unavailableReason) {
				this.listContainer.addChild(new Text(colors.warning(`  ${selected.unavailableReason}`), 0, 0));
			}
		}
	}

	/** Bulk actions honour an active search filter, as pi's selector does. */
	private bulkTargets(): string[] {
		const scope = this.searchInput.getValue() ? this.filtered : this.items;
		return scope.filter((item) => item.available).map((item) => item.key);
	}

	/** Re-evaluate availability against the staged selection, dropping rows that no longer compile. */
	private restageItems(): void {
		if (!this.restage) return;
		this.items = this.restage(this.staged);
		const selectable = new Set(this.items.filter((item) => item.available).map((item) => item.key));
		this.staged = new Set([...this.staged].filter((key) => selectable.has(key)));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.up")) {
			if (this.filtered.length === 0) return;
			this.selectedIndex = moveSelection(this.selectedIndex, -1, this.filtered.length);
			this.updateList();
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.filtered.length === 0) return;
			this.selectedIndex = moveSelection(this.selectedIndex, 1, this.filtered.length);
			this.updateList();
			this.tui.requestRender();
			return;
		}
		// Space toggles only while the search box is empty, so a multi-word query
		// (descriptions are searchable) stays typeable.
		if (kb.matches(data, "tui.select.confirm") || (data === " " && !this.searchInput.getValue())) {
			const item = this.filtered[this.selectedIndex];
			if (item && (item.available || this.staged.has(item.key))) {
				this.staged = toggleTool(this.staged, item.key);
				this.restageItems();
				this.refresh();
				this.tui.requestRender();
			}
			return;
		}
		if (kb.matches(data, "cua.tools.enableAll")) {
			this.staged = enableTools(this.staged, this.bulkTargets());
			this.restageItems();
			this.refresh();
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "cua.tools.clearAll")) {
			this.staged = disableTools(this.staged, this.bulkTargets());
			this.restageItems();
			this.refresh();
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "cua.tools.reset")) {
			this.staged = new Set(this.defaultKeys);
			this.restageItems();
			this.refresh();
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "cua.tools.apply")) {
			this.onApplyCallback(new Set(this.staged));
			return;
		}
		// Honour whatever `tui.select.cancel` is bound to (default escape/ctrl+c) so
		// the footer hint and the handler can never disagree. Within that binding,
		// ctrl+c clears an active search before cancelling, like pi's selector;
		// escape always cancels outright.
		if (kb.matches(data, "tui.select.cancel")) {
			if (matchesKey(data, Key.ctrl("c")) && this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.refresh();
				this.tui.requestRender();
			} else {
				this.onCancelCallback();
			}
			return;
		}
		this.searchInput.handleInput(data);
		this.refresh();
		this.tui.requestRender();
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
