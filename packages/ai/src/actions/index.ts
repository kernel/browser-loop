import type { TSchema } from "@earendil-works/pi-ai";
import { CUA_DOM_ACTION_TYPES, createCuaDomActionSchemaByType, type CuaDomAction, type CuaDomActionType, type CuaDomSchemaOptions } from "./dom";
import { CUA_OS_ACTION_SCHEMA_BY_TYPE, CUA_OS_ACTION_TYPES, type CuaOsAction, type CuaOsActionType } from "./os";

export * from "./dom";
export * from "./os";

/** Any canonical CUA action type, across the OS and DOM planes. */
export type CuaActionType = CuaOsActionType | CuaDomActionType;

/** Any canonical CUA action, across the OS and DOM planes. */
export type CuaAction = CuaOsAction | CuaDomAction;

/** Every canonical action type: the OS plane followed by the DOM plane. */
export const CUA_ALL_ACTION_TYPES: readonly CuaActionType[] = [...CUA_OS_ACTION_TYPES, ...CUA_DOM_ACTION_TYPES];

const OS_ACTION_TYPE_SET: ReadonlySet<string> = new Set(CUA_OS_ACTION_TYPES);
const DOM_ACTION_TYPE_SET: ReadonlySet<string> = new Set(CUA_DOM_ACTION_TYPES);

/** Whether a canonical action type belongs to the OS plane. */
export function isCuaOsActionType(action: CuaActionType): action is CuaOsActionType {
	return OS_ACTION_TYPE_SET.has(action);
}

/** Whether a canonical action type belongs to the DOM plane. */
export function isCuaDomActionType(action: CuaActionType): action is CuaDomActionType {
	return DOM_ACTION_TYPE_SET.has(action);
}

/** Whether a canonical action belongs to the DOM plane. */
export function isCuaDomAction(action: CuaAction): action is CuaDomAction {
	return DOM_ACTION_TYPE_SET.has(action.type);
}

/** Options for building canonical action schemas. */
export interface CuaActionSchemaOptions {
	/** DOM-plane schema variants; see {@link CuaDomSchemaOptions}. Defaults to coordinates allowed. */
	dom?: CuaDomSchemaOptions;
}

/** Build the full action-type → schema map for a schema-options combination. */
export function cuaActionSchemaByType(options: CuaActionSchemaOptions = {}): Record<CuaActionType, TSchema> {
	return {
		...CUA_OS_ACTION_SCHEMA_BY_TYPE,
		...createCuaDomActionSchemaByType(options.dom ?? { coordinates: true }),
	};
}
