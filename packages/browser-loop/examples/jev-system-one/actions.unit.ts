import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrowserAction } from "../../src/core/actions/browser";
import type { BrowserExecutor } from "../../src/core/translator/browser";
import { ObservationChangedError } from "../../src/core/translator/browser-observation";
import { buildCandidateSpace, extractLiteralUrls } from "./actions";
import { ExecutorBrowserRuntime, observationFromSnapshot } from "./browser";
import type { HistoryEntry } from "./types";

const observation = observationFromSnapshot({
	url: "https://flights.example/",
	scroll: { y: 0, height: 1_600, viewport: 800, width: 1_200 },
	snapshot: [
		'RootWebArea "Flights"',
		'  heading "Search flights" [e1] [level=1]',
		'  textbox "From" [e2]',
		'  textbox "To" [e3] [value="JFK"]',
		'  combobox "Cabin" [e4] [value="Economy"]',
		'    option "Economy" [e5] [selected]',
		'    option "Business" [e6]',
		'  checkbox "Direct only" [e7] [checked=false]',
		'  button "Search" [e8]',
		'  textbox "Password" [e9]',
		'  link "Forgot password" [e10]',
		'  button "Show password" [e11]',
		'  StaticText "Choose a route"',
	].join("\n"),
});

describe("Jev candidate space", () => {
	it("maps the accessibility snapshot to operation groups", () => {
		const space = buildCandidateSpace(observation, "Find a direct business-class flight");
		assert.equal(space.byOperation.get("TYPE_TEXT")?.length, 2);
		assert.equal(space.byOperation.get("SELECT")?.length, 1);
		assert.equal(space.byOperation.get("CLICK")?.some((candidate) => candidate.ref === "e7"), true);
		assert.equal(space.byOperation.get("CLICK")?.some((candidate) => candidate.ref === "e8"), true);
		const scroll = space.byOperation.get("SCROLL")?.find((candidate) => candidate.id === "scroll:down");
		assert.deepEqual(scroll?.action, { type: "browser_scroll", x: 600, y: 400, direction: "down", amount: 7 });
		assert.equal(space.candidates.some((candidate) => candidate.ref === "e9"), false);
		assert.equal(space.elements.some((element) => element.ref === "e9"), false);
		assert.equal(space.byOperation.get("CLICK")?.some((candidate) => candidate.ref === "e10"), true);
		assert.equal(space.byOperation.get("CLICK")?.some((candidate) => candidate.ref === "e11"), true);
		assert.equal(space.byOperation.has("FORWARD"), false);
		const select = space.byOperation.get("SELECT")?.[0];
		assert.deepEqual(select?.step, { type: "fill", ref: "e4", value: "Business" });
		assert.equal(space.elements.find((element) => element.ref === "e4")?.options?.[0]?.selected, true);
	});

	it("clicks ARIA combobox suggestions instead of treating them as native options", () => {
		const autocomplete = observationFromSnapshot({
			url: "https://flights.example/",
			snapshot: [
				'RootWebArea "Flights"',
				'  combobox "From" [e1] [value="San", expanded]',
				'    option "San Francisco (SFO)" [e2]',
				'    option "San Diego (SAN)" [e3]',
			].join("\n"),
		});
		const space = buildCandidateSpace(autocomplete, "Fly from SFO");
		assert.equal(space.byOperation.has("SELECT"), false);
		assert.deepEqual(
			space.byOperation.get("CLICK")?.find((candidate) => candidate.ref === "e2")?.step,
			{ type: "click", ref: "e2" },
		);
	});

	it("keeps forward navigation after actions that do not change history", () => {
		const history: HistoryEntry[] = [
			{ step: 1, operation: "BACK", candidateId: "history:back", label: "Go back", pageChanged: true, url: "https://flights.example/first" },
			{ step: 2, operation: "WAIT", candidateId: "wait", label: "Wait", pageChanged: false, url: "https://flights.example/first" },
		];
		assert.equal(buildCandidateSpace(observation, "Continue", history).byOperation.has("FORWARD"), true);

		history.push({
			step: 3,
			operation: "CLICK",
			candidateId: "click:e1",
			label: "Open another page",
			pageChanged: true,
			url: "https://flights.example/other",
		});
		assert.equal(buildCandidateSpace(observation, "Continue", history).byOperation.has("FORWARD"), false);
	});

	it("offers literal URLs as bounded navigation targets", () => {
		const space = buildCandidateSpace(observation, "Open https://example.com/path, then continue");
		assert.deepEqual(extractLiteralUrls("Open https://example.com/path, then continue"), ["https://example.com/path"]);
		assert.equal(space.byOperation.get("NAVIGATE")?.[0]?.value, "https://example.com/path");
		assert.equal(space.byOperation.get("NAVIGATE")?.[0]?.textPurpose, undefined);
	});

	it("uses the navigation text escape hatch when the goal has no literal URL", () => {
		const space = buildCandidateSpace(observation, "Open Google Flights");
		assert.equal(space.byOperation.get("NAVIGATE")?.[0]?.id, "navigate:resolve");
		assert.equal(space.byOperation.get("NAVIGATE")?.[0]?.textPurpose, "navigation");
	});

	it("treats Chromium's new-tab page as navigation-only", () => {
		const newTab = observationFromSnapshot({
			url: "chrome://newtab/",
			snapshot: 'RootWebArea "New Tab"\n  searchbox "Search with DuckDuckGo" [e1]',
		});
		const space = buildCandidateSpace(newTab, "Open Wikipedia");
		assert.equal(space.byOperation.has("TYPE_TEXT"), false);
		assert.equal(space.byOperation.has("CLICK"), false);
		assert.equal(space.byOperation.has("BACK"), false);
		assert.deepEqual(space.elements, []);
		assert.equal(space.byOperation.get("NAVIGATE")?.[0]?.id, "navigate:resolve");
	});
});

describe("browser observation", () => {
	it("preserves field values and control state", () => {
		assert.equal(observation.title, "Flights");
		assert.equal(observation.text.includes("Choose a route"), true);
		assert.equal(observation.elements.find((element) => element.ref === "e3")?.value, "JFK");
		assert.equal(observation.elements.find((element) => element.ref === "e7")?.checked, false);
	});

	it("retries when the page changes during snapshot collection", async () => {
		let snapshotAttempts = 0;
		const executor = {
			currentUrl: async () => "https://example.com/",
			execute: async (action: BrowserAction) => {
				if (action.type === "browser_snapshot") {
					snapshotAttempts += 1;
					if (snapshotAttempts === 1) throw new ObservationChangedError();
					return [{ type: "browser_text", label: "snapshot", text: 'RootWebArea "Example"\n  link "Continue" [e1]' }];
				}
				if (action.type === "browser_evaluate") {
					return [{ type: "browser_text", label: "evaluate", text: '{"y":0,"height":800,"viewport":800,"width":1200}' }];
				}
				throw new Error(`Unexpected action ${action.type}`);
			},
		} as unknown as BrowserExecutor;

		const observed = await new ExecutorBrowserRuntime(executor).observe();
		assert.equal(snapshotAttempts, 2);
		assert.equal(observed.url, "https://example.com/");
		assert.equal(observed.elements[0]?.name, "Continue");
	});
});
