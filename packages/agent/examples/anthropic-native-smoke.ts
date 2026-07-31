// Smoke-test explicit Anthropic tool compositions against a live Kernel browser:
//
//   MODEL_REF=anthropic:claude-opus-5 CONFIG=native-browser tsx examples/anthropic-native-smoke.ts
//
// CONFIG selects the requested catalog; CuaAgent never infers or appends tools.
import Kernel from "@onkernel/sdk";
import { cua, requireCuaEnvApiKeyForModel, type CuaModelRef } from "@onkernel/cua-ai";
import { CuaAgent, type CuaAgentTool } from "../src/index";
import { logAgentEvent, logAssistant } from "./shared/logging";

const modelRef = (process.env.MODEL_REF as CuaModelRef | undefined) ?? "anthropic:claude-opus-5";
const config = process.env.CONFIG ?? "computer";

const CONFIGS: Record<string, readonly CuaAgentTool[]> = {
	computer: cua.toolsets.computer(),
	browser: cua.toolsets.browser(),
	mixed: cua.toolsets.mixed(),
	"native-computer": [cua.providers.anthropic.tools.computer({ version: "20260701", enableZoom: true })],
	"native-browser": [cua.providers.anthropic.tools.browser({ version: "20260701" })],
};

const PROMPT = [
	"Navigate to https://example.com, read the page, and tell me:",
	"1) the main heading text",
	"2) the text of the link on the page",
	"Then follow that link and tell me the title of the page you land on.",
].join("\n");

async function main(): Promise<void> {
	const tools = CONFIGS[config];
	if (!tools) throw new Error(`unknown CONFIG "${config}" (expected: ${Object.keys(CONFIGS).join(" | ")})`);
	const kernelApiKey = process.env.KERNEL_API_KEY;
	if (!kernelApiKey) throw new Error("KERNEL_API_KEY is required");
	requireCuaEnvApiKeyForModel(modelRef);
	const client = new Kernel({ apiKey: kernelApiKey });
	const browser = await client.browsers.create({ stealth: true });

	try {
		const agent = new CuaAgent({
			browser,
			client,
			tools,
			initialState: {
				model: modelRef,
				systemPrompt: "Use only the requested tools to interact with the browser.",
			},
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
