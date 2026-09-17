import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrowserAction } from "../../src/core/actions/browser";
import type { BrowserExecutor } from "../../src/core/translator/browser";
import { ObservationChangedError } from "../../src/core/translator/browser-observation";
import { buildCandidateSpace, extractLiteralUrls } from "./actions";
import { ExecutorBrowserRuntime, observationFromElements } from "./browser";
import type { ElementOperation, HistoryEntry, ObservationElement } from "./types";

function element(input: {
	id: string;
	role: string;
	name: string;
	operations: ElementOperation[];
	value?: string;
	options?: ObservationElement["options"];
	checked?: boolean;
}): ObservationElement {
	const node = Number(input.id.slice(1));
	return {
		id: input.id,
		node,
		role: input.role,
		name: input.name,
		value: input.value ?? "",
		operations: input.operations,
		options: input.options ?? [],
		...(input.checked === undefined ? {} : { checked: input.checked }),
		guard: `guard-${input.id}`,
		rect: { x: 10, y: 10, width: 100, height: 30 },
	};
}

const observation = observationFromElements({
	url: "https://flights.example/",
	title: "Flights",
	text: "Choose a route",
	scroll: { y: 0, height: 1_600, viewport: 800, width: 1_200, x: 600, pointY: 650 },
	elements: [
		element({ id: "n1", role: "textbox", name: "From", operations: ["TYPE_TEXT", "CLICK"] }),
		element({ id: "n2", role: "combobox", name: "Change ticket type. Round trip", value: "Round trip", operations: ["CLICK"] }),
		element({ id: "n3", role: "combobox", name: "Where to?", operations: ["TYPE_TEXT", "CLICK"] }),
		element({
			id: "n4",
			role: "combobox",
			name: "Cabin",
			value: "Economy",
			operations: ["SELECT"],
			options: [
				{ label: "Economy", value: "economy", selected: true },
				{ label: "Business", value: "business", selected: false },
			],
		}),
		element({ id: "n5", role: "checkbox", name: "Direct only", operations: ["CLICK"], checked: false }),
		element({ id: "n6", role: "button", name: "Search", operations: ["CLICK"] }),
		element({ id: "n7", role: "textbox", name: "Password", operations: ["TYPE_TEXT", "CLICK"] }),
		element({ id: "n8", role: "link", name: "Forgot password", operations: ["CLICK"] }),
	],
});

describe("Jev candidate space", () => {
	it("uses executable operations reported by the viewport observation", () => {
		const space = buildCandidateSpace(observation, "Find a direct business-class flight");
		assert.equal(space.byOperation.get("TYPE_TEXT")?.length, 2);
		assert.equal(space.byOperation.get("SELECT")?.length, 1);
		assert.equal(space.byOperation.get("TYPE_TEXT")?.some((candidate) => candidate.id === "type:n2"), false);
		assert.equal(space.byOperation.get("CLICK")?.some((candidate) => candidate.id === "click:n2"), true);
		assert.equal(space.byOperation.get("CLICK")?.some((candidate) => candidate.id === "click:n6"), true);
		assert.equal(space.candidates.some((candidate) => candidate.id.includes("n7")), false);
		assert.equal(space.byOperation.get("CLICK")?.some((candidate) => candidate.id === "click:n8"), true);
		assert.deepEqual(space.byOperation.get("SCROLL")?.find((candidate) => candidate.id === "scroll:down")?.action, {
			type: "browser_scroll", x: 600, y: 650, direction: "down", amount: 7,
		});
		const select = space.byOperation.get("SELECT")?.[0];
		assert.equal(select?.value, "business");
		assert.deepEqual(select?.target, { documentId: "test-document", node: 4, guard: "guard-n4" });
	});

	it("keeps every visible date and the calendar confirmation control", () => {
		const dates = Array.from({ length: 51 }, (_, index) => element({
			id: `n${index + 2}`,
			role: "button",
			name: `Visible date ${index + 1}`,
			operations: ["CLICK"],
		}));
		const calendar = observationFromElements({
			url: "https://flights.example/",
			elements: [
				element({ id: "n1", role: "textbox", name: "Departure", operations: ["TYPE_TEXT", "CLICK"] }),
				...dates,
				element({ id: "n53", role: "button", name: "Done", operations: ["CLICK"] }),
			],
		});
		const clicks = buildCandidateSpace(calendar, "Fly on December 14").byOperation.get("CLICK") ?? [];
		assert.equal(clicks.length, 53);
		assert.equal(clicks.some((candidate) => candidate.id === "click:n53"), true);
	});

	it("keeps forward navigation after actions that do not change history", () => {
		const history: HistoryEntry[] = [
			{ step: 1, operation: "BACK", candidateId: "history:back", label: "Go back", pageChanged: true, url: "https://flights.example/first" },
			{ step: 2, operation: "WAIT", candidateId: "wait", label: "Wait", pageChanged: false, url: "https://flights.example/first" },
		];
		assert.equal(buildCandidateSpace(observation, "Continue", history).byOperation.has("FORWARD"), true);
		history.push({ step: 3, operation: "CLICK", candidateId: "click:n1", label: "Open another page", pageChanged: true, url: "https://flights.example/other" });
		assert.equal(buildCandidateSpace(observation, "Continue", history).byOperation.has("FORWARD"), false);
	});

	it("offers literal URLs or a navigation text escape hatch", () => {
		assert.deepEqual(extractLiteralUrls("Open https://example.com/path, then continue"), ["https://example.com/path"]);
		assert.equal(buildCandidateSpace(observation, "Open https://example.com/path").byOperation.get("NAVIGATE")?.[0]?.value, "https://example.com/path");
		assert.equal(buildCandidateSpace(observation, "Open Google Flights").byOperation.get("NAVIGATE")?.[0]?.textPurpose, "navigation");
	});

	it("treats internal startup pages as navigation-only", () => {
		const newTab = observationFromElements({
			url: "chrome://newtab/",
			elements: [element({ id: "n1", role: "searchbox", name: "Search", operations: ["TYPE_TEXT", "CLICK"] })],
		});
		const space = buildCandidateSpace(newTab, "Open Wikipedia");
		assert.equal(space.byOperation.has("TYPE_TEXT"), false);
		assert.equal(space.byOperation.has("CLICK"), false);
		assert.deepEqual(space.elements, []);
	});
});

describe("browser observation", () => {
	it("treats navigation during a freshness check as stale", async () => {
		const executor = {
			execute: async () => { throw new Error("Execution context was destroyed during navigation"); },
		} as unknown as BrowserExecutor;
		const candidate = buildCandidateSpace(observation, "Search").byOperation.get("CLICK")?.[0];
		if (!candidate) throw new Error("Missing click candidate");
		assert.equal(await new ExecutorBrowserRuntime(executor).isFresh(observation, candidate), false);
	});

	it("adds controls from a visible cross-origin frame", async () => {
		const payload = {
			url: "https://restaurant.example/reservations", title: "Reservations", documentId: "1", text: "Reservations",
			elements: [element({ id: "n1", role: "button", name: "Reservations", operations: ["CLICK"] })],
			scroll: { y: 0, height: 800, viewport: 800, width: 1200, x: 600, pointY: 647 },
			marker: "marker", omitted: 0, visibleFrameNames: ["Reservation widget"],
		};
		const actions: BrowserAction[] = [];
		const executor = {
			execute: async (action: BrowserAction) => {
				actions.push(action);
				if (action.type === "browser_evaluate") return [{ type: "browser_text", label: "evaluate", text: JSON.stringify(payload) }];
				if (action.type === "browser_snapshot") return [{
					type: "browser_text",
					label: "snapshot",
					text: [
						'button "Offscreen main-page action" [e1]',
						'Iframe "Reservation widget" [e2]',
						'  RootWebArea "Reservation widget"',
						'    combobox "Reservation Date" [e3] [expanded=false, value="Oct 15, 2026"]',
						'    combobox "Reservation time" [e4] [expanded=false, value="7:00 PM"]',
						'      option "7:00 PM" [e5] [selected]',
						'      option "7:30 PM" [e6]',
						'    button "Find a Table" [e7]',
						'button "Another main-page action" [e8]',
					].join("\n"),
				}];
				if (action.type === "browser_click") return [];
				throw new Error(`Unexpected action ${action.type}`);
			},
		} as unknown as BrowserExecutor;
		const runtime = new ExecutorBrowserRuntime(executor);
		const observed = await runtime.observe();
		const space = buildCandidateSpace(observed, "Find a reservation");
		assert.equal(space.byOperation.get("CLICK")?.some((candidate) => candidate.label.includes("Reservation Date")), true);
		assert.equal(space.byOperation.get("SELECT")?.some((candidate) => candidate.label.includes("7:30 PM")), true);
		assert.equal(space.candidates.some((candidate) => candidate.label.includes("Offscreen main-page action")), false);
		const findTable = space.byOperation.get("CLICK")?.find((candidate) => candidate.label.includes("Find a Table"));
		if (!findTable) throw new Error("Missing Find a Table candidate");
		await runtime.executeTarget(findTable);
		assert.deepEqual(actions.at(-1), { type: "browser_click", ref: "e7" });
	});

	it("retries when the page changes during viewport collection", async () => {
		let attempts = 0;
		const payload = {
			url: "https://example.com/", title: "Example", documentId: "1", text: "Continue",
			elements: [element({ id: "n1", role: "link", name: "Continue", operations: ["CLICK"] })],
			scroll: { y: 0, height: 800, viewport: 800, width: 1200, x: 600, pointY: 647 },
			marker: "marker", omitted: 0,
		};
		const executor = {
			execute: async (action: BrowserAction) => {
				if (action.type !== "browser_evaluate") throw new Error(`Unexpected action ${action.type}`);
				attempts += 1;
				if (attempts === 1) throw new ObservationChangedError();
				return [{ type: "browser_text", label: "evaluate", text: JSON.stringify(payload) }];
			},
		} as unknown as BrowserExecutor;
		const observed = await new ExecutorBrowserRuntime(executor).observe();
		assert.equal(attempts, 2);
		assert.equal(observed.elements[0]?.name, "Continue");
	});
});
