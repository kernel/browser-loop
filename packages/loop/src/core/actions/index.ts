import type { TSchema } from "@earendil-works/pi-ai";
import { BROWSER_ACTION_TYPES, createBrowserActionSchemaByType, type BrowserAction, type BrowserActionType, type BrowserActionSchemaOptions } from "./browser";
import { COMPUTER_ACTION_SCHEMA_BY_TYPE, COMPUTER_ACTION_TYPES, type ComputerAction, type ComputerActionType } from "./computer";

export * from "./browser";
export * from "./computer";

/** Any canonical action type, across the computer and browser planes. */
export type ComputerUseActionType = ComputerActionType | BrowserActionType;

/** Any canonical action, across the computer and browser planes. */
export type ComputerUseAction = ComputerAction | BrowserAction;

/** Every canonical action type: the computer plane followed by the browser plane. */
export const COMPUTER_USE_ACTION_TYPES: readonly ComputerUseActionType[] = [...COMPUTER_ACTION_TYPES, ...BROWSER_ACTION_TYPES];

const COMPUTER_ACTION_TYPE_SET: ReadonlySet<string> = new Set(COMPUTER_ACTION_TYPES);
const BROWSER_ACTION_TYPE_SET: ReadonlySet<string> = new Set(BROWSER_ACTION_TYPES);

/** Whether a canonical action type belongs to the computer plane. */
export function isComputerActionType(action: ComputerUseActionType): action is ComputerActionType {
	return COMPUTER_ACTION_TYPE_SET.has(action);
}

/** Whether a canonical action type belongs to the browser plane. */
export function isBrowserActionType(action: ComputerUseActionType): action is BrowserActionType {
	return BROWSER_ACTION_TYPE_SET.has(action);
}

/** Whether a canonical action belongs to the browser plane. */
export function isBrowserAction(action: ComputerUseAction): action is BrowserAction {
	return BROWSER_ACTION_TYPE_SET.has(action.type);
}

/** Options for building canonical action schemas. */
export interface ComputerUseActionSchemaOptions {
	/** browser-plane schema variants; see {@link BrowserActionSchemaOptions}. Defaults to coordinates allowed. */
	browser?: BrowserActionSchemaOptions;
}

/** Build the full action-type → schema map for a schema-options combination. */
export function computerUseActionSchemaByType(options: ComputerUseActionSchemaOptions = {}): Record<ComputerUseActionType, TSchema> {
	return {
		...COMPUTER_ACTION_SCHEMA_BY_TYPE,
		...createBrowserActionSchemaByType(options.browser ?? { coordinates: true }),
	};
}
