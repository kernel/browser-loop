import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { computerUseNativeSurfaces, type ComputerUseNativeSurface } from "../core/model-info";

export {
	COMPUTER_USE_NATIVE_SURFACES,
	LOOP_MODEL_QUIRKS,
	computerUseNativeSurfaces,
	loopModelCapabilities,
	loopModelQuirks,
	supportsAnthropicNativeBrowser,
	supportsAnthropicNativeComputer,
} from "../core/model-info";
export type {
	ComputerUseNativeSurface,
	LoopModelCapabilities,
	LoopModelMatch,
	LoopModelQuirk,
} from "../core/model-info";

/** A pi-ai provider id. Any provider pi-ai carries can be selected. */
export type LoopProvider = string;

/** Provider-qualified model reference, e.g. `"openai:gpt-5.6-sol"` or `"google:gemini-3.6-flash"`. */
export type LoopModelRef = `${string}:${string}`;

/** One entry returned by {@link listLoopModels}. */
export interface LoopModelInfo {
	/** Provider-qualified ref accepted by {@link getLoopModel}. */
	ref: LoopModelRef;
	provider: LoopProvider;
	/** Provider-native model id (the part after the colon). */
	model: string;
	/** Human-readable model name. */
	name: string;
	/** Provider-native tool surfaces available for this model, if any. */
	nativeSurfaces: readonly ComputerUseNativeSurface[];
	/** Whether the model accepts image input, i.e. whether screenshot-based tools are usable. */
	vision: boolean;
}

/** Provider prefixes accepted as aliases for a pi-ai provider id. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = { gemini: "google", moonshot: "moonshotai" };

/**
 * Split a provider-qualified ref like `"openai:gpt-5.6-sol"` into its parts.
 *
 * `"gemini:"` is accepted as an alias for the canonical `"google:"` prefix and
 * `"moonshot:"` for `"moonshotai"`. Throws when the ref is unqualified or names
 * a provider pi-ai does not carry.
 */
export function parseLoopModelRef(ref: string): { provider: LoopProvider; model: string } {
	const idx = ref.indexOf(":");
	if (idx <= 0 || idx === ref.length - 1) {
		throw new Error(`Loop model ref must be provider-qualified as "<provider>:<model>"; got "${ref}"`);
	}
	const prefix = ref.slice(0, idx);
	const provider = PROVIDER_ALIASES[prefix] ?? prefix;
	const model = ref.slice(idx + 1);
	if (!loopProviders().includes(provider)) {
		throw new Error(`unknown provider "${prefix}" (pi-ai carries: ${loopProviders().join(", ")})`);
	}
	return { provider, model };
}

/** Join a provider and model id into a {@link LoopModelRef}. */
export function formatLoopModelRef(provider: LoopProvider, model: string): LoopModelRef {
	return `${provider}:${model}` as LoopModelRef;
}

/** Every provider id pi-ai carries. */
export function loopProviders(): readonly LoopProvider[] {
	return getBuiltinProviders();
}

/**
 * List the models pi-ai carries, optionally filtered to one provider, each
 * annotated with the provider-native surfaces Loop can offer for it.
 */
export function listLoopModels(provider?: LoopProvider): LoopModelInfo[] {
	const providers = provider ? [PROVIDER_ALIASES[provider] ?? provider] : [...loopProviders()];
	const byRef = new Map<LoopModelRef, LoopModelInfo>();

	for (const p of providers) {
		for (const model of getBuiltinModels(p as never) as Model<Api>[]) {
			const ref = formatLoopModelRef(p, model.id);
			if (byRef.has(ref)) continue;
			byRef.set(ref, {
				ref,
				provider: p,
				model: model.id,
				name: model.name,
				nativeSurfaces: computerUseNativeSurfaces(model),
				vision: model.input.includes("image"),
			});
		}
	}

	return [...byRef.values()].sort(compareLoopModels);
}

/**
 * Resolve a {@link LoopModelRef} to a concrete pi-ai model.
 *
 * A ref pi-ai's registry does not carry is synthesized from the provider's
 * other models, so a model id works the day the provider ships it rather than
 * when models.dev catches up. Throws only for an unqualified ref or a provider
 * pi-ai does not carry.
 */
export function getLoopModel(ref: LoopModelRef): Model<Api> {
	const { provider, model: modelId } = parseLoopModelRef(ref);
	const fromRegistry = getBuiltinModel(provider as never, modelId as never) as Model<Api> | undefined;
	if (fromRegistry) return fromRegistry;
	return synthesizeLoopModel(provider, modelId);
}

/**
 * Build a model entry for an id pi-ai's registry does not carry, using another
 * model from the same provider for the transport, base URL, and compatibility
 * fields it cannot know from the id alone.
 *
 * The template is the sibling sharing the longest id prefix, and the latest
 * such sibling when several tie. Providers migrate transports mid-generation —
 * xAI carries grok-4.3 on chat completions and grok-4.5 on Responses — so a new
 * id should follow its nearest, newest relative rather than whichever model
 * happens to come first.
 */
function synthesizeLoopModel(provider: LoopProvider, modelId: string): Model<Api> {
	const siblings = getBuiltinModels(provider as never) as Model<Api>[];
	if (siblings.length === 0) {
		throw new Error(`provider "${provider}" carries no models to infer "${modelId}" from`);
	}
	let template = siblings[0]!;
	let bestPrefix = -1;
	siblings.forEach((sibling, index) => {
		const prefix = sharedPrefixLength(sibling.id.toLowerCase(), modelId.toLowerCase());
		if (prefix >= bestPrefix) {
			bestPrefix = prefix;
			template = siblings[index]!;
		}
	});
	return { ...template, id: modelId, name: modelId };
}

function sharedPrefixLength(a: string, b: string): number {
	let length = 0;
	while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
	return length;
}

/** Return the provider id for a concrete model. */
export function providerForModel(model: Model<Api>): LoopProvider {
	return model.provider;
}

function compareLoopModels(a: LoopModelInfo, b: LoopModelInfo): number {
	if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
	return a.model.localeCompare(b.model);
}
