import { describe, expect, it } from "vitest";
import { loop } from "../src/index";
import {
	rewriteAnthropicToolsetPayload,
	rewriteAnthropicToolsetSseLine,
} from "../src/pi/providers/anthropic/toolsets";

const both = new Set(["computer", "browser"] as const);

describe("Anthropic GA client toolsets", () => {
	it("declares the released toolsets without preview fields or beta requirements", () => {
		expect(loop.providers.anthropic.tools.computer({ version: "20260801", zoom: false }).providerBinding).toEqual({
			kind: "anthropic-native",
			toolsetName: "computer",
			declaration: {
				type: "computer_toolset_20260801",
				configs: { zoom: { enabled: false } },
			},
		});
		expect(loop.providers.anthropic.tools.browser({ version: "20260801", javascript: true }).providerBinding).toEqual({
			kind: "anthropic-native",
			toolsetName: "browser",
			declaration: {
				type: "browser_toolset_20260801",
				configs: { javascript_exec: { enabled: true } },
			},
		});
	});

	it("maps the GA browser members added after the preview", () => {
		const tool = loop.providers.anthropic.tools.browser();
		if (tool.execution.kind !== "actions") throw new Error("expected action tool");
		expect(tool.execution.toActions({ action: "middle_click", target: { type: "coordinate", x: 1, y: 2 } })).toEqual([
			{ type: "browser_click", x: 1, y: 2, button: "middle" },
		]);
		expect(tool.execution.toActions({ action: "left_mouse_down", target: { type: "coordinate", x: 3, y: 4 } })).toEqual([
			{ type: "browser_mouse_down", x: 3, y: 4 },
		]);
		expect(tool.execution.toActions({ action: "hold_key", text: "shift", duration: 2 })).toEqual([
			{ type: "browser_hold_key", text: "shift", duration: 2 },
		]);
		expect(tool.execution.toActions({ action: "switch_tab", tab_id: "TAB1" })).toEqual([
			{ type: "browser_switch_tab", tab_id: "TAB1" },
		]);
		expect(tool.execution.toActions({ action: "close_tab", tab_id: "TAB1" })).toEqual([
			{ type: "browser_close_tab", tab_id: "TAB1" },
		]);
	});

	it("rewrites pi function calls and results into member toolset blocks", () => {
		const payload = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "computer-1", name: "computer", input: { action: "left_click", coordinate: [10, 20] } },
						{ type: "tool_use", id: "browser-1", name: "browser", input: { action: "navigate", url: "https://example.com" } },
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "computer-1", content: "OK", is_error: false },
						{ type: "tool_result", tool_use_id: "browser-1", content: "OK", is_error: false },
					],
				},
			],
		};

		expect(rewriteAnthropicToolsetPayload(payload, both)).toEqual({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "computer-1", name: "left_click", toolset_name: "computer", input: { coordinate: [10, 20] } },
						{ type: "tool_use", id: "browser-1", name: "navigate", toolset_name: "browser", input: { url: "https://example.com" } },
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "computer-1", toolset_name: "computer", content: "OK", is_error: false },
						{ type: "tool_result", tool_use_id: "browser-1", toolset_name: "browser", content: "OK", is_error: false },
					],
				},
			],
		});
	});

	it("emits browser_state for successful tab-management results", () => {
		const state = {
			tabs: [{ tab_id: "TAB1", title: "", url: "about:blank", active: true as const }],
			state_changes: [{ type: "tab_opened" as const, tab_id: "TAB1" }],
		};
		const payload = {
			messages: [
				{ role: "assistant", content: [{ type: "tool_use", id: "tab-1", name: "browser", input: { action: "new_tab" } }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "tab-1", content: "Available tabs", is_error: false }] },
			],
		};
		const rewritten = rewriteAnthropicToolsetPayload(payload, both, new Map([["tab-1", state]])) as typeof payload;
		expect(rewritten.messages[1]!.content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "tab-1",
			toolset_name: "browser",
			content: [{ type: "browser_state", ...state }],
			is_error: false,
		});
	});

	it("rejects a successful tab result without structured browser state", () => {
		const payload = {
			messages: [
				{ role: "assistant", content: [{ type: "tool_use", id: "tab-1", name: "browser", input: { action: "list_tabs" } }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "tab-1", content: "Available tabs", is_error: false }] },
			],
		};
		expect(() => rewriteAnthropicToolsetPayload(payload, both)).toThrow(/missing browser_state execution details/);
	});

	it("marks streamed member calls without touching ordinary tools", () => {
		const member = rewriteAnthropicToolsetSseLine(
			`data: ${JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "call-1", name: "screenshot", input: {}, toolset_name: "computer" },
			})}`,
			both,
		);
		expect(JSON.parse(member.slice("data: ".length)).content_block.name).toBe("loop_anthropic_toolset_computer__screenshot");

		const ordinary = `data: ${JSON.stringify({
			type: "content_block_start",
			index: 1,
			content_block: { type: "tool_use", id: "call-2", name: "custom", input: {} },
		})}`;
		expect(rewriteAnthropicToolsetSseLine(ordinary, both)).toBe(ordinary);
	});
});
