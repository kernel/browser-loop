/** Prefix a bare hostname/path before browser navigation. */
export function normalizeGotoUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const url = value.trim();
	if (!url) return undefined;
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}
