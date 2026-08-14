import type { Api, Model, Tool } from "@earendil-works/pi-ai";
import type { CuaAction } from "./actions/index";
import type { CuaModelRef } from "./models";
import { cuaModelCapabilities, getCuaModel } from "./models";
import { anthropicAdaptiveThinkingOnPayload } from "./providers/anthropic/adaptive-thinking";
import {
	supportsAnthropicNativeBrowser,
	supportsAnthropicNativeComputer,
} from "./providers/anthropic/capabilities";
import { GOOGLE_CUA_INTERACTIONS_API } from "./providers/google/provider";
import { OPENAI_CUA_COMPUTER_API } from "./providers/openai/provider";

export const CUA_TOOL_SPEC_KIND = "@onkernel/cua-tool-spec/v1" as const;

export type CuaToolOrigin = "cua" | "provider-native";
export type CuaToolTransport = "function" | "native";
export type CuaToolDynamicLoading = "eligible" | "eager-only";

export type CuaCoordinateContract =
	| { readonly type: "pixel" }
	| { readonly type: "normalized"; readonly range: readonly [number, number] };

export type CuaToolExecution =
	| {
			readonly kind: "actions";
			readonly toActions: (input: unknown) => CuaAction[];
			readonly coordinates: CuaCoordinateContract;
			readonly batch: boolean;
			/** Block later calls in the same assistant turn after this tool fails. */
			readonly stopTurnOnFailureMessage?: string;
	  }
	| { readonly kind: "playwright" };

export type CuaProviderBinding =
	| {
			readonly kind: "anthropic-native";
			readonly declaration: Record<string, unknown>;
			readonly beta: string;
			readonly accessFallback?: CuaAnthropicBrowserFallback;
	  }
	| {
			readonly kind: "openai-native";
			readonly declaration: Record<string, unknown>;
			/** Transport this binding requires the compiled catalog's model to carry. */
			readonly requiresApi?: Api;
	  }
	| {
			readonly kind: "google-native";
			readonly nativeName: string;
			readonly allNativeNames: readonly string[];
			/** Transport this binding requires the compiled catalog's model to carry. */
			readonly requiresApi?: Api;
	  };

/** Declarative CUA tool. Identity is immutable and independent from its model-facing alias. */
export interface CuaToolSpec {
	readonly kind: typeof CUA_TOOL_SPEC_KIND;
	readonly identity: string;
	readonly preferredName: string;
	readonly name: string;
	readonly origin: CuaToolOrigin;
	/** First-party documentation for a provider-native tool surface. */
	readonly source?: string;
	readonly transport: CuaToolTransport;
	readonly dynamicLoading: CuaToolDynamicLoading;
	readonly declaration: Tool;
	/** @internal Local execution policy consumed by @onkernel/cua-agent. */
	readonly execution: CuaToolExecution;
	/** @internal Provider transport contribution consumed by the catalog compiler. */
	readonly providerBinding?: CuaProviderBinding;
	/** @internal True when the tool mutates shared browser state. */
	readonly stateMutating: boolean;
	/** @internal Complex schemas are deliberately allowlisted by provider. */
	readonly complexSchema?: boolean;
	/**
	 * @internal Very large union schemas are allowlisted separately from merely
	 * complex ones, because a provider can accept a complex schema yet reject one
	 * of this scale. `browser_act` declares roughly eight times the schema of the
	 * largest merely-complex tool.
	 */
	readonly largeSchema?: boolean;
}

/**
 * Sanitized declarative projection of a caller-owned tool. cua-ai never sees
 * executors: callers pass plain pi-ai `Tool` declarations and the executing
 * runtime (cua-agent) keeps the matching implementation.
 */
export type CuaCallerToolDeclaration = Tool;

/** Declarative catalog input: a CUA spec or a sanitized caller tool declaration. */
export type CuaCatalogToolInput = CuaToolSpec | CuaCallerToolDeclaration;

/**
 * Canonical identity scheme for caller-owned tools. Exported so every consumer
 * shares exactly one definition and cannot drift.
 */
export function callerToolIdentity(name: string): string {
	return `caller.${name}`;
}

export interface CuaToolInfo {
	identity: string;
	name: string;
	preferredName: string;
	origin: "cua" | "provider-native" | "caller";
	source?: string;
	transport: CuaToolTransport;
	dynamicLoading: CuaToolDynamicLoading;
	declaration: Tool | Record<string, unknown>;
	coordinates?: CuaCoordinateContract;
}

export interface CuaHeaderRequirement {
	identity: string;
	name: string;
	value: string;
	merge: "exact" | "comma-set";
}

export interface CuaHeaderPlan {
	readonly requirements: readonly CuaHeaderRequirement[];
	merge(callerHeaders?: Record<string, string | null | undefined>): Record<string, string> | undefined;
}

export interface CuaPayloadTransform {
	identity: string;
	consumesToolIdentities?: readonly string[];
	writes?: readonly string[];
	phase: "model-preparation" | "tool-declarations" | "provider-fields";
	apply(payload: unknown, model: Model<Api>, names: ReadonlyMap<string, string>): unknown | Promise<unknown>;
}

export interface CuaPayloadPlan {
	readonly transforms: readonly CuaPayloadTransform[];
	apply(payload: unknown, model: Model<Api>): Promise<unknown>;
}

/** Function-tool fallback for an Anthropic native browser tool unavailable to the active credential. */
export interface CuaAnthropicBrowserFallback {
	readonly beta: string;
	readonly nativeType: string;
	readonly declaration: Record<string, unknown>;
}

/** Identity-addressed native call dispatch passed to CUA custom provider streams. */
export interface CuaIncomingToolPlan {
	readonly anthropicBrowserFallback?: CuaAnthropicBrowserFallback;
	readonly openaiComputerName?: string;
	readonly googleNames: Readonly<Record<string, string>>;
	/** Google predefined functions disabled by the exact selected native subset. */
	readonly googleExcludedNames: readonly string[];
	readonly nativeToolNames: readonly string[];
}

export interface CuaToolCatalogEntry extends CuaToolInfo {
	readonly schemaFingerprint: string;
	readonly fingerprint: string;
}

export interface CuaToolCatalog {
	readonly model: Model<Api>;
	readonly entries: readonly CuaToolCatalogEntry[];
	/**
	 * Provider-facing pi-ai `Tool` declarations in entry order, suitable for
	 * `Context.tools`. Native placeholders are swapped by `payload` transforms.
	 */
	readonly toolDeclarations: readonly Tool[];
	readonly headers: CuaHeaderPlan;
	readonly payload: CuaPayloadPlan;
	readonly incoming: CuaIncomingToolPlan;
	readonly fingerprint: string;
}

export interface CompileCuaToolCatalogOptions {
	model: CuaModelRef | Model<Api>;
	requestedTools: readonly CuaCatalogToolInput[];
}

/**
 * Internal compilation state. The published catalog entry never retains the
 * requested spec/declaration objects or provider bindings used to compile it.
 */
interface CuaCatalogEntryDraft extends CuaToolCatalogEntry {
	readonly placeholder: Tool;
	readonly providerBinding?: CuaProviderBinding;
	readonly stateMutating?: boolean;
	readonly complexSchema?: boolean;
	readonly largeSchema?: boolean;
}

const SAFE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Compile exactly one identity-keyed catalog for a model and caller-owned
 * requested list. Pure and declaration-only: identical declaration and model
 * inputs produce identical catalogs, and compilation never constructs
 * executable tools or retains the requested input objects.
 *
 * The compiled model's `api` is derived here, not stamped on the model ahead
 * of time: a selected tool's provider binding may declare `requiresApi`, and
 * the returned `catalog.model` carries that transport. A model resolved with
 * no such tool selected keeps its ordinary registry `api`. Selecting tools
 * whose bindings require different transports fails to compile.
 */
export function compileCuaToolCatalog(options: CompileCuaToolCatalogOptions): CuaToolCatalog {
	const baseModel = typeof options.model === "string"
		? getCuaModel(options.model)
		: resetCatalogDerivedApi(options.model);
	const normalizedEntries = [...options.requestedTools].map(normalizeTool);
	const requiresApi = validateCatalog(baseModel, normalizedEntries);
	const model = requiresApi ? { ...baseModel, api: requiresApi } : baseModel;
	const drafts = resolveProviderFacingDeclarations(normalizedEntries);

	const names = new Map(drafts.map((entry) => [entry.identity, entry.name]));
	const requirements = compileHeaderRequirements(drafts);
	const transforms = compilePayloadTransforms(model, drafts);
	validateTransformClaims(transforms);
	const incoming = compileIncomingPlan(drafts);
	const fingerprint = stableStringify({
		model: [model.provider, model.id, model.api],
		entries: drafts.map((entry) => entry.fingerprint),
		headers: requirements,
		transforms: transforms.map((transform) => ({ identity: transform.identity, phase: transform.phase, writes: transform.writes })),
	});

	return Object.freeze({
		model,
		entries: Object.freeze(drafts.map(publishEntry)),
		toolDeclarations: Object.freeze(drafts.map((entry) => entry.placeholder)),
		headers: createHeaderPlan(requirements),
		payload: createPayloadPlan(model, transforms, names),
		incoming,
		fingerprint,
	});
}

/** Strip internal compilation state from a published catalog entry. */
function publishEntry(draft: CuaCatalogEntryDraft): CuaToolCatalogEntry {
	const {
		placeholder: _placeholder,
		providerBinding: _providerBinding,
		stateMutating: _stateMutating,
		complexSchema: _complexSchema,
		largeSchema: _largeSchema,
		...entry
	} = draft;
	return Object.freeze(entry);
}

export function isCuaToolSpec(value: unknown): value is CuaToolSpec {
	return Boolean(value && typeof value === "object" && (value as { kind?: unknown }).kind === CUA_TOOL_SPEC_KIND);
}

export function modelSupportsDeferredTools(model: Model<Api>): boolean {
	const compat = isRecord(model.compat) ? model.compat : undefined;
	if (model.provider === "openai") return compat?.supportsToolSearch === true;
	if (model.provider !== "anthropic" || model.id.toLowerCase().includes("haiku")) return false;
	if (typeof compat?.supportsToolReferences === "boolean") return compat.supportsToolReferences;
	const version = model.id.toLowerCase().match(/^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/);
	if (!version) return false;
	const major = Number(version[1]);
	const minor = version[2] && version[2].length < 8 ? Number(version[2]) : 0;
	return major > 4 || (major === 4 && minor >= 5);
}

function normalizeTool(tool: CuaCatalogToolInput): CuaCatalogEntryDraft {
	if (isCuaToolSpec(tool)) {
		const schemaFingerprint = stableStringify(tool.declaration.parameters);
		const fingerprint = stableStringify({
			identity: tool.identity,
			name: tool.name,
			schema: schemaFingerprint,
			coordinates: tool.execution.kind === "actions" ? tool.execution.coordinates : undefined,
		});
		const inspectedDeclaration = tool.providerBinding && "declaration" in tool.providerBinding
			? tool.providerBinding.declaration
			: tool.declaration;
		return Object.freeze({
			identity: tool.identity,
			name: tool.name,
			preferredName: tool.preferredName,
			origin: tool.origin,
			...(tool.source ? { source: tool.source } : {}),
			transport: tool.transport,
			dynamicLoading: tool.dynamicLoading,
			declaration: inspectedDeclaration,
			...(tool.execution.kind === "actions" ? { coordinates: tool.execution.coordinates } : {}),
			schemaFingerprint,
			fingerprint,
			placeholder: tool.declaration,
			...(tool.providerBinding ? { providerBinding: tool.providerBinding } : {}),
			...(tool.stateMutating ? { stateMutating: true } : {}),
			...(tool.complexSchema ? { complexSchema: true } : {}),
			...(tool.largeSchema ? { largeSchema: true } : {}),
		});
	}
	const identity = callerToolIdentity(tool.name);
	const schemaFingerprint = stableStringify(tool.parameters);
	// Fresh declaration-only projection: executable members never enter the catalog.
	const declaration = Object.freeze({ name: tool.name, description: tool.description, parameters: tool.parameters });
	return Object.freeze({
		identity,
		name: tool.name,
		preferredName: tool.name,
		origin: "caller" as const,
		transport: "function" as const,
		dynamicLoading: "eligible" as const,
		declaration,
		schemaFingerprint,
		fingerprint: stableStringify({ identity, name: tool.name, schema: schemaFingerprint }),
		placeholder: declaration,
	});
}

function resolveProviderFacingDeclarations(entries: readonly CuaCatalogEntryDraft[]): CuaCatalogEntryDraft[] {
	const google = entries.filter((entry) => entry.providerBinding?.kind === "google-native");
	const googleDeclaration = google.length > 0 ? (() => {
		const binding = google[0]!.providerBinding;
		if (binding?.kind !== "google-native") return undefined;
		const selected = new Set(google.map((entry) => {
			const selectedBinding = entry.providerBinding;
			return selectedBinding?.kind === "google-native" ? selectedBinding.nativeName : "";
		}));
		const excluded = binding.allNativeNames.filter((name) => !selected.has(name));
		return {
			type: "computer_use",
			environment: "browser",
			...(excluded.length ? { excluded_predefined_functions: excluded } : {}),
		};
	})() : undefined;

	return entries.map((entry) => {
		const declaration = entry.providerBinding?.kind === "google-native" ? googleDeclaration : undefined;
		return declaration ? Object.freeze({ ...entry, declaration: Object.freeze(declaration) }) : entry;
	});
}

/** Validate the requested catalog against the model and return the transport its selected tools require, if any. */
function validateCatalog(model: Model<Api>, entries: readonly CuaCatalogEntryDraft[]): Api | undefined {
	const identities = new Map<string, CuaCatalogEntryDraft>();
	const exactNames = new Map<string, CuaCatalogEntryDraft>();
	const normalizedNames = new Map<string, CuaCatalogEntryDraft>();
	const normalizeName = model.provider === "anthropic" ? (name: string) => name.toLowerCase() : (name: string) => name;

	for (const entry of entries) {
		if (!SAFE_TOOL_NAME.test(entry.name)) {
			throw new Error(`tool name "${entry.name}" from "${entry.identity}" must match ${SAFE_TOOL_NAME}`);
		}
		const duplicateIdentity = identities.get(entry.identity);
		if (duplicateIdentity) {
			throw new Error(`tool identity "${entry.identity}" is requested more than once (names "${duplicateIdentity.name}" and "${entry.name}")`);
		}
		identities.set(entry.identity, entry);

		const exact = exactNames.get(entry.name);
		if (exact) throw nameCollision(entry.name, exact, entry);
		exactNames.set(entry.name, entry);

		const key = normalizeName(entry.name);
		const normalized = normalizedNames.get(key);
		if (normalized) throw nameCollision(entry.name, normalized, entry, model.provider);
		normalizedNames.set(key, entry);
		validateToolCompatibility(model, entry);
	}

	return validateToolsetCompatibility(model, entries);
}

function nameCollision(
	name: string,
	first: CuaCatalogEntryDraft,
	second: CuaCatalogEntryDraft,
	provider?: string,
): Error {
	const suffix = provider ? ` after ${provider} name normalization` : "";
	return new Error(`tool name "${name}" is requested by both "${first.identity}" and "${second.identity}"${suffix}`);
}

function validateToolCompatibility(model: Model<Api>, entry: CuaCatalogEntryDraft): void {
	const binding = entry.providerBinding;
	if (entry.origin === "provider-native" && !/^https:\/\//.test(entry.source ?? "")) {
		throw new Error(`${entry.identity} must cite first-party provider documentation`);
	}
	if (binding) {
		const provider = binding.kind.split("-")[0];
		const required = provider === "google" ? "google" : provider;
		if (model.provider !== required) {
			throw new Error(`${entry.identity} requires a ${required} model; selected ${model.provider}:${model.id}`);
		}
	}
	const capabilities = cuaModelCapabilities(model);
	if (entry.complexSchema && !capabilities.acceptsComplexSchemas) {
		throw new Error(`provider ${model.provider} does not accept the schema used by "${entry.name}" (${entry.identity})`);
	}
	if (entry.largeSchema && !capabilities.acceptsLargeSchemas) {
		throw new Error(`provider ${model.provider} does not accept the schema size of "${entry.name}" (${entry.identity})`);
	}
	if (binding?.kind === "anthropic-native") validateAnthropicNativeModel(model, entry.identity);
}

function validateAnthropicNativeModel(model: Model<Api>, identity: string): void {
	const computer = identity.includes(".computer.");
	const supported = computer
		? supportsAnthropicNativeComputer(model.id)
		: supportsAnthropicNativeBrowser(model.id);
	if (!supported) {
		throw new Error(`${identity} does not support model "${model.id}"`);
	}
}

/** Validate the selected native tools agree on a provider and a transport, and return the transport they require, if any. */
function validateToolsetCompatibility(model: Model<Api>, entries: readonly CuaCatalogEntryDraft[]): Api | undefined {
	const nativeProviderKinds = new Set(
		entries.flatMap((entry) => entry.providerBinding ? [entry.providerBinding.kind.split("-")[0]] : []),
	);
	if (nativeProviderKinds.size > 1) {
		throw new Error(`selected tools contribute incompatible native provider transports: ${[...nativeProviderKinds].join(", ")}`);
	}

	// Anthropic rejects its native browser and native computer tools in one
	// request, because the browser tool addresses a viewport coordinate frame and
	// the computer tool a display frame. Verified against the live API, which
	// answers 400 "browser_20260701 cannot be declared alongside a computer_*
	// tool". Catch it at compile time rather than on the wire.
	const anthropicNativeTypes = entries.flatMap((entry) =>
		entry.providerBinding?.kind === "anthropic-native" && isRecord(entry.providerBinding.declaration)
			? [String(entry.providerBinding.declaration.type ?? "")]
			: [],
	);
	const anthropicBrowser = anthropicNativeTypes.find((type) => type.startsWith("browser_"));
	const anthropicComputer = anthropicNativeTypes.find((type) => type.startsWith("computer_"));
	if (anthropicBrowser && anthropicComputer) {
		throw new Error(
			`Anthropic's native browser tool (${anthropicBrowser}) cannot be selected alongside its native computer tool (${anthropicComputer}): ` +
				"the browser tool's viewport coordinate frame is incompatible with the computer tool's display frame",
		);
	}

	const requiresApis = new Set(entries.flatMap((entry) => bindingRequiresApi(entry.providerBinding)));
	if (requiresApis.size > 1) {
		throw new Error(`selected tools require incompatible provider transports: ${[...requiresApis].join(", ")}`);
	}
	return requiresApis.values().next().value;
}

/** The transport a provider binding requires, if it declares one. Anthropic never forks transports and declares none. */
function bindingRequiresApi(binding: CuaProviderBinding | undefined): readonly [Api] | readonly [] {
	return binding && binding.kind !== "anthropic-native" && binding.requiresApi ? [binding.requiresApi] : [];
}

/**
 * Model-shaped default transport for each `requiresApi` this module can
 * derive, keyed by the derived api itself. A `Model<Api>` a caller passes to
 * {@link compileCuaToolCatalog} may already carry one of these — e.g. a prior
 * catalog's `catalog.model`, fed back in with a different tool selection — so
 * derivation resets it here before re-validating, keeping compilation pure
 * with respect to the currently requested tools rather than pinning whatever
 * transport an earlier selection required.
 */
const CATALOG_DERIVED_API_DEFAULTS: Readonly<Record<string, Api>> = {
	[OPENAI_CUA_COMPUTER_API]: "openai-responses",
	[GOOGLE_CUA_INTERACTIONS_API]: "google-generative-ai",
};

function resetCatalogDerivedApi(model: Model<Api>): Model<Api> {
	const defaultApi = CATALOG_DERIVED_API_DEFAULTS[model.api];
	return defaultApi ? { ...model, api: defaultApi } : model;
}

function compileHeaderRequirements(entries: readonly CuaCatalogEntryDraft[]): CuaHeaderRequirement[] {
	return entries.flatMap((entry) => {
		const binding = entry.providerBinding;
		return binding?.kind === "anthropic-native"
			? [{ identity: entry.identity, name: "anthropic-beta", value: binding.beta, merge: "comma-set" as const }]
			: [];
	});
}

function createHeaderPlan(requirements: readonly CuaHeaderRequirement[]): CuaHeaderPlan {
	const frozenRequirements = Object.freeze(requirements.map((requirement) => Object.freeze({ ...requirement })));
	return Object.freeze({
		requirements: frozenRequirements,
		merge(callerHeaders?: Record<string, string | null | undefined>): Record<string, string> | undefined {
			const output = Object.fromEntries(
				Object.entries(callerHeaders ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			);
			if (frozenRequirements.length === 0) return Object.keys(output).length ? output : undefined;
			const actualNames = new Map(Object.keys(output).map((name) => [name.toLowerCase(), name]));
			for (const requirement of frozenRequirements) {
				const key = requirement.name.toLowerCase();
				const existingName = actualNames.get(key) ?? requirement.name;
				const existing = output[existingName];
				if (requirement.merge === "exact") {
					if (existing !== undefined && existing !== requirement.value) {
						throw new Error(`header "${requirement.name}" required by "${requirement.identity}" conflicts with caller value "${existing}"`);
					}
					output[existingName] = requirement.value;
				} else {
					const tokens = [...commaTokens(existing), ...commaTokens(requirement.value)];
					output[existingName] = [...new Set(tokens)].join(",");
				}
				actualNames.set(key, existingName);
			}
			return output;
		},
	});
}

function commaTokens(value: string | undefined): string[] {
	return value?.split(",").map((token) => token.trim()).filter(Boolean) ?? [];
}

function compilePayloadTransforms(model: Model<Api>, entries: readonly CuaCatalogEntryDraft[]): CuaPayloadTransform[] {
	const transforms: CuaPayloadTransform[] = [];
	if (model.provider === "anthropic") {
		transforms.push({
			identity: "provider.anthropic.model-preparation",
			phase: "model-preparation",
			writes: ["thinking", "output_config.effort"],
			apply(payload, selectedModel) {
				return anthropicAdaptiveThinkingOnPayload(payload, selectedModel) ?? payload;
			},
		});
	}

	for (const entry of entries) {
		const binding = entry.providerBinding;
		if (!binding) continue;
		if (binding.kind === "anthropic-native" || binding.kind === "openai-native") {
			const { declaration } = binding;
			transforms.push({
				identity: entry.identity,
				consumesToolIdentities: [entry.identity],
				writes: [`tools.${entry.identity}`],
				phase: "tool-declarations",
				apply(payload, _selectedModel, names) {
					return replaceSerializedTool(payload, names.get(entry.identity)!, declaration);
				},
			});
		}
	}

	const google = entries.filter((entry) => entry.providerBinding?.kind === "google-native");
	if (google.length > 0) transforms.push(createGoogleTransform(google));
	if (model.provider === "google" && entries.some((entry) => entry.transport === "function")) {
		transforms.push(createGeminiSchemaTransform());
	}

	if (cuaModelCapabilities(model).serializesStateMutations && entries.some((entry) => entry.stateMutating)) {
		transforms.push({
			identity: `provider.${model.provider}.serial-tool-calls`,
			writes: ["parallel_tool_calls"],
			phase: "provider-fields",
			apply(payload) {
				return isRecord(payload) ? { ...payload, parallel_tool_calls: false } : payload;
			},
		});
	}
	return transforms;
}

/**
 * Gemini's function-declaration dialect is a subset of JSON Schema. It rejects
 * the request outright on an unknown keyword rather than ignoring it, so a
 * declaration carrying `const` or `additionalProperties` fails with
 * `Invalid JSON payload received. Unknown name "const"`.
 *
 * Both have exact equivalents Gemini does accept: `const: x` is a single-value
 * `enum`, and `additionalProperties: false` only tightens validation the model
 * never performs. Rewriting them is what lets Google take the same declarations
 * every other provider gets, verified against the live API.
 */
function createGeminiSchemaTransform(): CuaPayloadTransform {
	return {
		identity: "provider.google.function-declaration-schema",
		writes: ["tools.functionDeclarations"],
		phase: "tool-declarations",
		apply(payload) {
			if (!isRecord(payload) || !Array.isArray(payload.tools)) return payload;
			return {
				...payload,
				tools: payload.tools.map((tool) =>
					isRecord(tool) && Array.isArray(tool.functionDeclarations)
						? { ...tool, functionDeclarations: tool.functionDeclarations.map(narrowToGeminiSchema) }
						: tool,
				),
			};
		},
	};
}

const GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS = new Set(["additionalProperties", "$schema", "$defs", "definitions"]);

function narrowToGeminiSchema(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(narrowToGeminiSchema);
	if (!isRecord(node)) return node;
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "const") {
			result.enum = [value];
			continue;
		}
		if (GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) continue;
		result[key] = narrowToGeminiSchema(value);
	}
	return result;
}

function createGoogleTransform(entries: readonly CuaCatalogEntryDraft[]): CuaPayloadTransform {
	const firstBinding = entries[0]!.providerBinding;
	if (firstBinding?.kind !== "google-native") throw new Error("invalid Google catalog entry");
	const selected = new Set(entries.map((entry) => (entry.providerBinding as Extract<CuaProviderBinding, { kind: "google-native" }>).nativeName));
	const excludedPredefinedFunctions = firstBinding.allNativeNames.filter((name) => !selected.has(name));
	return {
		identity: "provider.google.native.browser",
		consumesToolIdentities: entries.map((entry) => entry.identity),
		writes: ["tools.computer_use"],
		phase: "tool-declarations",
		apply(payload, _model, names) {
			const next = removeSerializedTools(payload, entries.map((entry) => names.get(entry.identity)!));
			if (!isRecord(next)) return next;
			const tools = Array.isArray(next.tools) ? [...next.tools] : [];
			tools.unshift({
				type: "computer_use",
				environment: "browser",
				...(excludedPredefinedFunctions.length ? { excluded_predefined_functions: excludedPredefinedFunctions } : {}),
			});
			return { ...next, tools };
		},
	};
}

function validateTransformClaims(transforms: readonly CuaPayloadTransform[]): void {
	const claims = new Map<string, CuaPayloadTransform>();
	for (const transform of transforms) {
		for (const write of transform.writes ?? []) {
			const existing = claims.get(write);
			if (existing && existing.identity !== transform.identity) {
				throw new Error(`tools "${existing.identity}" and "${transform.identity}" require conflicting payload transforms for "${write}"`);
			}
			claims.set(write, transform);
		}
	}
}

function createPayloadPlan(
	model: Model<Api>,
	transforms: readonly CuaPayloadTransform[],
	names: ReadonlyMap<string, string>,
): CuaPayloadPlan {
	const phases: Record<CuaPayloadTransform["phase"], number> = {
		"model-preparation": 0,
		"tool-declarations": 1,
		"provider-fields": 2,
	};
	const ordered = Object.freeze([...transforms].sort((a, b) => phases[a.phase] - phases[b.phase]));
	return Object.freeze({
		transforms: ordered,
		async apply(payload: unknown): Promise<unknown> {
			let current = payload;
			for (const transform of ordered) current = (await transform.apply(current, model, names)) ?? current;
			return current;
		},
	});
}

function compileIncomingPlan(entries: readonly CuaCatalogEntryDraft[]): CuaIncomingToolPlan {
	let anthropicBrowserFallback: CuaAnthropicBrowserFallback | undefined;
	let openaiComputerName: string | undefined;
	let googleAllNativeNames: readonly string[] = [];
	const googleNames: Record<string, string> = {};
	const nativeToolNames: string[] = [];
	for (const entry of entries) {
		const binding = entry.providerBinding;
		if (!binding) continue;
		nativeToolNames.push(entry.name);
		if (binding.kind === "anthropic-native" && binding.accessFallback) anthropicBrowserFallback = binding.accessFallback;
		else if (binding.kind === "openai-native") openaiComputerName = entry.name;
		else if (binding.kind === "google-native") {
			googleNames[binding.nativeName] = entry.name;
			googleAllNativeNames = binding.allNativeNames;
		}
	}
	const selectedGoogleNames = new Set(Object.keys(googleNames));
	const googleExcludedNames = googleAllNativeNames.filter((name) => !selectedGoogleNames.has(name));
	return Object.freeze({
		...(anthropicBrowserFallback ? { anthropicBrowserFallback: Object.freeze(anthropicBrowserFallback) } : {}),
		...(openaiComputerName ? { openaiComputerName } : {}),
		googleNames: Object.freeze(googleNames),
		googleExcludedNames: Object.freeze(googleExcludedNames),
		nativeToolNames: Object.freeze(nativeToolNames),
	});
}

function replaceSerializedTool(payload: unknown, name: string, declaration: Record<string, unknown>): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.tools)) return payload;
	let replaced = false;
	const tools = payload.tools.map((tool) => {
		if (serializedToolName(tool) !== name) return tool;
		replaced = true;
		return declaration;
	});
	if (!replaced) throw new Error(`native tool placeholder "${name}" was not present in the provider payload`);
	return { ...payload, tools };
}

function removeSerializedTools(payload: unknown, names: readonly string[]): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.tools)) return payload;
	const selected = new Set(names);
	const tools: unknown[] = [];
	for (const tool of payload.tools) {
		if (isRecord(tool) && Array.isArray(tool.functionDeclarations)) {
			const functionDeclarations = tool.functionDeclarations.filter((declaration) => !selected.has(serializedToolName(declaration) ?? ""));
			if (functionDeclarations.length > 0) tools.push({ ...tool, functionDeclarations });
			continue;
		}
		if (!selected.has(serializedToolName(tool) ?? "")) tools.push(tool);
	}
	return { ...payload, tools };
}

function serializedToolName(tool: unknown): string | undefined {
	if (!isRecord(tool)) return undefined;
	if (typeof tool.name === "string") return tool.name;
	return isRecord(tool.function) && typeof tool.function.name === "string" ? tool.function.name : undefined;
}

function stableStringify(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
		.join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

