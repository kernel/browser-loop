import type { TSchema } from "@earendil-works/pi-ai";
import { CUA_BROWSER_ACTION_TYPES, createCuaBrowserActionSchemaByType, type CuaBrowserAction, type CuaBrowserActionType, type CuaBrowserSchemaOptions } from "./browser";
import { CUA_COMPUTER_ACTION_SCHEMA_BY_TYPE, CUA_COMPUTER_ACTION_TYPES, type CuaComputerAction, type CuaComputerActionType } from "./computer";

export * from "./browser";
export * from "./computer";

/** Any canonical CUA action type, across the computer and browser planes. */
export type CuaActionType = CuaComputerActionType | CuaBrowserActionType;

/** Any canonical CUA action, across the computer and browser planes. */
export type CuaAction = CuaComputerAction | CuaBrowserAction;

/** Every canonical action type: the computer plane followed by the browser plane. */
export const CUA_ALL_ACTION_TYPES: readonly CuaActionType[] = [...CUA_COMPUTER_ACTION_TYPES, ...CUA_BROWSER_ACTION_TYPES];

const COMPUTER_ACTION_TYPE_SET: ReadonlySet<string> = new Set(CUA_COMPUTER_ACTION_TYPES);
const BROWSER_ACTION_TYPE_SET: ReadonlySet<string> = new Set(CUA_BROWSER_ACTION_TYPES);

/** Whether a canonical action type belongs to the computer plane. */
export function isCuaComputerActionType(action: CuaActionType): action is CuaComputerActionType {
	return COMPUTER_ACTION_TYPE_SET.has(action);
}

/** Whether a canonical action type belongs to the browser plane. */
export function isCuaBrowserActionType(action: CuaActionType): action is CuaBrowserActionType {
	return BROWSER_ACTION_TYPE_SET.has(action);
}

/** Whether a canonical action belongs to the browser plane. */
export function isCuaBrowserAction(action: CuaAction): action is CuaBrowserAction {
	return BROWSER_ACTION_TYPE_SET.has(action.type);
}

/** Options for building canonical action schemas. */
export interface CuaActionSchemaOptions {
	/** browser-plane schema variants; see {@link CuaBrowserSchemaOptions}. Defaults to coordinates allowed. */
	browser?: CuaBrowserSchemaOptions;
}

/** Build the full action-type → schema map for a schema-options combination. */
export function cuaActionSchemaByType(options: CuaActionSchemaOptions = {}): Record<CuaActionType, TSchema> {
	return {
		...CUA_COMPUTER_ACTION_SCHEMA_BY_TYPE,
		...createCuaBrowserActionSchemaByType(options.browser ?? { coordinates: true }),
	};
}
