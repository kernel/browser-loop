import {
	type AutocompleteItem,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "@earendil-works/pi-tui";
import type { Skill } from "@onkernel/cua-agent";
import { listCuaModels } from "@onkernel/cua-ai";

/**
 * Build an autocomplete provider for the TUI editor with the slash commands
 * the interactive app supports: `/model`, `/thinking`, `/compact`, plus a
 * `/skill:<name>` entry per loaded skill.
 *
 * Model and thinking values are exposed as `getArgumentCompletions` so
 * users can tab through CUA refs and reasoning levels.
 */
export function buildAutocompleteProvider(
	cwd: string,
	skills: Skill[],
): CombinedAutocompleteProvider {
	const commands: SlashCommand[] = [];

	commands.push({
		name: "model",
		description: "Switch the active CUA model",
		argumentHint: "<provider:model>",
		getArgumentCompletions: (prefix: string) => modelCompletions(prefix),
	});

	commands.push({
		name: "thinking",
		description: "Set the reasoning level for future turns",
		argumentHint: "<off|minimal|low|medium|high|xhigh>",
		getArgumentCompletions: (prefix: string) => thinkingCompletions(prefix),
	});

	commands.push({
		name: "compact",
		description: "Summarize older turns to free context budget",
	});

	commands.push({
		name: "playwright",
		description: "Toggle the playwright_execute tool",
		argumentHint: "<on|off>",
		getArgumentCompletions: (prefix: string) => playwrightCompletions(prefix),
	});

	for (const skill of skills) {
		commands.push({
			name: `skill:${skill.name}`,
			description: skill.description,
		});
	}

	return new CombinedAutocompleteProvider(commands, cwd);
}

function modelCompletions(prefix: string): AutocompleteItem[] {
	const all = listCuaModels();
	const trimmed = prefix.trim().toLowerCase();
	const filtered = trimmed
		? all.filter((m) => m.ref.toLowerCase().includes(trimmed) || m.model.toLowerCase().includes(trimmed))
		: all;
	return filtered.map((m) => ({ value: m.ref, label: m.ref, description: m.name }));
}

const THINKING_LEVELS: ReadonlyArray<{ value: string; description: string }> = [
	{ value: "off", description: "Disable reasoning" },
	{ value: "minimal", description: "Minimal reasoning" },
	{ value: "low", description: "Low reasoning (default)" },
	{ value: "medium", description: "Medium reasoning" },
	{ value: "high", description: "High reasoning" },
	{ value: "xhigh", description: "Maximum reasoning (selected models only)" },
];

function thinkingCompletions(prefix: string): AutocompleteItem[] {
	const trimmed = prefix.trim().toLowerCase();
	const filtered = trimmed ? THINKING_LEVELS.filter((t) => t.value.startsWith(trimmed)) : THINKING_LEVELS;
	return filtered.map((t) => ({ value: t.value, label: t.value, description: t.description }));
}

const PLAYWRIGHT_TOGGLES: ReadonlyArray<{ value: string; description: string }> = [
	{ value: "on", description: "Enable the playwright_execute tool" },
	{ value: "off", description: "Disable the playwright_execute tool" },
];

function playwrightCompletions(prefix: string): AutocompleteItem[] {
	const trimmed = prefix.trim().toLowerCase();
	const filtered = trimmed ? PLAYWRIGHT_TOGGLES.filter((t) => t.value.startsWith(trimmed)) : PLAYWRIGHT_TOGGLES;
	return filtered.map((t) => ({ value: t.value, label: t.value, description: t.description }));
}

export type ParsedSlashCommand =
	| { command: "model"; argument: string }
	| { command: "thinking"; argument: string }
	| { command: "compact"; argument: string }
	| { command: "playwright"; argument: string }
	| { command: "skill"; name: string; remainder: string };

/**
 * Recognize the supported slash-command forms. Returns undefined when the
 * text is a regular user prompt.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const skillMatch = trimmed.match(/^\/skill:([A-Za-z0-9_\-.]+)\s*(.*)$/);
	if (skillMatch) {
		const [, name, rest] = skillMatch;
		return { command: "skill", name: name ?? "", remainder: (rest ?? "").trim() };
	}
	const builtinMatch = trimmed.match(/^\/(model|thinking|compact|playwright)\s*(.*)$/);
	if (builtinMatch) {
		const [, name, rest] = builtinMatch;
		return {
			command: name as "model" | "thinking" | "compact" | "playwright",
			argument: (rest ?? "").trim(),
		};
	}
	return undefined;
}
