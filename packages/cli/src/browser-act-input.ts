import type { CuaActionBrowserAct, CuaBrowserExpectation } from "@onkernel/cua-ai";

type BrowserActInput = Omit<CuaActionBrowserAct, "type">;
type JsonObject = Record<string, unknown>;

const STEP_TYPES = new Set(["click", "hover", "fill", "type", "key", "scroll_to", "wait"]);

/** Parse one JSON argument and validate it before any browser side effect occurs. */
export function parseBrowserActInput(raw: string): BrowserActInput {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`invalid cua act JSON: ${(error as Error).message}`);
	}
	const input = objectAt(parsed, "$", ["steps", "expect", "timeout_ms", "poll_ms", "successor", "tab_id"]);
	const steps = input.steps;
	if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) {
		fail("$.steps", "expected an array with 1–20 steps");
	}
	for (let index = 0; index < steps.length; index += 1) validateStep(steps[index], `$.steps[${index}]`);
	if (input.expect !== undefined) validateExpectation(input.expect, "$.expect");
	optionalNumber(input.timeout_ms, "$.timeout_ms", 1, 30_000);
	optionalNumber(input.poll_ms, "$.poll_ms", 10, 1_000);
	optionalString(input.tab_id, "$.tab_id");
	if (input.successor !== undefined) {
		const successor = objectAt(input.successor, "$.successor", ["filter", "depth"]);
		if (successor.filter !== undefined && successor.filter !== "all" && successor.filter !== "interactive") {
			fail("$.successor.filter", 'expected "all" or "interactive"');
		}
		optionalNumber(successor.depth, "$.successor.depth");
	}
	return input as unknown as BrowserActInput;
}

function validateStep(value: unknown, path: string): void {
	const step = objectAt(value, path);
	if (typeof step.type !== "string" || !STEP_TYPES.has(step.type)) {
		fail(`${path}.type`, `expected one of ${[...STEP_TYPES].join(", ")}`);
	}
	const common = ["type", "timeout_ms", "expect"];
	switch (step.type) {
		case "click":
			assertOnlyKeys(step, path, [...common, "ref", "button", "num_clicks", "modifiers"]);
			requiredString(step.ref, `${path}.ref`);
			if (step.button !== undefined && !["left", "right", "middle"].includes(String(step.button))) {
				fail(`${path}.button`, 'expected "left", "right", or "middle"');
			}
			if (step.num_clicks !== undefined && (!Number.isInteger(step.num_clicks) || Number(step.num_clicks) < 1 || Number(step.num_clicks) > 3)) {
				fail(`${path}.num_clicks`, "expected an integer from 1 to 3");
			}
			if (step.modifiers !== undefined && (!Array.isArray(step.modifiers) || step.modifiers.some((entry) => typeof entry !== "string"))) {
				fail(`${path}.modifiers`, "expected an array of strings");
			}
			break;
		case "hover":
		case "scroll_to":
			assertOnlyKeys(step, path, [...common, "ref"]);
			requiredString(step.ref, `${path}.ref`);
			break;
		case "fill":
			assertOnlyKeys(step, path, [...common, "ref", "value"]);
			requiredString(step.ref, `${path}.ref`);
			if (!["string", "number", "boolean"].includes(typeof step.value) || typeof step.value === "number" && !Number.isFinite(step.value)) {
				fail(`${path}.value`, "expected a string, finite number, or boolean");
			}
			break;
		case "type":
			assertOnlyKeys(step, path, [...common, "text"]);
			requiredString(step.text, `${path}.text`);
			break;
		case "key":
			assertOnlyKeys(step, path, [...common, "text", "repeat"]);
			requiredString(step.text, `${path}.text`);
			optionalNumber(step.repeat, `${path}.repeat`);
			break;
		case "wait":
			assertOnlyKeys(step, path, [...common, "ms"]);
			optionalNumber(step.ms, `${path}.ms`, 0, 30_000);
			break;
	}
	optionalNumber(step.timeout_ms, `${path}.timeout_ms`, 1, 30_000);
	if (step.expect !== undefined) validateExpectation(step.expect, `${path}.expect`);
}

function validateExpectation(value: unknown, path: string): asserts value is CuaBrowserExpectation {
	const expectation = objectAt(value, path);
	if ("all" in expectation || "any" in expectation) {
		const key = "all" in expectation ? "all" : "any";
		assertOnlyKeys(expectation, path, [key]);
		const leaves = expectation[key];
		if (!Array.isArray(leaves) || leaves.length === 0) fail(`${path}.${key}`, "expected a non-empty array");
		for (let index = 0; index < leaves.length; index += 1) validateExpectationLeaf(leaves[index], `${path}.${key}[${index}]`);
		return;
	}
	validateExpectationLeaf(expectation, path);
}

function validateExpectationLeaf(value: unknown, path: string): void {
	const leaf = objectAt(value, path);
	switch (leaf.type) {
		case "text":
			assertOnlyKeys(leaf, path, ["type", "text", "exists"]);
			requiredString(leaf.text, `${path}.text`);
			optionalBoolean(leaf.exists, `${path}.exists`);
			return;
		case "role_name":
			assertOnlyKeys(leaf, path, ["type", "role", "name", "exists"]);
			optionalString(leaf.role, `${path}.role`);
			optionalString(leaf.name, `${path}.name`);
			if (leaf.role === undefined && leaf.name === undefined) fail(path, "role_name requires role or name");
			optionalBoolean(leaf.exists, `${path}.exists`);
			return;
		case "ref": {
			assertOnlyKeys(leaf, path, ["type", "ref", "value", "checked", "selected", "expanded"]);
			requiredString(leaf.ref, `${path}.ref`);
			optionalString(leaf.value, `${path}.value`);
			if (leaf.checked !== undefined && typeof leaf.checked !== "boolean" && leaf.checked !== "mixed") {
				fail(`${path}.checked`, 'expected a boolean or "mixed"');
			}
			optionalBoolean(leaf.selected, `${path}.selected`);
			optionalBoolean(leaf.expanded, `${path}.expanded`);
			if ([leaf.value, leaf.checked, leaf.selected, leaf.expanded].every((entry) => entry === undefined)) {
				fail(path, "ref expectation requires value, checked, selected, or expanded");
			}
			return;
		}
		case "url":
		case "title":
			assertOnlyKeys(leaf, path, ["type", "equals", "contains", "changed"]);
			optionalString(leaf.equals, `${path}.equals`);
			optionalString(leaf.contains, `${path}.contains`);
			optionalBoolean(leaf.changed, `${path}.changed`);
			if (leaf.equals === undefined && leaf.contains === undefined && leaf.changed === undefined) {
				fail(path, `${String(leaf.type)} expectation requires equals, contains, or changed`);
			}
			return;
		default:
			fail(`${path}.type`, "expected text, role_name, ref, url, or title");
	}
}

function objectAt(value: unknown, path: string, keys?: readonly string[]): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object");
	const object = value as JsonObject;
	if (keys) assertOnlyKeys(object, path, keys);
	return object;
}

function assertOnlyKeys(value: JsonObject, path: string, allowed: readonly string[]): void {
	const extras = Object.keys(value).filter((key) => !allowed.includes(key));
	if (extras.length) fail(path, `unexpected propert${extras.length === 1 ? "y" : "ies"}: ${extras.join(", ")}`);
}

function requiredString(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string") fail(path, "expected a string");
}

function optionalString(value: unknown, path: string): void {
	if (value !== undefined) requiredString(value, path);
}

function optionalBoolean(value: unknown, path: string): void {
	if (value !== undefined && typeof value !== "boolean") fail(path, "expected a boolean");
}

function optionalNumber(value: unknown, path: string, minimum?: number, maximum?: number): void {
	if (value === undefined) return;
	if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number");
	if (minimum !== undefined && value < minimum) fail(path, `expected a number >= ${minimum}`);
	if (maximum !== undefined && value > maximum) fail(path, `expected a number <= ${maximum}`);
}

function fail(path: string, message: string): never {
	throw new Error(`invalid cua act input at ${path}: ${message}`);
}
