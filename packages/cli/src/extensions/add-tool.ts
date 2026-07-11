import type { AgentToolResult } from "@onkernel/cua-agent";
import {
	createSyntheticSourceInfo,
	discoverAndLoadExtensions,
	type RegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface AddToolInput {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: string;
}

export interface AddToolDetails {
	written: string;
	valid: true;
	addedToolNames: string[];
}

export interface AddToolRegistrationOptions {
	cwd: string;
	extensionRoot: string | undefined;
	hasToolName(name: string): boolean;
	installTool(registration: RegisteredTool): Promise<void>;
}

const ADD_TOOL_NAME = "add_tool";
const TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

const ADD_TOOL_DESCRIPTION = [
	"Add one trusted project-local tool and make it available immediately.",
	"The definition is validated, persisted beneath .agents/extensions, and",
	"activated before this call returns, so it can be called on the next model turn.",
	"The execute field must be one async function expression. This capability is not",
	"a sandbox: execute code has the same Node.js access as other local extensions.",
].join("\n");

const ADD_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		name: {
			type: "string",
			description: "provider-safe tool name (letters, digits, _ and -)",
		},
		label: { type: "string", description: "display label; defaults to name" },
		description: { type: "string", description: "non-empty tool description" },
		parameters: {
			type: "object",
			description: 'JSON Schema with top-level type "object"',
		},
		execute: {
			type: "string",
			description:
				"one async function expression with signature (toolCallId, params, signal, onUpdate)",
		},
	},
	required: ["name", "description", "parameters", "execute"],
	additionalProperties: false,
} as const;

/** Build the normal Pi tool registration used by the compatibility host. */
export function createAddToolRegistration(
	options: AddToolRegistrationOptions,
): RegisteredTool {
	return {
		definition: {
			name: ADD_TOOL_NAME,
			label: "Add tool",
			description: ADD_TOOL_DESCRIPTION,
			parameters: ADD_TOOL_PARAMETERS,
			executionMode: "sequential",
			execute: async (
				_toolCallId,
				rawInput,
			): Promise<AgentToolResult<AddToolDetails>> => addTool(options, rawInput),
		},
		sourceInfo: createSyntheticSourceInfo(ADD_TOOL_NAME, {
			source: "cua --self-extend",
			scope: "project",
			baseDir: options.cwd,
		}),
	};
}

async function addTool(
	options: AddToolRegistrationOptions,
	input: unknown,
): Promise<AgentToolResult<AddToolDetails>> {
	const extensionRoot = options.extensionRoot;
	if (!extensionRoot)
		throw new Error("no project extension directory configured for add_tool");
	const normalized = validateAddToolInput(input);
	const target = join(extensionRoot, `${normalized.name}.ts`);
	if (options.hasToolName(normalized.name)) {
		throw new Error(`tool name "${normalized.name}" already exists`);
	}

	await mkdir(extensionRoot, { recursive: true });
	const stagingDir = await mkdtemp(join(extensionRoot, ".add-tool-"));
	const stagedFile = join(stagingDir, `${normalized.name}.ts`);
	try {
		await writeFile(stagedFile, renderToolExtension(normalized), {
			encoding: "utf8",
			flag: "wx",
		});
		const registered = await trialLoadTool(
			stagedFile,
			normalized.name,
			stagingDir,
		);
		try {
			await link(stagedFile, target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new Error(`extension already exists at ${target}`);
			}
			throw error;
		}

		try {
			await options.installTool({
				definition: registered.definition,
				sourceInfo: createSyntheticSourceInfo(target, {
					source: target,
					scope: "project",
					baseDir: extensionRoot,
				}),
			});
		} catch (error) {
			await rm(target, { force: true });
			throw error;
		}

		return {
			content: [{ type: "text", text: `added ${normalized.name} at ${target}` }],
			details: {
				written: target,
				valid: true,
				addedToolNames: [normalized.name],
			},
		};
	} finally {
		await rm(stagingDir, { recursive: true, force: true });
	}
}

async function trialLoadTool(
	filePath: string,
	expectedName: string,
	isolatedRoot: string,
): Promise<RegisteredTool> {
	const result = await discoverAndLoadExtensions(
		[filePath],
		isolatedRoot,
		isolatedRoot,
	);
	if (result.errors.length > 0) {
		throw new Error(
			`tool validation failed: ${result.errors.map((entry) => entry.error).join("; ")}`,
		);
	}
	const registrations = result.extensions.flatMap((extension) => [
		...extension.tools.values(),
	]);
	if (
		registrations.length !== 1 ||
		registrations[0]?.definition.name !== expectedName
	) {
		throw new Error(
			`generated extension must register exactly one tool named "${expectedName}"`,
		);
	}
	const registration = registrations[0];
	if (
		typeof registration.definition.execute !== "function" ||
		registration.definition.execute.constructor.name !== "AsyncFunction"
	) {
		throw new Error("execute must be one async function expression");
	}
	return registration;
}

function validateAddToolInput(input: unknown): Required<AddToolInput> {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new Error("tool definition must be an object");
	}
	const candidate = input as Record<string, unknown>;
	if (
		typeof candidate.name !== "string" ||
		!TOOL_NAME_PATTERN.test(candidate.name)
	) {
		throw new Error(
			"name must start with a letter, contain only letters, digits, _ or -, and be at most 64 characters",
		);
	}
	const label = candidate.label ?? candidate.name;
	if (typeof label !== "string" || label.trim().length === 0)
		throw new Error("label must be non-empty");
	if (
		typeof candidate.description !== "string" ||
		candidate.description.trim().length === 0
	) {
		throw new Error("description must be non-empty");
	}
	if (
		!candidate.parameters ||
		typeof candidate.parameters !== "object" ||
		Array.isArray(candidate.parameters) ||
		(candidate.parameters as Record<string, unknown>).type !== "object"
	) {
		throw new Error(
			'parameters must be a JSON-serializable object schema with top-level type "object"',
		);
	}
	try {
		JSON.stringify(candidate.parameters);
	} catch {
		throw new Error("parameters must be JSON-serializable");
	}
	if (
		typeof candidate.execute !== "string" ||
		!/^(?:\s*)async\b/.test(candidate.execute) ||
		hasTopLevelComma(candidate.execute)
	) {
		throw new Error("execute must be one async function expression");
	}
	return {
		name: candidate.name,
		label,
		description: candidate.description,
		parameters: candidate.parameters as Record<string, unknown>,
		execute: candidate.execute,
	};
}

function hasTopLevelComma(source: string): boolean {
	let parens = 0;
	let braces = 0;
	let brackets = 0;
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;
	for (const character of source) {
		if (quote) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = undefined;
			continue;
		}
		if (character === "'" || character === '"' || character === "`") {
			quote = character;
			continue;
		}
		if (character === "(") parens += 1;
		else if (character === ")") parens -= 1;
		else if (character === "{") braces += 1;
		else if (character === "}") braces -= 1;
		else if (character === "[") brackets += 1;
		else if (character === "]") brackets -= 1;
		else if (character === "," && parens === 0 && braces === 0 && brackets === 0)
			return true;
	}
	return false;
}

export function renderToolExtension(input: Required<AddToolInput>): string {
	return [
		`const name = ${JSON.stringify(input.name)};`,
		`const label = ${JSON.stringify(input.label)};`,
		`const description = ${JSON.stringify(input.description)};`,
		`const parameters = ${JSON.stringify(input.parameters)};`,
		"",
		"export default function (pi) {",
		"\tpi.registerTool({",
		"\t\tname,",
		"\t\tlabel,",
		"\t\tdescription,",
		"\t\tparameters,",
		`\t\texecute: (${input.execute}),`,
		"\t});",
		"}",
		"",
	].join("\n");
}
