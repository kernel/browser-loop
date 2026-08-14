export type Key = string;

export const KeyEnter: Key = "\r";
export const KeyCtrlC: Key = "\x03";
export const KeyCtrlD: Key = "\x04";
export const KeyTab: Key = "\t";
export const KeyBacktab: Key = "\x1b[Z";
export const KeyEscape: Key = "\x1b";
export const KeyBackspace: Key = "\x7f";
export const KeyInsert: Key = "\x1b[2~";
export const KeyDelete: Key = "\x1b[3~";
export const KeyHome: Key = "\x1b[H";
export const KeyEnd: Key = "\x1b[F";
export const KeyPageUp: Key = "\x1b[5~";
export const KeyPageDown: Key = "\x1b[6~";
export const KeyArrowUp: Key = "\x1b[A";
export const KeyArrowDown: Key = "\x1b[B";
export const KeyArrowLeft: Key = "\x1b[D";
export const KeyArrowRight: Key = "\x1b[C";

export const SPECIAL_KEY_KIND = "special" as const;

export type SpecialKeyName =
	| "arrow_up"
	| "arrow_down"
	| "arrow_left"
	| "arrow_right"
	| "home"
	| "end"
	| "page_up"
	| "page_down"
	| "insert"
	| "delete"
	| "escape"
	| "backtab";

export interface SpecialKey {
	readonly kind: typeof SPECIAL_KEY_KIND;
	readonly name: SpecialKeyName;
}

export function specialKey(name: SpecialKeyName): SpecialKey {
	return { kind: SPECIAL_KEY_KIND, name };
}

export const SpecialArrowUp = specialKey("arrow_up");
export const SpecialArrowDown = specialKey("arrow_down");
export const SpecialArrowLeft = specialKey("arrow_left");
export const SpecialArrowRight = specialKey("arrow_right");
export const SpecialHome = specialKey("home");
export const SpecialEnd = specialKey("end");
export const SpecialPageUp = specialKey("page_up");
export const SpecialPageDown = specialKey("page_down");
export const SpecialInsert = specialKey("insert");
export const SpecialDelete = specialKey("delete");
export const SpecialEscape = specialKey("escape");
export const SpecialBacktab = specialKey("backtab");
