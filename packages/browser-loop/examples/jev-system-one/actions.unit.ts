import assert from "node:assert/strict";
import test from "node:test";
import { buildActions, taskValueCandidates } from "./actions";
import type { Observation } from "./types";

test("extracts quoted and email values without exceeding the candidate bound", () => {
	const values = taskValueCandidates('Fill Full name with "Ada Lovelace" and email ada@example.com');
	assert(values.includes("Ada Lovelace"));
	assert(values.includes("ada@example.com"));
	assert(values.length <= 60);
});

test("does not offer a toggle action for an already checked control", () => {
	const observation: Observation = {
		url: "https://example.test",
		title: "test",
		text: "Weekly updates enabled",
		elements: [
			{ id: "e0", tag: "input", role: "", name: "Weekly updates", type: "checkbox", value: "true" },
			{ id: "e1", tag: "button", role: "", name: "Apply", type: "button", value: "" },
		],
	};
	const actions = buildActions(observation, []);
	assert(!actions.some((action) => action.kind === "click" && action.elementId === "e0"));
	assert(actions.some((action) => action.kind === "click" && action.elementId === "e1"));
	assert(actions.length <= 255);
});

test("reserves finish and fail actions when a select has more than 255 options", () => {
	const observation: Observation = {
		url: "https://example.test",
		title: "test",
		text: "Large select",
		elements: [{
			id: "e0",
			tag: "select",
			role: "",
			name: "Item",
			type: "select-one",
			value: "",
			options: Array.from({ length: 300 }, (_, index) => `v${index} (Option ${index})`),
		}],
	};
	const actions = buildActions(observation, []);
	assert(actions.length <= 255);
	assert(actions.some((action) => action.kind === "finish"));
	assert(actions.some((action) => action.kind === "fail"));
});
