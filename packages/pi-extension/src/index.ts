import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createCuaModels,
	type Api,
	type CuaIncomingToolPlan,
	type CuaToolCatalog,
	type CuaToolSpec,
	type Model,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@onkernel/cua-ai";
import {
	allSelectableSpecs,
	compileSpecs,
	CUA_SELECTORS,
	expandSelection,
	parseSelection,
	selectorAvailability,
	type CuaSelection,
} from "./selection";
import { CuaBrowserRuntime, type BrowserOptions } from "./browser-runtime";
import { CONFIG_ENTRY, restoreConfig, type PersistedConfig } from "./state";
import { availabilityText, statusText } from "./render";

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
	let warnedError: string | undefined;
	let initialized = false;
	let forcedInactive = false;
	let sessionActive = false;
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
		if (!sessionActive) throw new Error("CUA browser runtime is unavailable outside an active pi session");
		return (runtime ??= new CuaBrowserRuntime(browserOptions));
	}
	function currentSpecs(): CuaToolSpec[] {
		return expandSelection(selection);
	}
	function activeSpecs(): CuaToolSpec[] {
		return currentSpecs().filter((spec) => activeNames.has(spec.name));
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
			if (desired.length && ctx.model) {
				compileSpecs(
					ctx.model,
					specs.filter((spec) => desired.includes(spec.name)),
				);
			}
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
		if (ctx.mode === "tui") {
			ctx.ui.setStatus("cua", statusText(selection.selectors, [...activeNames], runtime?.getStatus() ?? {}, compatibilityError));
		} else if (compatibilityError && compatibilityError !== warnedError) {
			// Print and RPC have no status line, and silence here is the worst failure
			// this extension can produce: the tools vanish, no browser is created, and
			// the model answers from memory with exit 0. Say so on stderr, once per
			// distinct reason so a multi-turn run does not repeat itself.
			process.stderr.write(`cua: no browser tool is active — ${compatibilityError}\n`);
			warnedError = compatibilityError;
		}
		if (!compatibilityError) warnedError = undefined;
	}
	/**
	 * The compiled catalog for the model pi is about to stream with, or undefined
	 * when no CUA tool is active. Compiling is pure and cheap, so this re-derives
	 * per request rather than caching a catalog that a model switch could stale.
	 */
	function streamCatalog(model: Model<Api>): CuaToolCatalog | undefined {
		if (!activeNames.size || compatibilityError) return undefined;
		try {
			return compileSpecs(model, activeSpecs());
		} catch {
			return undefined;
		}
	}

	/**
	 * Own the stream for every provider CUA wraps.
	 *
	 * This is what makes provider-native surfaces work inside pi. pi resolves and
	 * streams its own registry model, but the transport a native surface needs is
	 * derived onto the *compiled* model — so the wrapper swaps in `catalog.model`,
	 * which is the resolved model with only `api` replaced, and adds the incoming
	 * native-call plan that normalizes `computer_call`-style items and drives
	 * Anthropic's browser-beta fallback. pi's own resolved credential rides along
	 * in `options.apiKey`.
	 */
	function registerCuaProviders(): void {
		const models = createCuaModels();
		for (const id of ["anthropic", "openai", "google"]) {
			const base = models.getProvider(id);
			if (!base) continue;
			pi.registerProvider({
				...base,
				stream: (model, context, options) => {
					const catalog = streamCatalog(model);
					return base.stream(catalog?.model ?? model, context, withPlan(options, catalog));
				},
				streamSimple: (model, context, options) => {
					const catalog = streamCatalog(model);
					return base.streamSimple(catalog?.model ?? model, context, withPlan(options, catalog));
				},
			});
		}
	}

	function notifyStatus(ctx: ExtensionContext): void {
		ctx.ui.notify(
			statusText(selection.selectors, [...activeNames], runtime?.getStatus() ?? {}, compatibilityError),
			compatibilityError ? "error" : "info",
		);
	}

	registerCuaProviders();

	pi.registerCommand("cua", {
		description: "Show CUA tool and browser status",
		handler: async (_args, ctx) => {
			reconcile(ctx);
			notifyStatus(ctx);
		},
	});
	pi.registerCommand("cua-tools", {
		description: "Replace this session's explicit CUA selectors, or list what this model can take",
		handler: async (args, ctx) => {
			// No argument lists the menu instead of clearing the selection, because
			// clearing is the more destructive reading of an empty command.
			if (!args?.trim()) {
				if (!ctx.model) {
					ctx.ui.notify("cua: no pi model is selected", "error");
					return;
				}
				ctx.ui.notify(availabilityText(selectorAvailability(ctx.model, selection)), "info");
				return;
			}
			selection = parseSelection(args === "none" ? undefined : args, selection.coordinates);
			// All selectable names were registered with this session's coordinate mode.
			reconcile(ctx, true);
			persistCommandSelection();
			notifyStatus(ctx);
		},
	});

	// Pi creates a fresh extension instance after the previous instance finishes session_shutdown.
	pi.on("session_start", (_event, ctx) => {
		const flags = readFlags(pi);
		selection = flags.selection;
		browserOptions = flags.browserOptions;
		const saved = restoreConfig(ctx.sessionManager.getBranch());
		if (saved) {
			// A session persisted before the menu shrank can name a selector that no
			// longer exists. Restoring must not throw: drop what is gone, keep the rest,
			// and say so — a resumed session that refuses to start is worse than one
			// that starts with fewer tools.
			const known = saved.selectors.filter((selector) => CUA_SELECTORS.includes(selector));
			const dropped = saved.selectors.filter((selector) => !CUA_SELECTORS.includes(selector));
			if (dropped.length) {
				process.stderr.write(`cua: ignoring retired tool selector(s) from this session: ${dropped.join(", ")}\n`);
			}
			// Always apply what was restored, even when nothing survives. A persisted
			// selection came from `/cua-tools`, which deliberately overrides the flags,
			// so falling back to them would re-enable tools this session had replaced.
			// An empty selection with the note above is the honest outcome.
			selection = parseSelection(known.join(",") || undefined, saved.coordinates);
		}
		configureDeclarations();
		installTools();
		initialized = false;
		forcedInactive = false;
		sessionActive = true;
		reconcile(ctx, true);
	});
	pi.on("model_select", (_event, ctx) => reconcile(ctx));
	pi.on("before_agent_start", (_event, ctx) => reconcile(ctx));
	pi.on("before_provider_headers", (event, ctx) => {
		// Reconcile first, and tolerate a catalog that no longer compiles: a model
		// switch can invalidate one after this turn's tools were serialized, and
		// omitting CUA's headers is the correct outcome there. Without this the hook
		// throws, and a stale provider beta can survive into the request.
		reconcile(ctx);
		if (!activeNames.size || compatibilityError || !ctx.model) return;
		try {
			Object.assign(event.headers, compileSpecs(ctx.model, activeSpecs()).headers.merge(event.headers));
		} catch {
			/* the request hook strips the matching declarations */
		}
	});
	pi.on("before_provider_request", async (event, ctx) => {
		reconcile(ctx);
		if (!activeNames.size || compatibilityError || !ctx.model) {
			// setActiveTools() normally removes CUA declarations before serialization.
			// This hook is the final pre-wire guard for a model switch that invalidates
			// a catalog after pi has already built a payload for the turn.
			return currentSpecs().length ? withoutCuaToolSchemas(event.payload, allSpecs) : undefined;
		}
		return compileSpecs(ctx.model, activeSpecs()).payload.apply(event.payload, ctx.model);
	});
	pi.on("tool_call", (event) => {
		if (!allSpecs.has(event.toolName)) return;
		if (!activeNames.has(event.toolName) || compatibilityError)
			return { block: true, reason: compatibilityError ?? `CUA tool "${event.toolName}" is inactive` };
	});
	pi.on("session_shutdown", async () => {
		sessionActive = false;
		const closingRuntime = runtime;
		runtime = undefined;
		await closingRuntime?.close();
	});
}

/** Carry the compiled catalog's incoming native-call plan into pi's stream options. */
function withPlan<T extends StreamOptions | SimpleStreamOptions | undefined>(options: T, catalog: CuaToolCatalog | undefined): T {
	if (!catalog) return options;
	return { ...options, cuaIncomingToolPlan: catalog.incoming } as T & { cuaIncomingToolPlan: CuaIncomingToolPlan };
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
