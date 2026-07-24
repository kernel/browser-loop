import { describe, expect, it } from "vitest";
import { isExpectedFrameCollectionError } from "../src/translator/browser-frame-collection";
import { CdpProtocolError } from "../src/translator/cdp";

// The allow-list is the sole boundary between a transiently-inaccessible frame
// (retried, then omitted) and a hard, loud FrameCollectionError. Pin every
// accepted protocol string per method so a future edit can't silently tighten
// (dropping a variant would start staling live frames) or loosen it (swallowing
// a genuine protocol bug as "incomplete frame"). Fencing behavior is unchanged
// by this suite — it only documents the accepted set.
describe("isExpectedFrameCollectionError allow-list", () => {
	const cases: Array<[string, "DOM.describeNode" | "Accessibility.getFullAXTree", boolean]> = [
		["Could not find node with given id", "DOM.describeNode", true],
		["No node with given id found", "DOM.describeNode", true],
		["No node with given id found.", "DOM.describeNode", true],
		["Frame with the given id was not found", "Accessibility.getFullAXTree", true],
		["Frame with the given id was not found.", "Accessibility.getFullAXTree", true],
		["No frame for given id found", "Accessibility.getFullAXTree", true],
		["Session with given id not found", "Accessibility.getFullAXTree", true],
		["Target session terminated", "Accessibility.getFullAXTree", true],
		// A -32000 error whose message is not on the allow-list must stay unexpected
		// so it propagates as a FrameCollectionError instead of being swallowed.
		["Some other protocol failure", "Accessibility.getFullAXTree", false],
	];

	it.each(cases)("classifies %j on %s as expected=%s", (message, method, expected) => {
		const error = new CdpProtocolError(method, -32000, message);
		expect(isExpectedFrameCollectionError(error, method)).toBe(expected);
	});

	it("does not accept an allow-listed message reported for a different method", () => {
		const describeMessage = new CdpProtocolError("Accessibility.getFullAXTree", -32000, "Could not find node with given id");
		expect(isExpectedFrameCollectionError(describeMessage, "Accessibility.getFullAXTree")).toBe(false);

		const axMessage = new CdpProtocolError("DOM.describeNode", -32000, "Frame with the given id was not found");
		expect(isExpectedFrameCollectionError(axMessage, "DOM.describeNode")).toBe(false);
	});

	it("does not accept a plain Error even when its message is on the allow-list", () => {
		expect(isExpectedFrameCollectionError(new Error("No node with given id found"), "DOM.describeNode")).toBe(false);
	});
});
