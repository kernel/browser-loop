import type { TSchema } from "typebox";
import type { ComputerUseAction } from "./actions/index";
import {
	loopModelFactsCapabilities,
	loopModelFactsNativeSurfaces,
	type ComputerUseNativeSurface,
	type LoopCatalogModel,
	type LoopModelFacts,
} from "./model-info";

export const LOOP_TOOL_SPEC_KIND = "@onkernel/browser-loop-tool-spec/v1" as const;

/** Loop-owned api id for OpenAI's native computer tool, derived onto the model by {@link compileLoopToolCatalog} when that tool is selected. */
export const OPENAI_COMPUTER_USE_API = "openai-computer-use";

/** Loop-owned api id for Google's native computer-use toolset, derived onto the model by {@link compileLoopToolCatalog} when that toolset is selected. */
export const GOOGLE_INTERACTIONS_API = "google-interactions";

/**
 * Framework-neutral tool declaration: what a model is told about a tool.
 * Structurally assignable to a pi-ai `Tool`.
 */
export interface LoopToolDeclaration {
	readonly name: string;
	readonly description: string;
	readonly parameters: TSchema;
}

export type LoopToolOrigin = "loop" | "provider-native";
export type LoopToolTransport = "function" | "native";
export type LoopToolDynamicLoading = "eligible" | "eager-only";

export type LoopCoordinateContract =
	| { readonly type: "pixel" }
	| { readonly type: "normalized"; readonly range: readonly [number, number] };

export type LoopToolExecution =
	| {
			readonly kind: "actions";
			readonly toActions: (input: unknown) => ComputerUseAction[];
			readonly coordinates: LoopCoordinateContract;
			readonly batch: boolean;
			/** Block later calls in the same assistant turn after this tool fails. */
			readonly stopTurnOnFailureMessage?: string;
	  }
	| { readonly kind: "playwright" };

export type LoopProviderBinding =
	| {
			readonly kind: "anthropic-native";
			readonly declaration: Record<string, unknown>;
			readonly beta: string;
			readonly accessFallback?: LoopAnthropicBrowserFallback;
	  }
	| {
			readonly kind: "openai-native";
			readonly declaration: Record<string, unknown>;
			/** Transport this binding requires the compiled catalog's model to carry. */
			readonly requiresApi?: string;
	  }
	| {
			readonly kind: "google-native";
			readonly nativeName: string;
			readonly allNativeNames: readonly string[];
			/** Transport this binding requires the compiled catalog's model to carry. */
			readonly requiresApi?: string;
	  };

/** Declarative Loop tool. Identity is immutable and independent from its model-facing alias. */
export interface LoopToolSpec {
	readonly kind: typeof LOOP_TOOL_SPEC_KIND;
	readonly identity: string;
	readonly preferredName: string;
	readonly name: string;
	readonly origin: LoopToolOrigin;
	/** First-party documentation for a provider-native tool surface. */
	readonly source?: string;
	readonly transport: LoopToolTransport;
	readonly dynamicLoading: LoopToolDynamicLoading;
	readonly declaration: LoopToolDeclaration;
	/** @internal Local execution policy consumed by the tool manager. */
	readonly execution: LoopToolExecution;
	/** @internal Provider transport contribution consumed by the catalog compiler. */
	readonly providerBinding?: LoopProviderBinding;
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
 * Sanitized declarative projection of a caller-owned tool. The compiler never
 * sees executors: callers pass plain declarations and the executing runtime
 * keeps the matching implementation.
 */
export type LoopCallerToolDeclaration = LoopToolDeclaration;

/** Declarative catalog input: a Loop spec or a sanitized caller tool declaration. */
export type LoopCatalogToolInput = LoopToolSpec | LoopCallerToolDeclaration;

/**
 * Canonical identity scheme for caller-owned tools. Exported so every consumer
 * shares exactly one definition and cannot drift.
 */
export function callerToolIdentity(name: string): string {
	return `caller.${name}`;
}

export interface LoopToolInfo {
	identity: string;
	name: string;
	preferredName: string;
	origin: "loop" | "provider-native" | "caller";
	source?: string;
	transport: LoopToolTransport;
	dynamicLoading: LoopToolDynamicLoading;
	declaration: LoopToolDeclaration | Record<string, unknown>;
	coordinates?: LoopCoordinateContract;
}

export interface LoopHeaderRequirement {
	identity: string;
	name: string;
	value: string;
	merge: "exact" | "comma-set";
}

export interface LoopHeaderPlan {
	readonly requirements: readonly LoopHeaderRequirement[];
	merge(callerHeaders?: Record<string, string | null | undefined>): Record<string, string> | undefined;
}

export interface LoopPayloadTransform {
	identity: string;
	consumesToolIdentities?: readonly string[];
	writes?: readonly string[];
	phase: "model-preparation" | "tool-declarations" | "provider-fields";
	apply(payload: unknown, model: LoopCatalogModel, names: ReadonlyMap<string, string>): unknown | Promise<unknown>;
}

export interface LoopPayloadPlan {
	readonly transforms: readonly LoopPayloadTransform[];
	apply(payload: unknown, model: LoopCatalogModel): Promise<unknown>;
}

/** Function-tool fallback for an Anthropic native browser tool unavailable to the active credential. */
export interface LoopAnthropicBrowserFallback {
	readonly beta: string;
	readonly nativeType: string;
	readonly declaration: Record<string, unknown>;
}

/** Identity-addressed native call dispatch passed to Loop custom provider streams. */
export interface LoopIncomingToolPlan {
	readonly anthropicBrowserFallback?: LoopAnthropicBrowserFallback;
	readonly openaiComputerName?: string;
	readonly googleNames: Readonly<Record<string, string>>;
	/** Google predefined functions disabled by the exact selected native subset. */
	readonly googleExcludedNames: readonly string[];
	readonly nativeToolNames: readonly string[];
}

export interface LoopToolCatalogEntry extends LoopToolInfo {
	readonly schemaFingerprint: string;
	readonly fingerprint: string;
}

/**
 * The model a compiled catalog carries: the input model with `api` widened to
 * `string`, because compilation may replace it with a selected tool's derived
 * transport. Keeping the widening in the type is what lets the input stay
 * narrowly typed without the output lying about it.
 */
export type LoopCompiledModel<M extends LoopCatalogModel> = Omit<M, "api"> & { readonly api: string };

export interface LoopToolCatalog<M extends LoopCatalogModel = LoopCatalogModel> {
	readonly model: LoopCompiledModel<M>;
	readonly entries: readonly LoopToolCatalogEntry[];
	/**
	 * Provider-facing tool declarations in entry order, suitable for
	 * `Context.tools`. Native placeholders are swapped by `payload` transforms.
	 */
	readonly toolDeclarations: readonly LoopToolDeclaration[];
	readonly headers: LoopHeaderPlan;
	readonly payload: LoopPayloadPlan;
	readonly incoming: LoopIncomingToolPlan;
	readonly fingerprint: string;
}

export interface CompileLoopToolCatalogOptions<M extends LoopCatalogModel = LoopCatalogModel> {
	model: M;
	requestedTools: readonly LoopCatalogToolInput[];
	/**
	 * Binding-supplied availability facts for the model: request-shape
	 * capabilities and native tool surfaces. Absent facts mean permissive
	 * capabilities and no native surfaces.
	 */
	facts?: LoopModelFacts;
	/**
	 * Binding-supplied `model-preparation` payload transforms, e.g. pi's
	 * Anthropic thinking-budget conversion. Compiled into the payload plan ahead
	 * of tool-declaration and provider-field transforms and validated against
	 * the same write claims.
	 */
	preparation?: readonly LoopPayloadTransform[];
}

/**
 * Internal compilation state. The published catalog entry never retains the
 * requested spec/declaration objects or provider bindings used to compile it.
 */
interface LoopCatalogEntryDraft extends LoopToolCatalogEntry {
	readonly placeholder: LoopToolDeclaration;
	readonly providerBinding?: LoopProviderBinding;
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
export function compileLoopToolCatalog<M extends LoopCatalogModel>(options: CompileLoopToolCatalogOptions<M>): LoopToolCatalog<M> {
	const baseModel = resetCatalogDerivedApi(options.model);
	const normalizedEntries = [...options.requestedTools].map(normalizeTool);
	const requiresApi = validateCatalog(baseModel, options.facts, normalizedEntries);
	const model = requiresApi ? withApi(baseModel, requiresApi) : baseModel;
	const drafts = resolveProviderFacingDeclarations(normalizedEntries);

	const names = new Map(drafts.map((entry) => [entry.identity, entry.name]));
	const requirements = compileHeaderRequirements(drafts);
	const transforms = compilePayloadTransforms(model, options.facts, drafts, validatePreparation(options.preparation));
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
function publishEntry(draft: LoopCatalogEntryDraft): LoopToolCatalogEntry {
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

export function isLoopToolSpec(value: unknown): value is LoopToolSpec {
	return Boolean(value && typeof value === "object" && (value as { kind?: unknown }).kind === LOOP_TOOL_SPEC_KIND);
}

function normalizeTool(tool: LoopCatalogToolInput): LoopCatalogEntryDraft {
	if (isLoopToolSpec(tool)) {
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

function resolveProviderFacingDeclarations(entries: readonly LoopCatalogEntryDraft[]): LoopCatalogEntryDraft[] {
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
function validateCatalog(model: LoopCatalogModel, facts: LoopModelFacts | undefined, entries: readonly LoopCatalogEntryDraft[]): string | undefined {
	const identities = new Map<string, LoopCatalogEntryDraft>();
	const exactNames = new Map<string, LoopCatalogEntryDraft>();
	const normalizedNames = new Map<string, LoopCatalogEntryDraft>();
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
		validateToolCompatibility(model, facts, entry);
	}

	return validateToolsetCompatibility(model, entries);
}

function nameCollision(
	name: string,
	first: LoopCatalogEntryDraft,
	second: LoopCatalogEntryDraft,
	provider?: string,
): Error {
	const suffix = provider ? ` after ${provider} name normalization` : "";
	return new Error(`tool name "${name}" is requested by both "${first.identity}" and "${second.identity}"${suffix}`);
}

function validateToolCompatibility(model: LoopCatalogModel, facts: LoopModelFacts | undefined, entry: LoopCatalogEntryDraft): void {
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
	const capabilities = loopModelFactsCapabilities(facts);
	if (entry.complexSchema && !capabilities.acceptsComplexSchemas) {
		throw new Error(`provider ${model.provider} does not accept the schema used by "${entry.name}" (${entry.identity})`);
	}
	if (entry.largeSchema && !capabilities.acceptsLargeSchemas) {
		throw new Error(`provider ${model.provider} does not accept the schema size of "${entry.name}" (${entry.identity})`);
	}
	if (binding?.kind === "anthropic-native") validateAnthropicNativeModel(model, facts, entry.identity);
	else if (binding) validateNativeSurfaceModel(model, facts, entry.identity, binding.kind === "google-native" ? "browser" : "computer");
}

function validateAnthropicNativeModel(model: LoopCatalogModel, facts: LoopModelFacts | undefined, identity: string): void {
	const surface: ComputerUseNativeSurface = identity.includes(".computer.") ? "computer" : "browser";
	if (!loopModelFactsNativeSurfaces(facts).includes(surface)) {
		throw new Error(`${identity} does not support model "${model.id}"`);
	}
}

// A provider enables its native surface per model, not per provider: OpenAI's
// computer tool and Google's `computer_use` both answer 400 on a model the
// surface is not enabled for. The binding-supplied surface facts are what the
// menu reads, so gate compilation on them too rather than letting the request
// fail on the wire.
function validateNativeSurfaceModel(model: LoopCatalogModel, facts: LoopModelFacts | undefined, identity: string, surface: ComputerUseNativeSurface): void {
	if (loopModelFactsNativeSurfaces(facts).includes(surface)) return;
	throw new Error(`${identity} does not support model "${model.id}": ${model.provider} does not offer a native ${surface} surface for it`);
}

/** Validate the selected native tools agree on a provider and a transport, and return the transport they require, if any. */
function validateToolsetCompatibility(model: LoopCatalogModel, entries: readonly LoopCatalogEntryDraft[]): string | undefined {
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
function bindingRequiresApi(binding: LoopProviderBinding | undefined): readonly [string] | readonly [] {
	return binding && binding.kind !== "anthropic-native" && binding.requiresApi ? [binding.requiresApi] : [];
}

/**
 * Model-shaped default transport for each `requiresApi` this module can
 * derive, keyed by the derived api itself. A `Model<Api>` a caller passes to
 * {@link compileLoopToolCatalog} may already carry one of these — e.g. a prior
 * catalog's `catalog.model`, fed back in with a different tool selection — so
 * derivation resets it here before re-validating, keeping compilation pure
 * with respect to the currently requested tools rather than pinning whatever
 * transport an earlier selection required.
 */
const CATALOG_DERIVED_API_DEFAULTS: Readonly<Record<string, string>> = {
	[OPENAI_COMPUTER_USE_API]: "openai-responses",
	[GOOGLE_INTERACTIONS_API]: "google-generative-ai",
};

function resetCatalogDerivedApi<M extends LoopCatalogModel>(model: M): LoopCompiledModel<M> {
	const defaultApi = CATALOG_DERIVED_API_DEFAULTS[model.api];
	return defaultApi ? withApi(model, defaultApi) : model;
}

function withApi<M extends LoopCatalogModel>(model: M | LoopCompiledModel<M>, api: string): LoopCompiledModel<M> {
	return { ...model, api };
}

function compileHeaderRequirements(entries: readonly LoopCatalogEntryDraft[]): LoopHeaderRequirement[] {
	return entries.flatMap((entry) => {
		const binding = entry.providerBinding;
		return binding?.kind === "anthropic-native"
			? [{ identity: entry.identity, name: "anthropic-beta", value: binding.beta, merge: "comma-set" as const }]
			: [];
	});
}

function createHeaderPlan(requirements: readonly LoopHeaderRequirement[]): LoopHeaderPlan {
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

function validatePreparation(preparation: readonly LoopPayloadTransform[] | undefined): readonly LoopPayloadTransform[] {
	for (const transform of preparation ?? []) {
		if (transform.phase !== "model-preparation") {
			throw new Error(`preparation transform "${transform.identity}" must declare the "model-preparation" phase, not "${transform.phase}"`);
		}
	}
	return preparation ?? [];
}

function compilePayloadTransforms(
	model: LoopCatalogModel,
	facts: LoopModelFacts | undefined,
	entries: readonly LoopCatalogEntryDraft[],
	preparation: readonly LoopPayloadTransform[],
): LoopPayloadTransform[] {
	const transforms: LoopPayloadTransform[] = [...preparation];

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

	if (loopModelFactsCapabilities(facts).serializesStateMutations && entries.some((entry) => entry.stateMutating)) {
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
function createGeminiSchemaTransform(): LoopPayloadTransform {
	return {
		identity: "provider.google.function-declaration-schema",
		writes: ["tools.functionDeclarations"],
		phase: "tool-declarations",
		apply(payload) {
			if (!isRecord(payload)) return payload;
			// Google serializes function tools three ways: the Generative Language API
			// nests them under `config.tools[].functionDeclarations`, its raw request
			// shape puts the same list at the top level, and the Interactions transport
			// emits flat `{ type: "function", parameters }` entries. Narrow all of them,
			// because selecting a native surface alongside a function tool derives the
			// last shape and a shape-specific transform would silently skip the others.
			if (Array.isArray(payload.tools)) return { ...payload, tools: narrowGeminiTools(payload.tools) };
			if (isRecord(payload.config) && Array.isArray(payload.config.tools)) {
				return { ...payload, config: { ...payload.config, tools: narrowGeminiTools(payload.config.tools) } };
			}
			return payload;
		},
	};
}

function narrowGeminiTools(tools: readonly unknown[]): unknown[] {
	return tools.map((tool) => {
		if (!isRecord(tool)) return tool;
		if (Array.isArray(tool.functionDeclarations)) {
			return { ...tool, functionDeclarations: tool.functionDeclarations.map(narrowToGeminiSchema) };
		}
		return "parameters" in tool ? { ...tool, parameters: narrowToGeminiSchema(tool.parameters) } : tool;
	});
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

function createGoogleTransform(entries: readonly LoopCatalogEntryDraft[]): LoopPayloadTransform {
	const firstBinding = entries[0]!.providerBinding;
	if (firstBinding?.kind !== "google-native") throw new Error("invalid Google catalog entry");
	const selected = new Set(entries.map((entry) => (entry.providerBinding as Extract<LoopProviderBinding, { kind: "google-native" }>).nativeName));
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

function validateTransformClaims(transforms: readonly LoopPayloadTransform[]): void {
	const claims = new Map<string, LoopPayloadTransform>();
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
	model: LoopCatalogModel,
	transforms: readonly LoopPayloadTransform[],
	names: ReadonlyMap<string, string>,
): LoopPayloadPlan {
	const phases: Record<LoopPayloadTransform["phase"], number> = {
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

function compileIncomingPlan(entries: readonly LoopCatalogEntryDraft[]): LoopIncomingToolPlan {
	let anthropicBrowserFallback: LoopAnthropicBrowserFallback | undefined;
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

