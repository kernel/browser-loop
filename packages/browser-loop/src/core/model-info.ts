/** The model identity fields Loop's core consults. */
export interface LoopModelIdentity {
	readonly provider: string;
	readonly id: string;
}

/** A provider-native tool surface Loop can offer for a model. */
export type ComputerUseNativeSurface = "computer" | "browser";

/** Loop tool-catalog capabilities for a concrete model. */
export interface LoopModelCapabilities {
	readonly acceptsComplexSchemas: boolean;
	readonly acceptsLargeSchemas: boolean;
	readonly serializesStateMutations: boolean;
}

/**
 * Framework-neutral view of the model a catalog is compiled for: identity and
 * the transport it carries. A pi-ai `Model` satisfies this shape structurally;
 * core never sees more of it.
 */
export interface LoopCatalogModel extends LoopModelIdentity {
	readonly api: string;
}

/**
 * Per-model availability facts the compiler and menu consult. The binding
 * supplies them — pi derives them from its model registry and quirk tables —
 * so core never owns a provider capability lookup. Absent facts mean
 * permissive capabilities and no native surfaces.
 */
export interface LoopModelFacts {
	/** Request-shape limits for the model. Absent means permissive. */
	readonly capabilities?: LoopModelCapabilities;
	/** Provider-native tool surfaces the model can carry. Absent means none. */
	readonly nativeSurfaces?: readonly ComputerUseNativeSurface[];
}

const PERMISSIVE_CAPABILITIES: LoopModelCapabilities = Object.freeze({
	acceptsComplexSchemas: true,
	acceptsLargeSchemas: true,
	serializesStateMutations: false,
});

/** The capabilities a facts object carries, defaulting to permissive. */
export function loopModelFactsCapabilities(facts: LoopModelFacts | undefined): LoopModelCapabilities {
	return facts?.capabilities ?? PERMISSIVE_CAPABILITIES;
}

/** The native surfaces a facts object carries, defaulting to none. */
export function loopModelFactsNativeSurfaces(facts: LoopModelFacts | undefined): readonly ComputerUseNativeSurface[] {
	return facts?.nativeSurfaces ?? [];
}
