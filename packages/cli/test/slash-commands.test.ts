import { describe, expect, it } from "vitest";
import { buildAutocompleteProvider, parseSlashCommand } from "../src/tui/slash-commands";

describe("parseSlashCommand", () => {
	it("returns undefined for non-slash input", () => {
		expect(parseSlashCommand("hello world")).toBeUndefined();
		expect(parseSlashCommand("")).toBeUndefined();
	});

	it("parses /model with a provider:model argument", () => {
		expect(parseSlashCommand("/model openai:gpt-5.5")).toEqual({
			command: "model",
			argument: "openai:gpt-5.5",
		});
		expect(parseSlashCommand("/model")).toEqual({ command: "model", argument: "" });
	});

	it("parses /tools with and without an argument", () => {
		expect(parseSlashCommand("/tools")).toEqual({ command: "tools", argument: "" });
		expect(parseSlashCommand("/tools something")).toEqual({
			command: "tools",
			argument: "something",
		});
	});

	it("parses /thinking with a reasoning level", () => {
		expect(parseSlashCommand("/thinking high")).toEqual({
			command: "thinking",
			argument: "high",
		});
	});

	it("parses /compact", () => {
		expect(parseSlashCommand("/compact")).toEqual({ command: "compact", argument: "" });
	});

	it("parses /skill:<name> with optional remainder", () => {
		expect(parseSlashCommand("/skill:hello")).toEqual({
			command: "skill",
			name: "hello",
			remainder: "",
		});
		expect(parseSlashCommand("/skill:hello with args")).toEqual({
			command: "skill",
			name: "hello",
			remainder: "with args",
		});
	});

	it("returns undefined for unknown slash commands", () => {
		expect(parseSlashCommand("/totally-unknown-command")).toBeUndefined();
	});
});

describe("buildAutocompleteProvider", () => {
	it("offers /tools alongside the other built-in commands", async () => {
		const provider = buildAutocompleteProvider(process.cwd(), []);
		const result = await provider.getSuggestions(["/"], 0, 1, {
			signal: new AbortController().signal,
		});
		const names = (result?.items ?? []).map((item) => item.value);
		expect(names).toContain("tools");
		expect(names).toContain("model");
		expect(names).toContain("thinking");
		expect(names).toContain("compact");
	});
});
