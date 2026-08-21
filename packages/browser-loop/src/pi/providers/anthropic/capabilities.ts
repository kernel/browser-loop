const NATIVE_TOOLSET_FAMILIES = ["claude-fable-5", "claude-mythos-5", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5"] as const;

/** Return whether an Anthropic model ID supports the GA browser toolset. */
export function supportsAnthropicNativeBrowser(modelId: string): boolean {
	return NATIVE_TOOLSET_FAMILIES.some((family) => modelFamily(modelId, family));
}

/** Return whether an Anthropic model ID supports the GA computer toolset. */
export function supportsAnthropicNativeComputer(modelId: string): boolean {
	return NATIVE_TOOLSET_FAMILIES.some((family) => modelFamily(modelId, family));
}

function modelFamily(modelId: string, family: string): boolean {
	const id = modelId.toLowerCase();
	if (id === family) return true;
	if (!id.startsWith(`${family}-`)) return false;
	return id.slice(family.length + 1).split("-").every((segment) => /^\d+$/.test(segment));
}
