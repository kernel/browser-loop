import Kernel from "@onkernel/sdk";
import { cua, requireCuaEnvApiKeyForModel, type CuaModelRef } from "@onkernel/cua-ai";
import { CuaAgent } from "../src/index";
import { logAgentEvent, logAssistant } from "./shared/logging";
import { SCENARIOS } from "./shared/scenarios";

const modelRef = (process.env.MODEL_REF as CuaModelRef | undefined) ?? "openai:gpt-5.6-sol";

async function main(): Promise<void> {
	const kernelApiKey = process.env.KERNEL_API_KEY;
	if (!kernelApiKey) throw new Error("KERNEL_API_KEY is required");
	requireCuaEnvApiKeyForModel(modelRef);
	const client = new Kernel({ apiKey: kernelApiKey });
	const browser = await client.browsers.create({ stealth: true });

	try {
		const agent = new CuaAgent({
			browser,
			client,
			// Prefer structured browser refs and semantic reads for the OpenAI smoke
			// instead of making coordinate-only computer use the application default.
			tools: cua.toolsets.browser(),
			initialState: { model: modelRef, systemPrompt: "Use the provided computer and browser tools to interact with the page." },
		});

		agent.subscribe(logAgentEvent);

		const scenario = SCENARIOS[0]!;
		console.log(`running scenario: ${scenario.name} model=${modelRef}`);
		await agent.prompt(scenario.prompt);
		const assistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
		logAssistant(assistant?.role === "assistant" ? assistant : undefined);
	} finally {
		await client.browsers.deleteByID(browser.session_id);
	}
}

void main();
