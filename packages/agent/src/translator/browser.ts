import {
	normalizeGotoUrl,
	type CuaActionBrowserClick,
	type CuaActionBrowserDrag,
	type CuaActionBrowserFill,
	type CuaActionBrowserFind,
	type CuaActionBrowserHover,
	type CuaActionBrowserKey,
	type CuaActionBrowserNavigate,
	type CuaActionBrowserScroll,
	type CuaActionBrowserScrollTo,
	type CuaActionBrowserSnapshot,
	type CuaBrowserAction,
} from "@onkernel/cua-ai";
import { CdpConnection } from "./cdp";
import type { BatchReadResult } from "./types";

const SNAPSHOT_CHAR_LIMIT = 50_000;
const DEFAULT_SNAPSHOT_DEPTH = 15;
const FIND_MATCH_LIMIT = 20;
const SCROLL_NOTCH_PX = 120;

const STALE_REF_HINT = "Call snapshot (or find) to get fresh element references.";

interface AXNode {
	nodeId: string;
	ignored?: boolean;
	role?: { value?: string };
	name?: { value?: string };
	backendDOMNodeId?: number;
	parentId?: string;
	childIds?: string[];
}

interface RefEntry {
	backendNodeId: number;
	targetId: string;
	generation: number;
}

/**
 * Executes browser-plane canonical actions over CDP.
 *
 * Element refs are snapshot-scoped: each snapshot/find mints `e<N>` ids
 * mapped to CDP backend node ids for the target's current generation. A
 * navigation bumps the generation, and refs from earlier generations resolve
 * to a stale-ref error whose message tells the model how to recover.
 */
export class BrowserExecutor {
	private readonly refs = new Map<string, RefEntry>();
	private readonly generations = new Map<string, number>();
	private refCounter = 0;
	private activeTargetId?: string;

	private readonly cdp: CdpConnection;

	constructor(cdpWsUrl: string) {
		this.cdp = new CdpConnection(cdpWsUrl);
	}

	/** Close the CDP connection. Safe to call when never connected. */
	close(): void {
		this.cdp.close();
	}

	async execute(action: CuaBrowserAction): Promise<BatchReadResult[]> {
		switch (action.type) {
			case "browser_snapshot":
				return [{ type: "browser_text", label: "snapshot", text: await this.snapshot(action) }];
			case "browser_text":
				return [{ type: "browser_text", label: "text", text: await this.pageText(tabOf(action)) }];
			case "browser_find":
				return [{ type: "browser_text", label: "find", text: await this.find(action) }];
			case "browser_click":
				await this.click(action);
				return [];
			case "browser_hover":
				await this.hover(action);
				return [];
			case "browser_drag":
				await this.drag(action);
				return [];
			case "browser_fill":
				await this.fill(action);
				return [];
			case "browser_scroll_to":
				await this.scrollTo(action);
				return [];
			case "browser_scroll":
				await this.scroll(action);
				return [];
			case "browser_type": {
				const session = await this.session(tabOf(action));
				await this.cdp.send("Input.insertText", { text: action.text }, session);
				return [];
			}
			case "browser_key":
				await this.key(action);
				return [];
			case "browser_navigate":
				return [{ type: "browser_text", label: "navigate", text: await this.navigate(action) }];
			case "browser_list_tabs":
				return [{ type: "browser_text", label: "tabs", text: await this.listTabs() }];
			case "browser_new_tab":
				return [{ type: "browser_text", label: "new_tab", text: await this.newTab() }];
			case "browser_screenshot":
				return [{ type: "screenshot", ...(await this.screenshot(action.region, action.tab_id)) }];
			case "browser_evaluate":
				return [{ type: "browser_text", label: "evaluate", text: await this.evaluate(action.code, tabOf(action)) }];
		}
	}

	async screenshot(region?: [number, number, number, number], tabId?: string): Promise<{ data: Buffer; mimeType: string }> {
		const session = await this.session(tabId);
		const clip = region
			? {
					clip: {
						x: Math.min(region[0], region[2]),
						y: Math.min(region[1], region[3]),
						width: Math.max(1, Math.abs(region[2] - region[0])),
						height: Math.max(1, Math.abs(region[3] - region[1])),
						scale: 1,
					},
				}
			: {};
		const { data } = await this.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", ...clip }, session);
		return { data: Buffer.from(data, "base64"), mimeType: "image/png" };
	}

	private async snapshot(action: CuaActionBrowserSnapshot): Promise<string> {
		const targetId = await this.resolveTarget(action.tab_id);
		const session = await this.attach(targetId);
		const { nodes } = await this.cdp.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", {}, session);
		const byId = new Map(nodes.map((node) => [node.nodeId, node]));
		const roots = nodes.filter((node) => !node.parentId);
		let rootIds = roots.map((node) => node.nodeId);
		if (action.ref) {
			const entry = this.resolveRef(action.ref, targetId);
			const rootNode = nodes.find((node) => node.backendDOMNodeId === entry.backendNodeId);
			if (!rootNode) throw new Error(`ref ${action.ref} is stale or not on the current page. ${STALE_REF_HINT}`);
			rootIds = [rootNode.nodeId];
		}

		const generation = this.generation(targetId);
		const lines: string[] = [];
		const maxDepth = action.depth ?? DEFAULT_SNAPSHOT_DEPTH;
		const interactiveOnly = action.filter === "interactive";
		const walk = (nodeId: string, depth: number): void => {
			const node = byId.get(nodeId);
			if (!node) return;
			if (depth <= maxDepth && !node.ignored) {
				const line = this.renderNode(node, targetId, generation, depth, interactiveOnly);
				if (line) lines.push(line);
			}
			if (depth < maxDepth) {
				for (const childId of node.childIds ?? []) walk(childId, depth + 1);
			}
		};
		for (const rootId of rootIds) walk(rootId, 0);

		let text = lines.join("\n");
		if (text.length > SNAPSHOT_CHAR_LIMIT) {
			text = `${text.slice(0, SNAPSHOT_CHAR_LIMIT)}\n… truncated at ${SNAPSHOT_CHAR_LIMIT} characters. Re-request with a smaller depth, filter: "interactive", or a ref to narrow the subtree.`;
		}
		return text || "(empty accessibility tree)";
	}

	private renderNode(node: AXNode, targetId: string, generation: number, depth: number, interactiveOnly: boolean): string | undefined {
		const role = node.role?.value ?? "";
		const name = node.name?.value ?? "";
		const interactive = INTERACTIVE_ROLES.has(role);
		if (interactiveOnly && !interactive) return undefined;
		if (!interactiveOnly && !name && !interactive && SKIPPED_ROLES.has(role)) return undefined;
		let line = `${"  ".repeat(Math.min(depth, 20))}${role || "node"}${name ? ` ${JSON.stringify(name)}` : ""}`;
		if (node.backendDOMNodeId !== undefined && interactive) {
			line += ` [${this.mintRef(node.backendDOMNodeId, targetId, generation)}]`;
		}
		return line;
	}

	private async find(action: CuaActionBrowserFind): Promise<string> {
		const targetId = await this.resolveTarget(action.tab_id);
		const session = await this.attach(targetId);
		const { nodes } = await this.cdp.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", {}, session);
		const queryTokens = tokenize(action.query);
		const scored = nodes
			.filter((node) => !node.ignored && node.backendDOMNodeId !== undefined && (node.name?.value || INTERACTIVE_ROLES.has(node.role?.value ?? "")))
			.map((node) => ({ node, score: overlapScore(queryTokens, tokenize(`${node.role?.value ?? ""} ${node.name?.value ?? ""}`)) }))
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, FIND_MATCH_LIMIT);
		if (scored.length === 0) return `No elements matched ${JSON.stringify(action.query)}. Try snapshot for the full tree.`;
		return scored
			.map(({ node }) => {
				const role = node.role?.value ?? "node";
				const name = node.name?.value ? ` ${JSON.stringify(node.name.value)}` : "";
				return `${role}${name} [${this.mintRef(node.backendDOMNodeId!, targetId, this.generation(targetId))}]`;
			})
			.join("\n");
	}

	private async click(action: CuaActionBrowserClick): Promise<void> {
		const targetId = await this.resolveTarget(action.tab_id);
		const session = await this.attach(targetId);
		const point = await this.resolvePoint(action, targetId, session);
		const modifiers = modifierBits(action.modifiers);
		const button = action.button ?? "left";
		const clickCount = action.num_clicks ?? 1;
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, modifiers }, session);
		await this.cdp.send(
			"Input.dispatchMouseEvent",
			{ type: "mousePressed", x: point.x, y: point.y, button, clickCount, modifiers },
			session,
		);
		await this.cdp.send(
			"Input.dispatchMouseEvent",
			{ type: "mouseReleased", x: point.x, y: point.y, button, clickCount, modifiers },
			session,
		);
	}

	private async hover(action: CuaActionBrowserHover): Promise<void> {
		const targetId = await this.resolveTarget(action.tab_id);
		const session = await this.attach(targetId);
		const point = await this.resolvePoint(action, targetId, session);
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, session);
	}

	private async drag(action: CuaActionBrowserDrag): Promise<void> {
		const session = await this.session(tabOf(action));
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: action.from.x, y: action.from.y, button: "left", clickCount: 1 }, session);
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: action.to.x, y: action.to.y, button: "left" }, session);
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: action.to.x, y: action.to.y, button: "left", clickCount: 1 }, session);
	}

	private async fill(action: CuaActionBrowserFill): Promise<void> {
		const targetId = await this.resolveTarget(action.tab_id);
		const session = await this.attach(targetId);
		const entry = this.resolveRef(action.ref, targetId);
		const objectId = await this.resolveObject(entry, action.ref, session);
		const { exceptionDetails } = await this.cdp.send<{ exceptionDetails?: { exception?: { description?: string } } }>(
			"Runtime.callFunctionOn",
			{
				objectId,
				functionDeclaration: FILL_FUNCTION,
				arguments: [{ value: action.value }],
			},
			session,
		);
		if (exceptionDetails) {
			throw new Error(`browser_fill failed: ${exceptionDetails.exception?.description ?? "element rejected the value"}`);
		}
	}

	private async scrollTo(action: CuaActionBrowserScrollTo): Promise<void> {
		const targetId = await this.resolveTarget(action.tab_id);
		const session = await this.attach(targetId);
		const entry = this.resolveRef(action.ref, targetId);
		await this.scrollIntoView(entry, action.ref, session);
	}

	private async scroll(action: CuaActionBrowserScroll): Promise<void> {
		const session = await this.session(tabOf(action));
		const notches = action.amount ?? 3;
		const delta = Math.trunc(notches) * SCROLL_NOTCH_PX;
		const deltaX = action.direction === "left" ? -delta : action.direction === "right" ? delta : 0;
		const deltaY = action.direction === "up" ? -delta : action.direction === "down" ? delta : 0;
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: action.x, y: action.y, deltaX, deltaY }, session);
	}

	private async key(action: CuaActionBrowserKey): Promise<void> {
		const session = await this.session(tabOf(action));
		const repeat = Math.min(Math.max(1, Math.trunc(action.repeat ?? 1)), 100);
		const chords = action.text.trim().split(/\s+/).filter(Boolean);
		for (let iteration = 0; iteration < repeat; iteration += 1) {
			for (const chord of chords) {
				await this.dispatchChord(chord, session);
			}
		}
	}

	private async dispatchChord(chord: string, session: string): Promise<void> {
		const parts = chord.split("+").filter(Boolean);
		const keyPart = parts[parts.length - 1] ?? "";
		const modifierParts = parts.slice(0, -1);
		const modifiers = modifierBits(modifierParts);
		const key = resolveKey(keyPart);
		const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers };
		await this.cdp.send("Input.dispatchKeyEvent", { type: key.text ? "keyDown" : "rawKeyDown", ...base, ...(key.text ? { text: key.text } : {}) }, session);
		await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, session);
	}

	private async navigate(action: CuaActionBrowserNavigate): Promise<string> {
		const targetId = await this.resolveTarget(action.tab_id);
		const session = await this.attach(targetId);
		const direction = action.url.trim().toLowerCase();
		if (direction === "back" || direction === "forward") {
			const history = await this.cdp.send<{ currentIndex: number; entries: Array<{ id: number; url: string }> }>(
				"Page.getNavigationHistory",
				{},
				session,
			);
			const entry = history.entries[history.currentIndex + (direction === "back" ? -1 : 1)];
			if (!entry) throw new Error(`cannot go ${direction}: no history entry`);
			await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, session);
			this.invalidateRefs(targetId);
			return `Navigated ${direction}.\n${await this.tabContext(targetId)}`;
		}
		const url = normalizeGotoUrl(action.url);
		if (!url) throw new Error("invalid url");
		const { errorText } = await this.cdp.send<{ errorText?: string }>("Page.navigate", { url }, session);
		if (errorText) throw new Error(`navigation to ${url} failed: ${errorText}`);
		this.invalidateRefs(targetId);
		return `Navigated to ${url}.\n${await this.tabContext(targetId)}`;
	}

	private async listTabs(): Promise<string> {
		const targets = await this.cdp.pageTargets();
		if (targets.length === 0) return "No open tabs.";
		return targets.map((target) => `tab_id ${shortTabId(target.targetId)}: ${JSON.stringify(target.title)} (${target.url})`).join("\n");
	}

	private async newTab(): Promise<string> {
		const targetId = await this.cdp.createTarget("about:blank");
		this.activeTargetId = targetId;
		return `Opened tab_id ${shortTabId(targetId)}.\n${await this.tabContext(targetId)}`;
	}

	private async evaluate(code: string, tabId?: string): Promise<string> {
		const session = await this.session(tabId);
		const { result, exceptionDetails } = await this.cdp.send<{
			result: { value?: unknown; description?: string; type?: string };
			exceptionDetails?: { exception?: { description?: string } };
		}>("Runtime.evaluate", { expression: code, returnByValue: true, awaitPromise: true }, session);
		if (exceptionDetails) throw new Error(`browser_evaluate failed: ${exceptionDetails.exception?.description ?? "evaluation threw"}`);
		if (result.value === undefined) return result.description ?? String(result.type ?? "undefined");
		return typeof result.value === "string" ? result.value : JSON.stringify(result.value);
	}

	private async pageText(tabId?: string): Promise<string> {
		return this.evaluate("document.body ? document.body.innerText : ''", tabId);
	}

	private async tabContext(executedOn: string): Promise<string> {
		const targets = await this.cdp.pageTargets();
		const lines = targets.map((target) => `  • tab_id ${shortTabId(target.targetId)}: ${JSON.stringify(target.title)} (${target.url})`);
		return [`Tab Context:`, `- Executed on tab_id: ${shortTabId(executedOn)}`, `- Available tabs:`, ...lines].join("\n");
	}

	private async resolvePoint(
		action: CuaActionBrowserClick | CuaActionBrowserHover,
		targetId: string,
		session: string,
	): Promise<{ x: number; y: number }> {
		if (action.ref !== undefined) {
			const entry = this.resolveRef(action.ref, targetId);
			await this.scrollIntoView(entry, action.ref, session);
			const { model } = await this.cdp.send<{ model: { content: number[] } }>(
				"DOM.getBoxModel",
				{ backendNodeId: entry.backendNodeId },
				session,
			);
			const quad = model.content;
			return { x: (quad[0]! + quad[4]!) / 2, y: (quad[1]! + quad[5]!) / 2 };
		}
		if (typeof action.x === "number" && typeof action.y === "number") return { x: action.x, y: action.y };
		throw new Error("page target required: pass a ref or viewport coordinates");
	}

	private async scrollIntoView(entry: RefEntry, ref: string, session: string): Promise<void> {
		try {
			await this.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: entry.backendNodeId }, session);
		} catch (err) {
			throw new Error(`ref ${ref} is stale or not on the current page. ${STALE_REF_HINT}`, { cause: err });
		}
	}

	private async resolveObject(entry: RefEntry, ref: string, session: string): Promise<string> {
		try {
			const { object } = await this.cdp.send<{ object: { objectId: string } }>(
				"DOM.resolveNode",
				{ backendNodeId: entry.backendNodeId },
				session,
			);
			return object.objectId;
		} catch (err) {
			throw new Error(`ref ${ref} is stale or not on the current page. ${STALE_REF_HINT}`, { cause: err });
		}
	}

	private mintRef(backendNodeId: number, targetId: string, generation: number): string {
		this.refCounter += 1;
		const ref = `e${this.refCounter}`;
		this.refs.set(ref, { backendNodeId, targetId, generation });
		return ref;
	}

	private resolveRef(ref: string, targetId: string): RefEntry {
		const entry = this.refs.get(ref);
		if (!entry || entry.targetId !== targetId || entry.generation !== this.generation(targetId)) {
			throw new Error(`ref ${ref} is stale or not on the current page. ${STALE_REF_HINT}`);
		}
		return entry;
	}

	private generation(targetId: string): number {
		return this.generations.get(targetId) ?? 0;
	}

	private invalidateRefs(targetId: string): void {
		this.generations.set(targetId, this.generation(targetId) + 1);
	}

	private async session(tabId?: string): Promise<string> {
		return this.attach(await this.resolveTarget(tabId));
	}

	private async attach(targetId: string): Promise<string> {
		return this.cdp.attachToTarget(targetId);
	}

	private async resolveTarget(tabId?: string): Promise<string> {
		const targets = await this.cdp.pageTargets();
		if (targets.length === 0) throw new Error("no open browser tabs");
		if (tabId) {
			const match = targets.find((target) => shortTabId(target.targetId) === tabId || target.targetId === tabId);
			if (!match) throw new Error(`unknown tab_id "${tabId}". Call list_tabs for current tabs.`);
			this.activeTargetId = match.targetId;
			return match.targetId;
		}
		if (this.activeTargetId && targets.some((target) => target.targetId === this.activeTargetId)) {
			return this.activeTargetId;
		}
		this.activeTargetId = targets[0]!.targetId;
		return this.activeTargetId;
	}
}

function tabOf(action: { tab_id?: string }): string | undefined {
	return action.tab_id;
}

function shortTabId(targetId: string): string {
	return targetId.slice(0, 10).toUpperCase();
}

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 1);
}

function overlapScore(query: string[], candidate: string[]): number {
	if (query.length === 0 || candidate.length === 0) return 0;
	const set = new Set(candidate);
	return query.reduce((score, token) => score + (set.has(token) ? 1 : 0), 0);
}

function modifierBits(modifiers: readonly string[] | undefined): number {
	let bits = 0;
	for (const modifier of modifiers ?? []) {
		switch (modifier.trim().toLowerCase()) {
			case "alt":
			case "option":
				bits |= 1;
				break;
			case "ctrl":
			case "control":
				bits |= 2;
				break;
			case "meta":
			case "cmd":
			case "command":
			case "super":
				bits |= 4;
				break;
			case "shift":
				bits |= 8;
				break;
		}
	}
	return bits;
}

interface ResolvedKey {
	key: string;
	code: string;
	keyCode: number;
	text?: string;
}

const NAMED_KEYS: Record<string, ResolvedKey> = {
	enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
	return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
	tab: { key: "Tab", code: "Tab", keyCode: 9 },
	escape: { key: "Escape", code: "Escape", keyCode: 27 },
	esc: { key: "Escape", code: "Escape", keyCode: 27 },
	backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
	delete: { key: "Delete", code: "Delete", keyCode: 46 },
	space: { key: " ", code: "Space", keyCode: 32, text: " " },
	up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
	down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
	left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
	right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
	arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
	arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
	arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
	arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
	home: { key: "Home", code: "Home", keyCode: 36 },
	end: { key: "End", code: "End", keyCode: 35 },
	pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
	page_up: { key: "PageUp", code: "PageUp", keyCode: 33 },
	pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
	page_down: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

function resolveKey(value: string): ResolvedKey {
	const named = NAMED_KEYS[value.toLowerCase()];
	if (named) return named;
	if (value.length === 1) {
		const upper = value.toUpperCase();
		const code = /[a-z]/i.test(value) ? `Key${upper}` : /[0-9]/.test(value) ? `Digit${value}` : "";
		return { key: value, code, keyCode: upper.charCodeAt(0), text: value };
	}
	return { key: value, code: value, keyCode: 0 };
}

const FILL_FUNCTION = `function(value) {
	const el = this;
	const tag = el.tagName ? el.tagName.toLowerCase() : "";
	if (tag === "select") {
		const str = String(value);
		const options = Array.from(el.options);
		const match = options.find((o) => o.value === str) ?? options.find((o) => (o.label || o.textContent || "").trim() === str);
		if (!match) throw new Error("no option matches " + JSON.stringify(str));
		el.value = match.value;
	} else if (el.type === "checkbox" || el.type === "radio") {
		el.checked = Boolean(value);
	} else if (tag === "input" || tag === "textarea") {
		const proto = Object.getPrototypeOf(el);
		const setter = Object.getOwnPropertyDescriptor(proto, "value");
		if (setter && setter.set) setter.set.call(el, String(value));
		else el.value = String(value);
	} else if (el.isContentEditable) {
		el.textContent = String(value);
	} else {
		throw new Error("element is not a form control");
	}
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
}`;

const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
	"button",
	"link",
	"textbox",
	"searchbox",
	"checkbox",
	"radio",
	"combobox",
	"listbox",
	"option",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"slider",
	"spinbutton",
	"switch",
	"tab",
	"textarea",
]);

const SKIPPED_ROLES: ReadonlySet<string> = new Set(["none", "generic", "InlineTextBox", "LineBreak", "StaticText"]);


