import type { CuaSelection } from "./selection";

export const CONFIG_ENTRY = "cua-pi-config-v1";
export interface PersistedConfig {
	version: 1;
	origin: "command";
	selectors: string[];
	coordinates: CuaSelection["coordinates"];
	browser?: { sessionId?: string; owned?: boolean; liveUrl?: string; createdAt?: string };
}
export function restoreConfig(entries: readonly unknown[]): PersistedConfig | undefined {
	for (const entry of [...entries].reverse()) {
		const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (candidate.type !== "custom" || candidate.customType !== CONFIG_ENTRY || !candidate.data || typeof candidate.data !== "object")
			continue;
		const data = candidate.data as Partial<PersistedConfig>;
		if (
			data.version === 1 &&
			data.origin === "command" &&
			Array.isArray(data.selectors) &&
			data.selectors.every((selector) => typeof selector === "string") &&
			(data.coordinates === "pixels" || data.coordinates === "normalized-1000")
		) {
			return {
				version: 1,
				origin: "command",
				selectors: data.selectors,
				coordinates: data.coordinates,
			};
		}
	}
}
