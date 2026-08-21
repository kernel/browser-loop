import { afterEach, describe, expect, it } from "vitest";
import {
	getLoopEnvApiKey,
	getLoopEnvApiKeyForModel,
	loopApiKeyEnvVarsForProvider,
	requireLoopEnvApiKey,
} from "../src/pi/index";

const ENV_KEYS = [
	"OPENAI_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"XAI_API_KEY",
	"MOONSHOT_API_KEY",
	"OPENROUTER_API_KEY",
] as const;

const ORIGINAL_ENV = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = ORIGINAL_ENV.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("loop api key helpers", () => {
	it("maps provider names to expected environment variables", () => {
		expect(loopApiKeyEnvVarsForProvider("openai")).toEqual(["OPENAI_API_KEY"]);
		expect(loopApiKeyEnvVarsForProvider("google")).toEqual(["GOOGLE_API_KEY", "GEMINI_API_KEY"]);
		expect(loopApiKeyEnvVarsForProvider("gemini")).toEqual(["GOOGLE_API_KEY", "GEMINI_API_KEY"]);
		expect(loopApiKeyEnvVarsForProvider("xai")).toEqual(["XAI_API_KEY"]);
		expect(loopApiKeyEnvVarsForProvider("moonshotai")).toEqual(["MOONSHOT_API_KEY"]);
		expect(loopApiKeyEnvVarsForProvider("moonshot")).toEqual(["MOONSHOT_API_KEY"]);
		expect(loopApiKeyEnvVarsForProvider("openrouter")).toEqual(["OPENROUTER_API_KEY"]);
		expect(loopApiKeyEnvVarsForProvider("unknown")).toEqual([]);
	});

	it("resolves provider api keys with fallback order", () => {
		delete process.env.GOOGLE_API_KEY;
		process.env.GEMINI_API_KEY = "gemini";
		expect(getLoopEnvApiKey("google")).toBe("gemini");
		process.env.GOOGLE_API_KEY = "google";
		expect(getLoopEnvApiKey("google")).toBe("google");
	});

	it("resolves keys from model refs", () => {
		process.env.OPENAI_API_KEY = "openai";
		expect(getLoopEnvApiKeyForModel("openai:gpt-5.5")).toBe("openai");
		process.env.XAI_API_KEY = "xai";
		expect(getLoopEnvApiKeyForModel("xai:grok-4.5")).toBe("xai");
		process.env.MOONSHOT_API_KEY = "moonshot";
		expect(getLoopEnvApiKeyForModel("moonshotai:kimi-k3")).toBe("moonshot");
		process.env.OPENROUTER_API_KEY = "openrouter";
		expect(getLoopEnvApiKeyForModel("openrouter:moonshotai/kimi-k3")).toBe("openrouter");
	});
});
