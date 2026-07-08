// Smoke-test the mode/native-tool matrix against a live Kernel browser:
//
//   MODEL_REF=anthropic:claude-opus-4-8 CONFIG=native-browser tsx examples/anthropic-native-smoke.ts
//
// CONFIG selects the runtime shape:
//   computer (default)  canonical computer-plane (OS input) tools
//   browser             canonical browser-plane (CDP page) tools
//   hybrid              both planes, deduplicated
//   native-computer     Anthropic computer_20260601 (requires the computer-use beta)
//   native-browser      Anthropic browser_20260701 (requires the browser-use beta)
import Kernel from "@onkernel/sdk";
import { requireCuaEnvApiKeyForModel, type CuaModelRef, type CuaMode, type CuaNativeToolSpec } from "@onkernel/cua-ai";
import { CuaAgent } from "../src/index";
import { logAgentEvent, logAssistant } from "./shared/logging";

const modelRef = (process.env.MODEL_REF as CuaModelRef | undefined) ?? "anthropic:claude-opus-4-8";
const config = process.env.CONFIG ?? "computer";

const CONFIGS: Record<string, { mode?: CuaMode; nativeTool?: CuaNativeToolSpec }> = {
	computer: { mode: "computer" },
	browser: { mode: "browser" },
	hybrid: { mode: "hybrid" },
	"native-computer": { nativeTool: { type: "computer_20260601", enable_zoom: true } },
	"native-browser": { nativeTool: { type: "browser_20260701" } },
};

const PROMPT = [
	"Navigate to https://example.com, read the page, and tell me:",
	"1) the main heading text",
	"2) the text of the link on the page",
	"Then follow that link and tell me the title of the page you land on.",
].join("\n");

async function main(): Promise<void> {
	const runtime = CONFIGS[config];
	if (!runtime) throw new Error(`unknown CONFIG "${config}" (expected: ${Object.keys(CONFIGS).join(" | ")})`);
	const kernelApiKey = process.env.KERNEL_API_KEY;
	if (!kernelApiKey) throw new Error("KERNEL_API_KEY is required");
	requireCuaEnvApiKeyForModel(modelRef);
	const client = new Kernel({ apiKey: kernelApiKey });
	const browser = await client.browsers.create({ stealth: true });

	try {
		const agent = new CuaAgent({
			browser,
			client,
			...runtime,
			initialState: { model: modelRef },
		});
		agent.subscribe(logAgentEvent);

		console.log(`running config=${config} model=${modelRef} live_view=${browser.browser_live_view_url}`);
		await agent.prompt(PROMPT);
		const assistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
		logAssistant(assistant?.role === "assistant" ? assistant : undefined);
	} finally {
		await client.browsers.deleteByID(browser.session_id);
	}
}

void main();
