export const KERNEL_MODIFIER_KEYSYMS = ["Control_L", "Alt_L", "Shift_L", "Super_L"] as const;

// Models are imprecise about key naming regardless of provider: the same
// model may emit W3C KeyboardEvent names ("ArrowLeft"), shorthand ("ctrl",
// "cmd"), keypad names ("kp_enter"), or word-form punctuation ("plus").
// This table is the corrective force that absorbs that nondeterminism into
// Kernel's X11 keysym vocabulary.
const KEY_ALIASES: Record<string, string> = {
	alt: "Alt_L",
	alt_l: "Alt_L",
	altleft: "Alt_L",
	backspace: "BackSpace",
	backquote: "grave",
	backslash: "backslash",
	bracketleft: "bracketleft",
	bracketright: "bracketright",
	capslock: "Caps_Lock",
	cmd: "Super_L",
	comma: "comma",
	command: "Super_L",
	control: "Control_L",
	control_l: "Control_L",
	controlleft: "Control_L",
	ctrl: "Control_L",
	delete: "Delete",
	down: "Down",
	end: "End",
	enter: "Return",
	equal: "equal",
	esc: "Escape",
	escape: "Escape",
	home: "Home",
	insert: "Insert",
	kp_enter: "Return",
	left: "Left",
	meta: "Super_L",
	minus: "minus",
	numlock: "Num_Lock",
	option: "Alt_L",
	pagedown: "Next",
	page_down: "Next",
	pageup: "Prior",
	page_up: "Prior",
	pause: "Pause",
	period: "period",
	plus: "plus",
	print: "Print",
	printscreen: "Print",
	quote: "apostrophe",
	return: "Return",
	right: "Right",
	scrolllock: "Scroll_Lock",
	semicolon: "semicolon",
	shift: "Shift_L",
	shift_l: "Shift_L",
	shiftleft: "Shift_L",
	slash: "slash",
	space: "space",
	super: "Super_L",
	super_l: "Super_L",
	tab: "Tab",
	up: "Up",
	...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
	...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`numpad${i}`, String(i)])),
	numpadadd: "plus",
	numpaddecimal: "period",
	numpaddivide: "slash",
	numpadmultiply: "asterisk",
	numpadsubtract: "minus",
};

const PRINTABLE_KEY_ALIASES: Record<string, string> = {
	"*": "asterisk",
	"+": "plus",
	",": "comma",
	"-": "minus",
	".": "period",
	"/": "slash",
	";": "semicolon",
	"=": "equal",
	"[": "bracketleft",
	"\\": "backslash",
	"]": "bracketright",
	"`": "grave",
	"'": "apostrophe",
};

const KERNEL_MODIFIER_KEYSYM_SET = new Set<string>(KERNEL_MODIFIER_KEYSYMS);

export function normalizeKernelKey(value: string): string {
	const trimmed = value.trim();
	if (PRINTABLE_KEY_ALIASES[trimmed]) return PRINTABLE_KEY_ALIASES[trimmed];
	const lookup = trimmed.replace(/[-\s]/g, "_").toLowerCase();
	const alias = KEY_ALIASES[lookup];
	if (alias) return alias;
	if (/^arrow/i.test(trimmed)) return normalizeKernelKey(trimmed.slice("arrow".length));
	if (trimmed.length === 1 && trimmed >= "A" && trimmed <= "Z") return trimmed.toLowerCase();
	return trimmed;
}

export function normalizeKernelKeyCombo(value: string): string[] {
	return value
		.split("+")
		.map((part) => normalizeKernelKey(part))
		.filter(Boolean);
}

export function normalizeKernelKeySequence(value: string): string[][] {
	return value
		.trim()
		.split(/\s+/)
		.map((part) => normalizeKernelKeyCombo(part))
		.filter((combo) => combo.length > 0);
}

export function isKernelModifierKey(key: string): boolean {
	return KERNEL_MODIFIER_KEYSYM_SET.has(key);
}
