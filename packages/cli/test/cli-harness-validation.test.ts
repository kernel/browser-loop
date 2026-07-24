import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HarnessCliFlags, runActionCommand } from "../src/cli-harness";
import { provisionBrowser } from "../src/harness-browser";

vi.mock("../src/harness-browser", () => ({ provisionBrowser: vi.fn() }));

function flagsWith(overrides: Partial<HarnessCliFlags>): HarnessCliFlags {
	return {
		verbose: false,
		profileSaveChanges: false,
		continueLatest: false,
		resumePicker: false,
		noSession: true,
		noSkills: true,
		debugTui: false,
		jsonlIncludeDeltas: false,
		jsonlIncludeImages: false,
		playwright: false,
		skillPaths: [],
		...overrides,
	};
}

describe("mode/native-tool validation before provisioning", () => {
	beforeEach(() => {
		vi.stubEnv("KERNEL_API_KEY", "test-kernel-key");
		vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
		vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
		vi.stubEnv("GOOGLE_API_KEY", "test-google-key");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.mocked(provisionBrowser).mockClear();
	});

	it("rejects a native tool whose mode conflicts without provisioning a browser", async () => {
		await expect(
			runActionCommand("url", [], flagsWith({
				model: "anthropic:claude-opus-4-8",
				mode: "hybrid",
				nativeTool: "computer_20260701",
			})),
		).rejects.toThrow('native tool "computer_20260701" requires mode "computer"; got "hybrid"');
		expect(provisionBrowser).not.toHaveBeenCalled();
	});

	it("rejects a native tool on a non-anthropic model without provisioning a browser", async () => {
		await expect(
			runActionCommand("url", [], flagsWith({
				model: "openai:gpt-5.5",
				nativeTool: "computer_20260701",
			})),
		).rejects.toThrow('native tool "computer_20260701" requires an anthropic model paired with mode "computer"; got provider "openai"');
		expect(provisionBrowser).not.toHaveBeenCalled();
	});

	it("rejects an ineligible Anthropic model without provisioning a browser", async () => {
		await expect(
			runActionCommand("url", [], flagsWith({
				model: "anthropic:claude-opus-4-7",
				nativeTool: "browser_20260701",
			})),
		).rejects.toThrow(
			'native tool "browser_20260701" is an allowlisted Anthropic API beta and does not support model "claude-opus-4-7"',
		);
		expect(provisionBrowser).not.toHaveBeenCalled();
	});

	it("rejects an unsupported provider/mode pair without provisioning a browser", async () => {
		await expect(
			runActionCommand("url", [], flagsWith({
				model: "google:gemini-3-flash-preview",
				mode: "browser",
			})),
		).rejects.toThrow('provider "google" does not support mode "browser" (computer only)');
		expect(provisionBrowser).not.toHaveBeenCalled();
	});
});
