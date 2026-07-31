import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { colors, getMarkdownTheme } from "./themes";

/**
 * Append-only chat log of user prompts, assistant text, tool-call summaries,
 * and inline error notes. Assistant blocks render through pi-tui's
 * {@link Markdown}; everything else uses plain styled {@link Text}.
 */
export class MessageList extends Container {
	addUser(text: string): void {
		this.appendBlock([colors.bold("you ") + colors.dim("›") + " " + text]);
	}

	addAssistantStart(): AssistantBuffer {
		const buffer = new AssistantBuffer();
		this.addChild(buffer);
		this.invalidate();
		return buffer;
	}

	addToolCall(name: string, args: unknown): void {
		const summary = formatToolCall(name, args);
		this.appendBlock([colors.accent("· ") + colors.dim(name) + " " + summary]);
	}

	addToolResult(name: string, ok: boolean, summary: string): void {
		const icon = ok ? colors.success("✓") : colors.error("✗");
		this.appendBlock([`  ${icon} ${colors.dim(name)} ${summary}`]);
	}

	addNotice(text: string): void {
		this.appendBlock([colors.warning("· ") + colors.dim(text)]);
	}

	addError(text: string): void {
		this.appendBlock([colors.error("error ") + text]);
	}

	private appendBlock(lines: string[]): void {
		for (const line of lines) {
			this.addChild(new Text(line, 0, 0));
		}
		this.invalidate();
	}
}

/** Live-updating buffer for the in-flight assistant message. */
export class AssistantBuffer extends Container {
	private text = "";
	private readonly body: Markdown;

	constructor() {
		super();
		this.addChild(new Text(colors.success("assistant"), 0, 0));
		this.body = new Markdown("", 0, 0, getMarkdownTheme());
		this.addChild(this.body);
	}

	append(delta: string): void {
		this.text += delta;
		this.body.setText(this.text);
		this.invalidate();
	}

	end(): void {
		if (!this.text.trim()) {
			this.children = [];
		}
		this.invalidate();
	}
}

function formatToolCall(name: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const obj = args as Record<string, unknown>;
	switch (name) {
		case "computer_batch": {
			const actions = Array.isArray(obj.actions) ? obj.actions : [];
			if (actions.length === 0) return "(empty)";
			const parts = (actions as Array<Record<string, unknown>>).slice(0, 4).map(describeAction);
			const more = actions.length > 4 ? colors.dim(` +${actions.length - 4} more`) : "";
			return parts.join(colors.dim(" → ")) + more;
		}
		case "playwright_execute":
			return colors.dim(typeof obj.code === "string" ? truncate(obj.code.replace(/\s+/g, " ").trim(), 80) : "");
		case "bash":
			return colors.dim(typeof obj.command === "string" ? truncate(obj.command, 80) : "");
		case "read":
		case "write":
		case "edit":
			return colors.dim(typeof obj.path === "string" ? obj.path : "");
		default:
			return describeAction(obj);
	}
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, max - 1) + "…";
}

function describeAction(action: Record<string, unknown>): string {
	const t = typeof action.action === "string" ? action.action : typeof action.type === "string" ? action.type : "";
	const num = (v: unknown) => (typeof v === "number" ? Math.trunc(v) : 0);
	switch (t) {
		case "click":
			return `click(${num(action.x)},${num(action.y)})`;
		case "double_click":
			return `dblclick(${num(action.x)},${num(action.y)})`;
		case "triple_click":
			return `triple(${num(action.x)},${num(action.y)})`;
		case "type":
			return `type(${truncate(JSON.stringify(action.text ?? ""), 24)})`;
		case "keypress":
			return `key(${(action.keys as string[] | undefined)?.join("+") ?? ""})`;
		case "scroll":
			return `scroll(${num(action.x)},${num(action.y)})`;
		case "move":
			return `move(${num(action.x)},${num(action.y)})`;
		case "drag":
			return `drag(...)`;
		case "wait":
			return `wait(${typeof action.ms === "number" ? action.ms : 1000}ms)`;
		case "goto":
			return `goto(${typeof action.url === "string" ? action.url : ""})`;
		case "back":
			return "back";
		case "forward":
			return "forward";
		case "url":
			return "url";
		case "screenshot":
			return "screenshot";
		default:
			return t || colors.dim(truncate(JSON.stringify(action), 80));
	}
}
