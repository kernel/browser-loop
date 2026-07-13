import { afterEach, describe, expect, it } from "vitest";
import {
	cuaApiKeyEnvVarsForProvider,
	getCuaEnvApiKey,
	getCuaEnvApiKeyForModel,
	requireCuaEnvApiKey,
} from "../src/index";

const ENV_KEYS = [
	"OPENAI_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"META_API_KEY",
	"XAI_API_KEY",
	"TZAFON_API_KEY",
	"YUTORI_API_KEY",
] as const;

const ORIGINAL_ENV = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = ORIGINAL_ENV.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("cua api key helpers", () => {
	it("maps provider names to expected environment variables", () => {
		expect(cuaApiKeyEnvVarsForProvider("openai")).toEqual(["OPENAI_API_KEY"]);
		expect(cuaApiKeyEnvVarsForProvider("google")).toEqual(["GOOGLE_API_KEY", "GEMINI_API_KEY"]);
		expect(cuaApiKeyEnvVarsForProvider("gemini")).toEqual(["GOOGLE_API_KEY", "GEMINI_API_KEY"]);
		expect(cuaApiKeyEnvVarsForProvider("meta")).toEqual(["META_API_KEY"]);
		expect(cuaApiKeyEnvVarsForProvider("xai")).toEqual(["XAI_API_KEY"]);
		expect(cuaApiKeyEnvVarsForProvider("unknown")).toEqual([]);
	});

	it("resolves provider api keys with fallback order", () => {
		delete process.env.GOOGLE_API_KEY;
		process.env.GEMINI_API_KEY = "gemini";
		expect(getCuaEnvApiKey("google")).toBe("gemini");
		process.env.GOOGLE_API_KEY = "google";
		expect(getCuaEnvApiKey("google")).toBe("google");
	});

	it("resolves keys from model refs", () => {
		process.env.OPENAI_API_KEY = "openai";
		expect(getCuaEnvApiKeyForModel("openai:gpt-5.5")).toBe("openai");
		process.env.META_API_KEY = "meta";
		expect(getCuaEnvApiKeyForModel("meta:muse-spark-1.1")).toBe("meta");
		process.env.XAI_API_KEY = "xai";
		expect(getCuaEnvApiKeyForModel("xai:grok-4.5")).toBe("xai");
	});

	it("throws readable errors when missing", () => {
		delete process.env.TZAFON_API_KEY;
		expect(() => requireCuaEnvApiKey("tzafon")).toThrow("TZAFON_API_KEY");
	});
});
