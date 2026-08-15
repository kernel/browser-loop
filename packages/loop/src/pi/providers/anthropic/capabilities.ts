const NATIVE_BROWSER_FAMILIES = ["claude-opus-4-8", "claude-opus-5", "claude-sonnet-5"] as const;
const NATIVE_COMPUTER_FAMILIES = ["claude-fable-5", ...NATIVE_BROWSER_FAMILIES] as const;

/** Return whether an Anthropic model ID supports the July 2026 native browser tool. */
export function supportsAnthropicNativeBrowser(modelId: string): boolean {
	return NATIVE_BROWSER_FAMILIES.some((family) => modelFamily(modelId, family));
}

/** Return whether an Anthropic model ID supports the July 2026 native computer tool. */
export function supportsAnthropicNativeComputer(modelId: string): boolean {
	return NATIVE_COMPUTER_FAMILIES.some((family) => modelFamily(modelId, family));
}

function modelFamily(modelId: string, family: string): boolean {
	const id = modelId.toLowerCase();
	if (id === family) return true;
	if (!id.startsWith(`${family}-`)) return false;
	return id.slice(family.length + 1).split("-").every((segment) => /^\d+$/.test(segment));
}
