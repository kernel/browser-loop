import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, Tool } from "@earendil-works/pi-ai";
import type { CuaAction } from "./actions/index";
import type { CuaModelRef } from "./models";
import { getCuaModel, providerForModel, routeCuaApi } from "./models";
import { anthropicAdaptiveThinkingOnPayload } from "./providers/anthropic/adaptive-thinking";
import {
	supportsAnthropicNativeBrowser,
	supportsAnthropicNativeComputer,
} from "./providers/anthropic/capabilities";

export const CUA_TOOL_SPEC_KIND = "@onkernel/cua-tool-spec/v1" as const;

export type CuaToolOrigin = "cua" | "provider-native" | "provider-recommended";
export type CuaToolTransport = "function" | "native";
export type CuaToolDynamicLoading = "eligible" | "eager-only";
export type CuaToolResultPolicy =
	| "computer"
	| "browser"
	| "browser-act"
	| "browser-wait"
	| "playwright"
	| "request-grounded";

export type CuaCoordinateContract =
	| { readonly type: "pixel" }
	| { readonly type: "normalized"; readonly range: readonly [number, number] };

export type CuaToolExecution =
	| {
			readonly kind: "actions";
			readonly toActions: (input: unknown) => CuaAction[];
			readonly coordinates: CuaCoordinateContract;
			readonly resultPolicy: CuaToolResultPolicy;
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
	| { readonly kind: "openai-native"; readonly declaration: Record<string, unknown> }
	| {
			readonly kind: "tzafon-native";
			readonly declaration: Record<string, unknown>;
	  }
	| {
			readonly kind: "yutori-native";
			readonly generation: "n1" | "n15";
			readonly nativeName: string;
			readonly toolSet?: string;
			readonly allNativeNames: readonly string[];
	  }
	| {
			readonly kind: "google-native";
			readonly generation: "legacy" | "current";
			readonly nativeName: string;
			readonly allNativeNames: readonly string[];
	  };

/** Declarative CUA tool. Identity is immutable and independent from its model-facing alias. */
export interface CuaToolSpec {
	readonly kind: typeof CUA_TOOL_SPEC_KIND;
	readonly identity: string;
	readonly preferredName: string;
	readonly name: string;
	readonly origin: CuaToolOrigin;
	readonly transport: CuaToolTransport;
	readonly dynamicLoading: CuaToolDynamicLoading;
	readonly declaration: Tool;
	/** @internal Local execution policy consumed by @onkernel/cua-agent. */
	readonly execution: CuaToolExecution;
	/** @internal Provider transport contribution consumed by the catalog compiler. */
	readonly providerBinding?: CuaProviderBinding;
	/** @internal Stable implementation revision used by dynamic replacement detection. */
	readonly executorFingerprint: string;
	/** @internal True when the tool mutates shared browser state. */
	readonly stateMutating: boolean;
	/** @internal Complex schemas are deliberately allowlisted by provider. */
	readonly complexSchema?: boolean;
}

export type CuaAgentTool = CuaToolSpec | AgentTool;

export interface CuaToolInfo {
	identity: string;
	name: string;
	preferredName: string;
	origin: "cua" | "provider-native" | "provider-recommended" | "caller";
	transport: CuaToolTransport;
	dynamicLoading: CuaToolDynamicLoading;
	declaration: Tool | Record<string, unknown>;
	coordinates?: CuaCoordinateContract;
	/** The provider composer supplies a fresh image before every request. */
	requestGrounding?: "os-screenshot";
}

export interface CuaToolCatalogResources {
	readonly viewport: { readonly width: number; readonly height: number };
	materialize(spec: CuaToolSpec): AgentTool;
	osScreenshot(transform?: CuaScreenshotTransform): Promise<{ data: Buffer; mimeType: string }>;
}

export interface CuaScreenshotTransform {
	readonly width: number;
	readonly height: number;
	readonly format: "png" | "jpeg" | "webp";
	readonly quality?: number;
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
	phase: "model-preparation" | "tool-declarations" | "provider-fields" | "grounding";
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
	readonly tzafonComputerName?: string;
	readonly yutoriNames: Readonly<Record<string, string>>;
	readonly googleNames: Readonly<Record<string, string>>;
	/** Google predefined functions disabled by the exact selected native subset. */
	readonly googleExcludedNames: readonly string[];
	readonly nativeToolNames: readonly string[];
}

export interface CuaToolCatalogEntry extends CuaToolInfo {
	readonly requested: CuaAgentTool;
	readonly agentTool: AgentTool;
	readonly schemaFingerprint: string;
	readonly executorFingerprint: string;
	readonly fingerprint: string;
	readonly spec?: CuaToolSpec;
}

export interface CuaToolCatalog {
	readonly model: Model<Api>;
	readonly requested: readonly CuaAgentTool[];
	readonly entries: readonly CuaToolCatalogEntry[];
	readonly agentTools: readonly AgentTool[];
	readonly headers: CuaHeaderPlan;
	readonly payload: CuaPayloadPlan;
	readonly incoming: CuaIncomingToolPlan;
	readonly fingerprint: string;
}

export interface CompileCuaToolCatalogOptions {
	model: CuaModelRef | Model<Api>;
	requestedTools: readonly CuaAgentTool[];
	resources: CuaToolCatalogResources;
}

const SAFE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const callerExecutors = new WeakMap<object, number>();
let nextCallerExecutor = 1;

/** Compile exactly one identity-keyed catalog for a model and caller-owned requested list. */
export function compileCuaToolCatalog(options: CompileCuaToolCatalogOptions): CuaToolCatalog {
	const model = typeof options.model === "string" ? getCuaModel(options.model) : routeCuaApi(options.model);
	const requested = [...options.requestedTools];
	const normalizedEntries = requested.map((tool) => normalizeTool(tool, options.resources));
	validateCatalog(model, normalizedEntries);
	const entries = resolveProviderFacingDeclarations(normalizedEntries);

	const names = new Map(entries.map((entry) => [entry.identity, entry.name]));
	const requirements = compileHeaderRequirements(entries);
	const transforms = compilePayloadTransforms(model, entries, options.resources);
	validateTransformClaims(transforms);
	const incoming = compileIncomingPlan(entries);
	const fingerprint = stableStringify({
		model: [model.provider, model.id, model.api],
		entries: entries.map((entry) => entry.fingerprint),
		headers: requirements,
		transforms: transforms.map((transform) => ({ identity: transform.identity, phase: transform.phase, writes: transform.writes })),
	});

	return Object.freeze({
		model,
		requested: Object.freeze(requested),
		entries: Object.freeze(entries),
		agentTools: Object.freeze(entries.map((entry) => entry.agentTool)),
		headers: createHeaderPlan(requirements),
		payload: createPayloadPlan(model, transforms, names),
		incoming,
		fingerprint,
	});
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

function normalizeTool(tool: CuaAgentTool, resources: CuaToolCatalogResources): CuaToolCatalogEntry {
	if (isCuaToolSpec(tool)) {
		const schemaFingerprint = stableStringify(tool.declaration.parameters);
		const fingerprint = stableStringify({
			identity: tool.identity,
			name: tool.name,
			schema: schemaFingerprint,
			executor: tool.executorFingerprint,
			coordinates: tool.execution.kind === "actions" ? tool.execution.coordinates : undefined,
		});
		const inspectedDeclaration = tool.providerBinding?.kind === "tzafon-native"
			? {
					...tool.providerBinding.declaration,
					display_width: tool.providerBinding.declaration.display_width ?? resources.viewport.width,
					display_height: tool.providerBinding.declaration.display_height ?? resources.viewport.height,
				}
			: tool.providerBinding && "declaration" in tool.providerBinding
				? tool.providerBinding.declaration
				: tool.declaration;
		return Object.freeze({
			identity: tool.identity,
			name: tool.name,
			preferredName: tool.preferredName,
			origin: tool.origin,
			transport: tool.transport,
			dynamicLoading: tool.dynamicLoading,
			declaration: inspectedDeclaration,
			...(tool.execution.kind === "actions" ? { coordinates: tool.execution.coordinates } : {}),
			...(tool.execution.kind === "actions" && tool.execution.resultPolicy === "request-grounded" ? { requestGrounding: "os-screenshot" as const } : {}),
			requested: tool,
			agentTool: resources.materialize(tool),
			schemaFingerprint,
			executorFingerprint: tool.executorFingerprint,
			fingerprint,
			spec: tool,
		});
	}
	const identity = `caller.${tool.name}`;
	const schemaFingerprint = stableStringify(tool.parameters);
	const executorFingerprint = `caller-execute-${callerExecutorId(tool.execute)}`;
	return Object.freeze({
		identity,
		name: tool.name,
		preferredName: tool.name,
		origin: "caller" as const,
		transport: "function" as const,
		dynamicLoading: "eligible" as const,
		declaration: { name: tool.name, description: tool.description, parameters: tool.parameters },
		requested: tool,
		agentTool: tool,
		schemaFingerprint,
		executorFingerprint,
		fingerprint: stableStringify({ identity, name: tool.name, schema: schemaFingerprint, executor: executorFingerprint }),
	});
}

function callerExecutorId(execute: object): number {
	let id = callerExecutors.get(execute);
	if (id === undefined) {
		id = nextCallerExecutor++;
		callerExecutors.set(execute, id);
	}
	return id;
}

function resolveProviderFacingDeclarations(entries: readonly CuaToolCatalogEntry[]): CuaToolCatalogEntry[] {
	const google = entries.filter((entry) => entry.spec?.providerBinding?.kind === "google-native");
	const googleDeclaration = google.length > 0 ? (() => {
		const binding = google[0]!.spec!.providerBinding;
		if (binding?.kind !== "google-native") return undefined;
		const selected = new Set(google.map((entry) => {
			const selectedBinding = entry.spec!.providerBinding;
			return selectedBinding?.kind === "google-native" ? selectedBinding.nativeName : "";
		}));
		const excluded = binding.allNativeNames.filter((name) => !selected.has(name));
		return {
			type: "computer_use",
			environment: "browser",
			...(excluded.length ? { excluded_predefined_functions: excluded } : {}),
		};
	})() : undefined;

	const yutori = entries.filter((entry) => entry.spec?.providerBinding?.kind === "yutori-native");
	const yutoriDeclaration = yutori.length > 0 ? (() => {
		const binding = yutori[0]!.spec!.providerBinding;
		if (binding?.kind !== "yutori-native") return undefined;
		const selected = new Set(yutori.map((entry) => {
			const selectedBinding = entry.spec!.providerBinding;
			return selectedBinding?.kind === "yutori-native" ? selectedBinding.nativeName : "";
		}));
		return {
			...(binding.toolSet ? { tool_set: binding.toolSet } : {}),
			disable_tools: binding.allNativeNames.filter((name) => !selected.has(name)),
		};
	})() : undefined;

	return entries.map((entry) => {
		const binding = entry.spec?.providerBinding;
		const declaration = binding?.kind === "google-native"
			? googleDeclaration
			: binding?.kind === "yutori-native" ? yutoriDeclaration : undefined;
		return declaration ? Object.freeze({ ...entry, declaration: Object.freeze(declaration) }) : entry;
	});
}

function validateCatalog(model: Model<Api>, entries: readonly CuaToolCatalogEntry[]): void {
	const identities = new Map<string, CuaToolCatalogEntry>();
	const exactNames = new Map<string, CuaToolCatalogEntry>();
	const normalizedNames = new Map<string, CuaToolCatalogEntry>();
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

	validateToolsetCompatibility(model, entries);
}

function nameCollision(
	name: string,
	first: CuaToolCatalogEntry,
	second: CuaToolCatalogEntry,
	provider?: string,
): Error {
	const suffix = provider ? ` after ${provider} name normalization` : "";
	return new Error(`tool name "${name}" is requested by both "${first.identity}" and "${second.identity}"${suffix}`);
}

function validateToolCompatibility(model: Model<Api>, entry: CuaToolCatalogEntry): void {
	const spec = entry.spec;
	if (!spec) return;
	const binding = spec.providerBinding;
	if (binding) {
		const provider = binding.kind.split("-")[0];
		const required = provider === "google" ? "google" : provider;
		if (model.provider !== required) {
			throw new Error(`${spec.identity} requires a ${required} model; selected ${model.provider}:${model.id}`);
		}
	}
	if (spec.origin === "provider-recommended" && !spec.identity.startsWith(`provider.${model.provider}.`)) {
		const provider = spec.identity.split(".")[1];
		throw new Error(`${spec.identity} mirrors ${provider} tools and requires a ${provider} model; selected ${model.provider}:${model.id}`);
	}
	if (spec.complexSchema && !["openai", "anthropic", "meta", "xai", "moonshotai"].includes(model.provider)) {
		throw new Error(`provider ${model.provider} does not accept the schema used by "${entry.name}" (${entry.identity})`);
	}
	if (binding?.kind === "anthropic-native") validateAnthropicNativeModel(model, spec.identity);
	if (binding?.kind === "google-native") {
		const isLegacy = model.id.startsWith("gemini-2.5-computer-use");
		if ((binding.generation === "legacy") !== isLegacy) {
			throw new Error(`${spec.identity} requires a ${binding.generation === "legacy" ? "Gemini 2.5 computer-use" : "Gemini 3.x"} model; selected google:${model.id}`);
		}
	}
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

function validateToolsetCompatibility(model: Model<Api>, entries: readonly CuaToolCatalogEntry[]): void {
	const yutoriN1 = entries.filter((entry) => entry.spec?.providerBinding?.kind === "yutori-native" && entry.spec.providerBinding.generation === "n1");
	if (yutoriN1.length > 0) {
		const all = yutoriN1[0]!.spec!.providerBinding;
		if (all?.kind === "yutori-native" && yutoriN1.length !== all.allNativeNames.length) {
			throw new Error(`Yutori n1 cannot suppress a partial native action set; select the complete cua.providers.yutori.toolsets.n1() toolset`);
		}
	}

	const nativeProviderKinds = new Set(
		entries.flatMap((entry) => entry.spec?.providerBinding ? [entry.spec.providerBinding.kind.split("-")[0]] : []),
	);
	if (nativeProviderKinds.size > 1) {
		throw new Error(`selected tools contribute incompatible native provider transports: ${[...nativeProviderKinds].join(", ")}`);
	}
	providerForModel(model);
}

function compileHeaderRequirements(entries: readonly CuaToolCatalogEntry[]): CuaHeaderRequirement[] {
	return entries.flatMap((entry) => {
		const binding = entry.spec?.providerBinding;
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

function compilePayloadTransforms(
	model: Model<Api>,
	entries: readonly CuaToolCatalogEntry[],
	resources: CuaToolCatalogResources,
): CuaPayloadTransform[] {
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
		const binding = entry.spec?.providerBinding;
		if (!binding) continue;
		if (binding.kind === "anthropic-native" || binding.kind === "openai-native" || binding.kind === "tzafon-native") {
			const declaration = binding.kind === "tzafon-native"
				? {
						...binding.declaration,
						display_width: binding.declaration.display_width ?? resources.viewport.width,
						display_height: binding.declaration.display_height ?? resources.viewport.height,
					}
				: binding.declaration;
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

	const yutori = entries.filter((entry) => entry.spec?.providerBinding?.kind === "yutori-native");
	if (yutori.length > 0) transforms.push(...createYutoriTransforms(yutori, resources));
	const google = entries.filter((entry) => entry.spec?.providerBinding?.kind === "google-native");
	if (google.length > 0) transforms.push(createGoogleTransform(google));

	if (["meta", "xai", "moonshotai"].includes(model.provider) && entries.some((entry) => entry.spec?.stateMutating)) {
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

function createYutoriTransforms(
	entries: readonly CuaToolCatalogEntry[],
	resources: CuaToolCatalogResources,
): CuaPayloadTransform[] {
	const firstBinding = entries[0]!.spec!.providerBinding;
	if (firstBinding?.kind !== "yutori-native") throw new Error("invalid Yutori catalog entry");
	const generations = new Set(entries.map((entry) => {
		const binding = entry.spec!.providerBinding;
		return binding?.kind === "yutori-native" ? binding.generation : "";
	}));
	if (generations.size !== 1) throw new Error("Yutori n1 and n1.5 native toolsets cannot be combined");
	const selectedNativeNames = entries.map((entry) => (entry.spec!.providerBinding as Extract<CuaProviderBinding, { kind: "yutori-native" }>).nativeName);
	const selectedSet = new Set(selectedNativeNames);
	const disabled = firstBinding.allNativeNames.filter((name) => !selectedSet.has(name));
	const identity = `provider.yutori.native.${firstBinding.generation}`;
	return [
		{
			identity,
			consumesToolIdentities: entries.map((entry) => entry.identity),
			writes: ["tools", "tool_set", "disable_tools"],
			phase: "tool-declarations",
			apply(payload, _model, names) {
				const stripped = removeSerializedTools(payload, entries.map((entry) => names.get(entry.identity)!));
				if (!isRecord(stripped)) return stripped;
				return {
					...stripped,
					...(firstBinding.toolSet ? { tool_set: firstBinding.toolSet } : {}),
					disable_tools: disabled,
				};
			},
		},
		{
			identity: `${identity}.grounding`,
			writes: ["messages.grounding"],
			phase: "grounding",
			async apply(payload) {
				if (!isRecord(payload)) return payload;
				const screenshot = await resources.osScreenshot({ width: 1280, height: 800, format: "webp", quality: 90 });
				return appendImageToLatestMessage(payload, screenshot);
			},
		},
	];
}

function createGoogleTransform(entries: readonly CuaToolCatalogEntry[]): CuaPayloadTransform {
	const firstBinding = entries[0]!.spec!.providerBinding;
	if (firstBinding?.kind !== "google-native") throw new Error("invalid Google catalog entry");
	const generations = new Set(entries.map((entry) => {
		const binding = entry.spec!.providerBinding;
		return binding?.kind === "google-native" ? binding.generation : "";
	}));
	if (generations.size !== 1) throw new Error("Google legacy and current native computer toolsets cannot be combined");
	const selected = new Set(entries.map((entry) => (entry.spec!.providerBinding as Extract<CuaProviderBinding, { kind: "google-native" }>).nativeName));
	const excludedPredefinedFunctions = firstBinding.allNativeNames.filter((name) => !selected.has(name));
	return {
		identity: `provider.google.native.${firstBinding.generation}`,
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
		grounding: 3,
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

function compileIncomingPlan(entries: readonly CuaToolCatalogEntry[]): CuaIncomingToolPlan {
	let anthropicBrowserFallback: CuaAnthropicBrowserFallback | undefined;
	let openaiComputerName: string | undefined;
	let tzafonComputerName: string | undefined;
	let googleAllNativeNames: readonly string[] = [];
	const yutoriNames: Record<string, string> = {};
	const googleNames: Record<string, string> = {};
	const nativeToolNames: string[] = [];
	for (const entry of entries) {
		const binding = entry.spec?.providerBinding;
		if (!binding) continue;
		nativeToolNames.push(entry.name);
		if (binding.kind === "anthropic-native" && binding.accessFallback) anthropicBrowserFallback = binding.accessFallback;
		else if (binding.kind === "openai-native") openaiComputerName = entry.name;
		else if (binding.kind === "tzafon-native") tzafonComputerName = entry.name;
		else if (binding.kind === "yutori-native") yutoriNames[binding.nativeName] = entry.name;
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
		...(tzafonComputerName ? { tzafonComputerName } : {}),
		yutoriNames: Object.freeze(yutoriNames),
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

function appendImageToLatestMessage(
	payload: Record<string, unknown>,
	screenshot: { data: Buffer; mimeType: string },
): Record<string, unknown> {
	if (!Array.isArray(payload.messages) || payload.messages.length === 0) return payload;
	const messages = [...payload.messages];
	const last = messages.at(-1);
	if (!isRecord(last) || (last.role !== "user" && last.role !== "tool")) return payload;
	const content = typeof last.content === "string"
		? [{ type: "text", text: last.content }]
		: Array.isArray(last.content) ? [...last.content] : [];
	messages[messages.length - 1] = {
		...last,
		content: [
			...content,
			{
				type: "image_url",
				image_url: { url: `data:${screenshot.mimeType};base64,${screenshot.data.toString("base64")}`, detail: "high" },
			},
		],
	};
	return { ...payload, messages };
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

