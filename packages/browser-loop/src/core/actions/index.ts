import { BROWSER_ACTION_TYPES, type BrowserAction } from "./browser";
import type { ComputerAction } from "./computer";

export * from "./browser";
export * from "./computer";

/** Any canonical action, across the computer and browser planes. */
export type ComputerUseAction = ComputerAction | BrowserAction;

const BROWSER_ACTION_TYPE_SET: ReadonlySet<string> = new Set(BROWSER_ACTION_TYPES);

/** Whether a canonical action belongs to the browser plane. */
export function isBrowserAction(action: ComputerUseAction): action is BrowserAction {
	return BROWSER_ACTION_TYPE_SET.has(action.type);
}
