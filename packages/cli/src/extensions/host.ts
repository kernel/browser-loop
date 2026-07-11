import type {
	AgentHarness,
	AgentTool,
	AgentToolResult,
	Session,
} from "@onkernel/cua-agent";
import type { ImageContent } from "@onkernel/cua-ai";
import {
	AuthStorage,
	createSyntheticSourceInfo,
	discoverAndLoadExtensions,
	ExtensionRunner,
	ModelRegistry,
	SessionManager,
	wrapRegisteredTool,
	wrapRegisteredTools,
} from "@earendil-works/pi-coding-agent";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	RegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installBridge, type BridgeState } from "./bridge";
import {
	makeExtensionActions,
	makeExtensionCommandContextActions,
	makeExtensionContextActions,
} from "./seams";

export interface HarnessExtensionHostOptions {
	harness: AgentHarness;
	/** The same `Session` the harness was constructed with; used for entry writes. */
	session: Session;
	cwd: string;
	/** Extension paths passed straight to `discoverAndLoadExtensions`. */
	configuredPaths: string[];
	/** Agent config dir searched for `extensions/`. Pass a temp dir to isolate from `~/.agents`. */
	agentDir?: string;
	/**
	 * Capture the first-turn screenshot for extension-initiated user messages, so
	 * `pi.sendUserMessage` follows the same convention as the CLI's own prompt
	 * call sites. Omit in headless contexts with no browser; when absent the first
	 * turn is sent without an attached screenshot.
	 */
	initialScreenshot?: () => Promise<ImageContent[] | undefined>;
	/**
	 * Opt-in: expose `add_tool`, which persists and immediately activates one
	 * constrained project-local tool extension. Off by default.
	 */
	selfExtend?: boolean;
}

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

export type ReloadOutcome = "reloaded" | "coalesced" | "disposed";

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

/** Loads pi extensions into a headless `CuaAgentHarness`. */
export class HarnessExtensionHost {
	private readonly harness: AgentHarness;
	private readonly session: Session;
	private readonly cwd: string;
	private readonly configuredPaths: string[];
	private readonly agentDir?: string;
	private readonly initialScreenshot?: () => Promise<
		ImageContent[] | undefined
	>;
	private readonly selfExtend: boolean;
	private readonly extensionRoot: string | undefined;
	private readonly sessionManager: SessionManager;
	private readonly modelRegistry: ModelRegistry;

	private addTool: AgentTool | undefined;
	private readonly runtimeTools = new Map<string, AgentTool>();

	private readonly actions: ExtensionActions;
	private readonly contextActions: ExtensionContextActions;
	private readonly commandActions: ExtensionCommandContextActions;

	private runner: ExtensionRunner | undefined;
	private teardownBridge: (() => void) | undefined;
	private readonly bridgeState: BridgeState = { turnIndex: 0, isIdle: true };

	private extensionTools: AgentTool[] = [];
	private readonly inactiveExtensionTools = new Set<string>();
	private toolUpdate = Promise.resolve();
	private reloadPromise: Promise<ReloadOutcome> | undefined;
	private shutdownRequested = false;
	private disposed = false;
	private teardownDone = false;
	private loaded = false;
	private startedUp = false;
	private sessionName: string | undefined;

	/** Load errors surfaced from the last discover; non-fatal. */
	loadErrors: Array<{ path: string; error: string }> = [];

	constructor(options: HarnessExtensionHostOptions) {
		this.harness = options.harness;
		this.session = options.session;
		this.cwd = options.cwd;
		this.configuredPaths = options.configuredPaths;
		this.agentDir = options.agentDir;
		this.initialScreenshot = options.initialScreenshot;
		this.selfExtend = options.selfExtend ?? false;
		this.extensionRoot = options.configuredPaths[0];
		this.sessionManager = SessionManager.inMemory(this.cwd);
		this.modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());

		this.actions = makeExtensionActions(this.harness, this.session, {
			refreshTools: () => {
				void this.reapplyTools().catch((error) =>
					this.recordToolUpdateError(error),
				);
			},
			getActiveTools: () => this.desiredActiveToolNames(),
			sendUserMessage: (text) => this.promptUserMessage(text),
			setActiveTools: (names) => this.applyActiveTools(names),
			getSessionName: () => this.sessionName,
			setSessionName: (name) => {
				this.sessionName = name;
			},
		});
		this.contextActions = makeExtensionContextActions(this.harness, {
			isIdle: () => this.bridgeState.isIdle,
			getSignal: () => undefined,
			shutdown: () => this.requestShutdown(),
		});
		this.commandActions = makeExtensionCommandContextActions(
			this.harness,
			async () => {
				await this.reload();
			},
		);
	}

	/** True once the host has been torn down (via dispose or `ctx.shutdown()`). */
	isDisposed(): boolean {
		return this.disposed;
	}

	async load(): Promise<void> {
		if (this.disposed) throw new Error("cannot load a disposed extension host");
		if (this.loaded) return;
		await this.buildRunner();
		try {
			await this.reapplyTools();
			this.installBridge();
			await this.runner?.emit({ type: "session_start", reason: "startup" });
		} catch (error) {
			this.uninstallBridge();
			this.runner?.invalidate();
			this.runner = undefined;
			throw error;
		}
		this.loaded = true;
		this.startedUp = true;
		if (this.shutdownRequested) await this.dispose();
	}

	reload(): Promise<ReloadOutcome> {
		if (this.disposed) return Promise.resolve("disposed");
		if (this.reloadPromise)
			return this.reloadPromise.then((outcome) =>
				outcome === "disposed" ? "disposed" : "coalesced",
			);
		const operation = this.reloadNow();
		this.reloadPromise = operation;
		const clear = () => {
			if (this.reloadPromise === operation) this.reloadPromise = undefined;
		};
		void operation.then(clear, clear);
		return operation;
	}

	private async reloadNow(): Promise<ReloadOutcome> {
		await this.harness.waitForIdle();
		if (this.disposed) return "disposed";

		const previousRunner = this.runner;
		const previousAddTool = this.addTool;
		const previousLoadErrors = this.loadErrors;
		const previousRuntimeTools = new Map(this.runtimeTools);
		const previousExtensionTools = this.extensionTools;
		const flags = previousRunner?.getFlagValues() ?? new Map();
		const candidate = await this.createRunner();
		if (this.disposed) {
			candidate.runner.invalidate();
			return "disposed";
		}
		for (const [name, value] of flags) candidate.runner.setFlagValue(name, value);

		await previousRunner?.emit({ type: "session_shutdown", reason: "reload" });
		if (this.disposed || this.shutdownRequested) {
			candidate.runner.invalidate();
			await this.disposeNow();
			return "disposed";
		}
		this.teardownBridge?.();
		this.teardownBridge = undefined;
		this.runner = candidate.runner;
		this.addTool = candidate.addTool;
		this.loadErrors = candidate.loadErrors;
		this.extensionTools = [
			...this.extensionTools,
			...this.runtimeTools.values(),
		];
		this.runtimeTools.clear();
		try {
			await this.reapplyTools();
			if (this.disposed || this.shutdownRequested) {
				candidate.runner.invalidate();
				previousRunner?.invalidate();
				await this.disposeNow();
				return "disposed";
			}
			this.installBridge();
			await this.runner.emit({ type: "session_start", reason: "reload" });
			if (this.disposed || this.shutdownRequested) {
				previousRunner?.invalidate();
				await this.disposeNow();
				return "disposed";
			}
			previousRunner?.invalidate();
			return "reloaded";
		} catch (error) {
			candidate.runner.invalidate();
			this.uninstallBridge();
			this.runner = previousRunner;
			this.addTool = previousAddTool;
			this.loadErrors = previousLoadErrors;
			this.extensionTools = previousExtensionTools;
			this.runtimeTools.clear();
			for (const [name, tool] of previousRuntimeTools)
				this.runtimeTools.set(name, tool);
			if (!this.disposed) {
				await this.reapplyTools().catch(() => {});
				this.installBridge();
				await previousRunner?.emit({ type: "session_start", reason: "reload" });
			}
			throw error;
		}
	}

	async dispose(): Promise<void> {
		if (this.teardownDone) return;
		this.shutdownRequested = true;
		this.disposed = true;
		await this.reloadPromise?.catch(() => {});
		await this.toolUpdate.catch(() => {});
		await this.disposeNow();
	}

	private async disposeNow(): Promise<void> {
		if (this.teardownDone) return;
		this.teardownDone = true;
		this.shutdownRequested = true;
		this.disposed = true;
		this.teardownBridge?.();
		this.teardownBridge = undefined;
		await this.removeMergedTools();
		const runner = this.runner;
		await runner?.emit({ type: "session_shutdown", reason: "quit" });
		runner?.invalidate();
		this.runner = undefined;
	}

	private async removeMergedTools(): Promise<void> {
		const merged = new Set(
			[this.addTool, ...this.extensionTools, ...this.runtimeTools.values()]
				.filter((tool): tool is AgentTool => tool !== undefined)
				.map((tool) => tool.name),
		);
		if (merged.size === 0) return;
		await this.mutateHarnessTools(async () => {
			const base = this.harness
				.getTools()
				.filter((tool) => !merged.has(tool.name));
			const active = this.harness
				.getActiveTools()
				.map((tool) => tool.name)
				.filter((name) => !merged.has(name));
			await this.harness.setTools(base, active);
		}).catch(() => {});
	}

	private async buildRunner(): Promise<void> {
		const built = await this.createRunner();
		this.loadErrors = built.loadErrors;
		this.runner = built.runner;
		this.addTool = built.addTool;
	}

	private async createRunner(): Promise<{
		runner: ExtensionRunner;
		addTool: AgentTool | undefined;
		loadErrors: Array<{ path: string; error: string }>;
	}> {
		const result = await discoverAndLoadExtensions(
			this.configuredPaths,
			this.cwd,
			this.agentDir,
		);
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			this.cwd,
			this.sessionManager,
			this.modelRegistry,
		);
		runner.bindCore(this.actions, this.contextActions);
		runner.bindCommandContext(this.commandActions);
		runner.setUIContext(undefined, "print");
		return {
			runner,
			addTool: this.selfExtend
				? wrapRegisteredTool(this.makeAddToolRegistration(), runner)
				: undefined,
			loadErrors: result.errors,
		};
	}

	private reapplyTools(): Promise<void> {
		const update = this.toolUpdate.then(() => this.applyToolsNow());
		this.toolUpdate = update.catch(() => {});
		return update;
	}

	private async applyToolsNow(): Promise<void> {
		const runner = this.runner;
		if (!runner || this.disposed) return;
		await this.mutateHarnessTools(async () => {
			if (runner !== this.runner || this.disposed) return;
			const ownedBefore = new Set(
				[this.addTool, ...this.extensionTools, ...this.runtimeTools.values()]
					.filter((tool): tool is AgentTool => tool !== undefined)
					.map((tool) => tool.name),
			);
			const base = this.harness
				.getTools()
				.filter((tool) => !ownedBefore.has(tool.name));
			const baseNames = new Set(base.map((tool) => tool.name));
			const reservedNames = new Set([
				...(this.addTool ? [this.addTool.name] : []),
				...this.runtimeTools.keys(),
			]);
			const diskTools = wrapRegisteredTools(
				runner.getAllRegisteredTools(),
				runner,
			).filter((tool) => {
				const collidesWith = reservedNames.has(tool.name)
					? "a host-provided tool"
					: baseNames.has(tool.name)
						? "a built-in tool"
						: undefined;
				if (!collidesWith) return true;
				const error = `extension tool "${tool.name}" collides with ${collidesWith} and was dropped`;
				if (
					!this.loadErrors.some(
						(entry) => entry.path === tool.name && entry.error === error,
					)
				) {
					this.loadErrors.push({ path: tool.name, error });
				}
				return false;
			});
			const runtimeTools = [...this.runtimeTools.values()];
			const final = [
				...base,
				...(this.addTool ? [this.addTool] : []),
				...diskTools,
				...runtimeTools,
			];
			const finalNames = new Set(final.map((tool) => tool.name));
			const activeNames = new Set(
				this.harness
					.getActiveTools()
					.map((tool) => tool.name)
					.filter((name) => finalNames.has(name)),
			);
			if (this.addTool) activeNames.add(this.addTool.name);
			for (const tool of [...diskTools, ...runtimeTools]) {
				if (!this.inactiveExtensionTools.has(tool.name))
					activeNames.add(tool.name);
			}
			await this.harness.setTools(final, [...activeNames]);
			this.extensionTools = diskTools;
		});
	}

	private mutateHarnessTools<T>(mutation: () => Promise<T>): Promise<T> {
		const harness = this.harness as AgentHarness & {
			mutateTools?: <R>(callback: () => Promise<R>) => Promise<R>;
		};
		return harness.mutateTools ? harness.mutateTools(mutation) : mutation();
	}

	private desiredActiveToolNames(): string[] {
		const current = new Set(
			this.harness.getActiveTools().map((tool) => tool.name),
		);
		if (this.addTool) current.add(this.addTool.name);
		for (const tool of [
			...this.extensionTools,
			...this.runtimeTools.values(),
		]) {
			if (!this.inactiveExtensionTools.has(tool.name)) current.add(tool.name);
		}
		for (const registered of this.runner?.getAllRegisteredTools() ?? []) {
			if (!this.inactiveExtensionTools.has(registered.definition.name))
				current.add(registered.definition.name);
		}
		return [...current];
	}

	private recordToolUpdateError(error: unknown): void {
		this.loadErrors.push({
			path: "<tools_update>",
			error: error instanceof Error ? error.message : String(error),
		});
	}

	private async applyActiveTools(names: string[]): Promise<void> {
		const active = new Set(names);
		for (const tool of [...this.extensionTools, ...this.runtimeTools.values()]) {
			if (active.has(tool.name)) this.inactiveExtensionTools.delete(tool.name);
			else this.inactiveExtensionTools.add(tool.name);
		}
		await this.mutateHarnessTools(async () => {
			await this.harness.setActiveTools(names);
		});
	}

	private uninstallBridge(): void {
		const teardown = this.teardownBridge;
		this.teardownBridge = undefined;
		teardown?.();
	}

	private installBridge(): void {
		if (!this.runner) return;
		this.teardownBridge = installBridge(
			this.harness,
			this.runner,
			this.bridgeState,
			() => this.reapplyTools(),
		);
	}

	private makeAddToolRegistration(): RegisteredTool {
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
				): Promise<AgentToolResult<AddToolDetails>> =>
					this.addToolDefinition(rawInput),
			},
			sourceInfo: createSyntheticSourceInfo(ADD_TOOL_NAME, {
				source: "cua --self-extend",
				scope: "project",
				baseDir: this.cwd,
			}),
		};
	}

	private async addToolDefinition(
		input: unknown,
	): Promise<AgentToolResult<AddToolDetails>> {
		if (!this.runner) throw new Error("extension host is not loaded");
		const extensionRoot = this.extensionRoot;
		if (!extensionRoot)
			throw new Error("no project extension directory configured for add_tool");
		const normalized = validateAddToolInput(input);
		const target = join(extensionRoot, `${normalized.name}.ts`);
		const existingNames = new Set(
			this.harness.getTools().map((tool) => tool.name),
		);
		if (
			existingNames.has(normalized.name) ||
			this.runtimeTools.has(normalized.name)
		) {
			throw new Error(`tool name "${normalized.name}" already exists`);
		}

		await mkdir(extensionRoot, { recursive: true });
		const stagingDir = await mkdtemp(join(extensionRoot, ".add-tool-"));
		const stagedFile = join(stagingDir, `${normalized.name}.ts`);
		let published = false;
		try {
			await writeFile(stagedFile, renderToolExtension(normalized), {
				encoding: "utf8",
				flag: "wx",
			});
			const registered = await this.trialLoadTool(
				stagedFile,
				normalized.name,
				stagingDir,
			);
			try {
				await link(stagedFile, target);
				published = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					throw new Error(`extension already exists at ${target}`);
				}
				throw error;
			}
			const liveRegistration: RegisteredTool = {
				definition: registered.definition,
				sourceInfo: createSyntheticSourceInfo(target, {
					source: target,
					scope: "project",
					baseDir: extensionRoot,
				}),
			};
			this.runtimeTools.set(
				normalized.name,
				wrapRegisteredTool(liveRegistration, this.runner),
			);
			try {
				await this.reapplyTools();
			} catch (error) {
				this.runtimeTools.delete(normalized.name);
				await rm(target, { force: true });
				published = false;
				await this.reapplyTools().catch(() => {});
				throw error;
			}
			return {
				content: [
					{ type: "text", text: `added ${normalized.name} at ${target}` },
				],
				details: {
					written: target,
					valid: true,
					addedToolNames: [normalized.name],
				},
			};
		} finally {
			await rm(stagingDir, { recursive: true, force: true });
			if (!published) this.runtimeTools.delete(normalized.name);
		}
	}

	private async trialLoadTool(
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

	private requestShutdown(): void {
		this.shutdownRequested = true;
		if (!this.reloadPromise) void this.dispose();
	}

	private async promptUserMessage(text: string): Promise<void> {
		try {
			const images = await this.maybeInitialScreenshot();
			await this.harness.prompt(text, images ? { images } : undefined);
		} catch (error) {
			this.loadErrors.push({
				path: "<sendUserMessage>",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async maybeInitialScreenshot(): Promise<ImageContent[] | undefined> {
		if (!this.initialScreenshot) return undefined;
		if (!this.startedUp) return undefined;
		if (await sessionHasPriorTurn(this.session)) return undefined;
		return this.initialScreenshot();
	}
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

async function sessionHasPriorTurn(session: Session): Promise<boolean> {
	const entries = await session.getBranch();
	return entries.some(
		(entry) =>
			entry.type === "message" &&
			(entry.message.role === "user" || entry.message.role === "assistant"),
	);
}
