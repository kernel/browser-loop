import { describe, expect, it } from "vitest";
import { compileCuaToolCatalog, cuaToolMenu, getCuaModel, type CuaModelRef } from "../src/index";

// One with a native browser surface, one with a native computer surface, one
// with neither, one carrying a quirk, and one synthesized from an id pi-ai's
// registry does not carry.
const MODELS: CuaModelRef[] = [
	"google:gemini-3.6-flash",
	"openai:gpt-5.5",
	"anthropic:claude-opus-5",
	"moonshotai:kimi-k3",
	"xai:grok-4.6",
];

describe("cuaToolMenu", () => {
	it("marks an entry available exactly when selecting it compiles", () => {
		for (const ref of MODELS) {
			const model = getCuaModel(ref);
			for (const entry of cuaToolMenu(ref)) {
				let compiles = true;
				try {
					compileCuaToolCatalog({ model, requestedTools: entry.tools });
				} catch {
					compiles = false;
				}
				expect(entry.available, `${ref} / ${entry.label}`).toBe(compiles);
			}
		}
	});

	it("quotes the compiler's own message as the reason", () => {
		const act = cuaToolMenu("moonshotai:kimi-k3").find((entry) => entry.label === "browser_act");
		expect(act?.available).toBe(false);
		expect(act?.unavailableReason).toContain("does not accept the schema size");

		const waitFor = cuaToolMenu("google:gemini-3.6-flash").find((entry) => entry.label === "browser_wait_for");
		expect(waitFor?.available).toBe(false);
		expect(waitFor?.unavailableReason).toContain("does not accept the schema");
	});

	it("offers a model's own native surfaces and no other provider's", () => {
		const nativeFor = (ref: CuaModelRef) =>
			cuaToolMenu(ref).filter((entry) => entry.group === "native" && entry.available).map((entry) => entry.label);

		// Anthropic's surfaces are version-gated outside CUA_NATIVE_SURFACES, so a
		// menu reading that table directly would report these unavailable.
		expect(nativeFor("anthropic:claude-opus-5")).toEqual(["computer", "browser"]);
		expect(nativeFor("openai:gpt-5.5")).toEqual(["computer"]);
		expect(nativeFor("google:gemini-3.6-flash")).toEqual(["google native browser"]);
		expect(nativeFor("moonshotai:kimi-k3")).toEqual([]);
	});

	it("re-evaluates against the current selection, because some rules are pairwise", () => {
		const google = cuaToolMenu("google:gemini-3.6-flash");
		const nativeBrowser = google.find((entry) => entry.key === "group:google.native.browser")!;
		expect(nativeBrowser.available).toBe(true);
		expect(nativeBrowser.selected).toBe(false);

		// Selecting Google's native set pins the transport, so a CUA browser tool
		// that compiles on its own no longer does beside it.
		const withNative = cuaToolMenu("google:gemini-3.6-flash", nativeBrowser.tools);
		expect(withNative.find((entry) => entry.key === "group:google.native.browser")?.selected).toBe(true);
		const snapshot = withNative.find((entry) => entry.label === "browser_snapshot")!;
		const snapshotAlone = google.find((entry) => entry.label === "browser_snapshot")!;
		expect(snapshotAlone.available).toBe(true);
		expect(snapshot.available).toBe(true);
	});

	it("reports what is already selected", () => {
		const menu = cuaToolMenu("openai:gpt-5.5");
		const snapshot = menu.find((entry) => entry.label === "browser_snapshot")!;
		const withSnapshot = cuaToolMenu("openai:gpt-5.5", snapshot.tools);
		expect(withSnapshot.find((entry) => entry.label === "browser_snapshot")?.selected).toBe(true);
		expect(withSnapshot.filter((entry) => entry.selected)).toHaveLength(1);
	});

	it("covers the whole offerable surface, grouped", () => {
		const menu = cuaToolMenu("openai:gpt-5.5");
		const groups = new Set(menu.map((entry) => entry.group));
		expect(groups).toEqual(new Set(["browser", "computer", "playwright", "native"]));
		expect(menu.some((entry) => entry.label === "playwright_execute")).toBe(true);
		expect(menu.some((entry) => entry.label === "browser_act")).toBe(true);
		expect(menu.every((entry) => entry.tools.length > 0)).toBe(true);
	});
});
