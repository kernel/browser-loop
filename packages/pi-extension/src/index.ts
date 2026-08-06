import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCuaModels, type CuaToolSpec } from "@onkernel/cua-ai";
import { allSelectableSpecs, compileSpecs, DEFAULT_VIEWPORT, expandSelection, parseSelection, type CuaSelection } from "./catalog";
import { CuaBrowserRuntime, type BrowserOptions } from "./browser-runtime";
import { CONFIG_ENTRY, restoreConfig, type PersistedConfig } from "./state";
import { statusText } from "./render";

export default function cuaPiExtension(pi: ExtensionAPI): void {
	pi.registerFlag("cua-tools", { type: "string", description: "Comma-separated explicit CUA tool selectors" });
	pi.registerFlag("cua-coordinates", { type: "string", description: "pixels or normalized-1000", default: "pixels" });
	pi.registerFlag("cua-browser-session", { type: "string", description: "Attach an existing Kernel browser session" });
	pi.registerFlag("cua-profile-id", { type: "string", description: "Kernel browser profile id" });
	pi.registerFlag("cua-proxy-id", { type: "string", description: "Kernel proxy id" });
	pi.registerFlag("cua-browser-timeout", { type: "string", description: "Owned browser timeout in seconds", default: "300" });
	pi.registerFlag("cua-profile-save-changes", { type: "boolean", description: "Save owned browser profile changes", default: false });
	// Parsed flag values are unavailable until after the extension factory returns,
	// but session_start errors do not stop print/RPC provider calls.
	validateRawCliFlags();

	const extensionPath = fileURLToPath(import.meta.url);
	let selection = parseSelection(undefined, "pixels");
	let browserOptions: BrowserOptions = defaultBrowserOptions();
	let activeNames = new Set<string>();
	let compatibilityError: string | undefined;
	let initialized = false;
	let forcedInactive = false;
	let runtime: CuaBrowserRuntime | undefined;
	let allSpecs = new Map<string, CuaToolSpec>();

	function configureDeclarations(): void {
		allSpecs = new Map(allSelectableSpecs(selection.coordinates).map((spec) => [spec.name, spec]));
	}
	function installTools(): void {
		for (const [name, spec] of allSpecs) {
			const conflict = pi.getAllTools().find((tool) => tool.name === name);
			if (conflict && conflict.sourceInfo.path !== extensionPath) {
				throw new Error(`cannot register CUA tool "${name}": already owned by ${conflict.sourceInfo.source}`);
			}
			pi.registerTool({
				name: spec.name,
				label: spec.name,
				description: spec.declaration.description,
				parameters: spec.declaration.parameters,
				executionMode: "sequential",
				async execute(toolCallId, input, signal) {
					if (!activeNames.has(name)) throw new Error(`CUA tool "${name}" is not active`);
					const selected = currentSpecs().find((candidate) => candidate.name === name);
					if (!selected || compatibilityError) throw new Error(compatibilityError ?? `CUA tool "${name}" is no longer selected`);
					const resources = await ensureRuntime().get(signal);
					return resources.materialize(selected).execute(toolCallId, input, signal);
				},
			});
		}
	}
	function ensureRuntime(): CuaBrowserRuntime {
		return (runtime ??= new CuaBrowserRuntime(browserOptions));
	}
	function currentSpecs(viewport = DEFAULT_VIEWPORT): CuaToolSpec[] {
		return expandSelection(selection, viewport);
	}
	function activeSpecs(viewport = DEFAULT_VIEWPORT): CuaToolSpec[] {
		return currentSpecs(viewport).filter((spec) => activeNames.has(spec.name));
	}
	function persistCommandSelection(): void {
		const state: PersistedConfig = {
			version: 1,
			origin: "command",
			selectors: [...selection.selectors],
			coordinates: selection.coordinates,
			browser: runtime?.getStatus(),
		};
		pi.appendEntry(CONFIG_ENTRY, state);
	}
	function reconcile(ctx: ExtensionContext, activateInitial = false): void {
		const specs = currentSpecs();
		const current = pi.getActiveTools();
		const selectedNames = specs.map((spec) => spec.name);
		const priorCua = current.filter((name) => allSpecs.has(name));
		// After an extension-forced incompatibility deactivation, restore the selected
		// set when the next model is compatible. A user /tools deactivation remains off.
		const desired =
			!initialized || activateInitial || forcedInactive ? selectedNames : priorCua.filter((name) => selectedNames.includes(name));
		try {
			if (desired.length && !ctx.model) throw new Error("no pi model is selected");
			if (desired.length && ctx.model)
				compileSpecs(
					ctx.model,
					specs.filter((spec) => desired.includes(spec.name)),
					DEFAULT_VIEWPORT,
				);
			compatibilityError = undefined;
			forcedInactive = false;
			activeNames = new Set(desired);
			pi.setActiveTools([...current.filter((name) => !allSpecs.has(name)), ...desired]);
		} catch (error) {
			compatibilityError = error instanceof Error ? error.message : String(error);
			forcedInactive = true;
			activeNames = new Set();
			pi.setActiveTools(current.filter((name) => !allSpecs.has(name)));
		}
		initialized = true;
		if (ctx.mode === "tui")
			ctx.ui.setStatus("cua", statusText(selection.selectors, [...activeNames], runtime?.getStatus() ?? {}, compatibilityError));
	}

	const anthropic = createCuaModels().getProvider("anthropic");
	if (!anthropic) throw new Error("CUA Anthropic provider is unavailable");
	pi.registerProvider(anthropic);

	pi.registerCommand("cua", {
		description: "Show CUA tool and browser status",
		handler: async (_args, ctx) => {
			reconcile(ctx);
			ctx.ui.notify(
				statusText(selection.selectors, [...activeNames], runtime?.getStatus() ?? {}, compatibilityError),
				compatibilityError ? "error" : "info",
			);
		},
	});
	pi.registerCommand("cua-tools", {
		description: "Replace this session's explicit CUA selectors",
		handler: async (args, ctx) => {
			selection = parseSelection(args, selection.coordinates);
			// All selectable names were registered with this session's coordinate mode.
			reconcile(ctx, true);
			persistCommandSelection();
			ctx.ui.notify(
				statusText(selection.selectors, [...activeNames], runtime?.getStatus() ?? {}, compatibilityError),
				compatibilityError ? "error" : "info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await runtime?.close();
		const flags = readFlags(pi);
		selection = flags.selection;
		browserOptions = flags.browserOptions;
		const saved = restoreConfig(ctx.sessionManager.getBranch());
		if (saved) selection = parseSelection(saved.selectors.join(","), saved.coordinates);
		configureDeclarations();
		installTools();
		runtime = undefined;
		initialized = false;
		forcedInactive = false;
		reconcile(ctx, true);
	});
	pi.on("model_select", (_event, ctx) => reconcile(ctx));
	pi.on("before_agent_start", (_event, ctx) => reconcile(ctx));
	pi.on("before_provider_headers", (event, ctx) => {
		if (!activeNames.size || compatibilityError || !ctx.model) return;
		const catalog = compileSpecs(ctx.model, activeSpecs(), DEFAULT_VIEWPORT);
		Object.assign(event.headers, catalog.headers.merge(event.headers));
	});
	pi.on("before_provider_request", async (event, ctx) => {
		reconcile(ctx);
		if (!activeNames.size || compatibilityError || !ctx.model) {
			// setActiveTools() normally removes CUA declarations before serialization.
			// This hook is the final pre-wire guard for a model switch that invalidates
			// a catalog after pi has already built a payload for the turn.
			return currentSpecs().length ? withoutCuaToolSchemas(event.payload, allSpecs) : undefined;
		}
		let viewport = DEFAULT_VIEWPORT;
		let specs = activeSpecs();
		if (specs.some((spec) => spec.name === "computer" && spec.providerBinding?.kind === "anthropic-native")) {
			viewport = (await ensureRuntime().get()).viewport;
			specs = activeSpecs(viewport);
		}
		return compileSpecs(ctx.model, specs, viewport).payload.apply(event.payload, ctx.model);
	});
	pi.on("tool_call", (event) => {
		if (!allSpecs.has(event.toolName)) return;
		if (!activeNames.has(event.toolName) || compatibilityError)
			return { block: true, reason: compatibilityError ?? `CUA tool "${event.toolName}" is inactive` };
	});
	pi.on("session_shutdown", async () => {
		await runtime?.close();
		runtime = undefined;
	});
}

function validateRawCliFlags(argv = process.argv.slice(2)): void {
	const read = (name: string): string | undefined => {
		const equals = argv.find((arg) => arg.startsWith(`--${name}=`));
		if (equals) return equals.slice(name.length + 3);
		const index = argv.indexOf(`--${name}`);
		return index >= 0 && !argv[index + 1]?.startsWith("--") ? argv[index + 1] : undefined;
	};
	parseSelection(read("cua-tools"), read("cua-coordinates") ?? "pixels");
	const sessionId = trim(read("cua-browser-session"));
	if (sessionId && (trim(read("cua-profile-id")) || trim(read("cua-proxy-id"))))
		throw new Error("--cua-browser-session cannot be combined with --cua-profile-id or --cua-proxy-id");
	positiveSeconds(read("cua-browser-timeout"));
}
function readFlags(pi: ExtensionAPI): { selection: CuaSelection; browserOptions: BrowserOptions } {
	const browserOptions: BrowserOptions = {
		sessionId: trim(asString(pi.getFlag("cua-browser-session"))),
		profileId: trim(asString(pi.getFlag("cua-profile-id"))),
		proxyId: trim(asString(pi.getFlag("cua-proxy-id"))),
		timeoutSeconds: positiveSeconds(asString(pi.getFlag("cua-browser-timeout"))),
		saveProfileChanges: pi.getFlag("cua-profile-save-changes") === true,
	};
	if (browserOptions.sessionId && (browserOptions.profileId || browserOptions.proxyId))
		throw new Error("--cua-browser-session cannot be combined with --cua-profile-id or --cua-proxy-id");
	return { selection: parseSelection(asString(pi.getFlag("cua-tools")), asString(pi.getFlag("cua-coordinates"))), browserOptions };
}
function defaultBrowserOptions(): BrowserOptions {
	return { timeoutSeconds: 300, saveProfileChanges: false };
}
function asString(value: boolean | string | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}
function trim(value: string | undefined): string | undefined {
	const result = value?.trim();
	return result || undefined;
}
function positiveSeconds(value: string | undefined): number {
	const seconds = Number(value ?? "300");
	if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 259200)
		throw new Error("--cua-browser-timeout must be a whole number from 1 to 259200");
	return seconds;
}

function withoutCuaToolSchemas(payload: unknown, cuaSpecs: ReadonlyMap<string, CuaToolSpec>): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.tools)) return payload;
	const tools: unknown[] = [];
	for (const tool of payload.tools) {
		if (isRecord(tool) && Array.isArray(tool.functionDeclarations)) {
			const functionDeclarations = tool.functionDeclarations.filter((declaration) => {
				const name = serializedToolName(declaration);
				return !name || !cuaSpecs.has(name);
			});
			if (functionDeclarations.length) tools.push({ ...tool, functionDeclarations });
			continue;
		}
		const name = serializedToolName(tool);
		if (!name || !cuaSpecs.has(name)) tools.push(tool);
	}
	return { ...payload, tools };
}

function serializedToolName(tool: unknown): string | undefined {
	if (!isRecord(tool)) return undefined;
	if (typeof tool.name === "string") return tool.name;
	return isRecord(tool.function) && typeof tool.function.name === "string" ? tool.function.name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
