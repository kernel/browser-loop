import { loop as coreLoop } from "../core/tools";
import { supportsAnthropicNativeBrowser } from "./providers/anthropic/capabilities";

/**
 * The published tool namespace: core's declarations with the pi binding's
 * per-model availability helpers composed in. Availability decisions live on
 * the pi side of the boundary; core only declares the tools.
 */
export const loop = Object.freeze({
	...coreLoop,
	providers: Object.freeze({
		...coreLoop.providers,
		anthropic: Object.freeze({
			...coreLoop.providers.anthropic,
			supports: Object.freeze({ browser: supportsAnthropicNativeBrowser }),
		}),
	}),
});

export type LoopNamespace = typeof loop;
