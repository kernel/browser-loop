import Kernel from "@onkernel/sdk";
import {
	requireCuaEnvApiKeyForModel,
	type CuaModelRef,
} from "@onkernel/cua-ai";
import { CuaAgent } from "../src/index";
import { logAgentEvent, logAssistant } from "./shared/logging";
import { SCENARIOS } from "./shared/scenarios";
import { toolsForModel } from "./shared/tools";

const modelRef = (process.env.MODEL_REF as CuaModelRef | undefined) ?? "openai:gpt-5.6-sol";
const scenarioName = process.env.SCENARIO ?? SCENARIOS[0]!.name;

async function main(): Promise<void> {
	const kernelApiKey = process.env.KERNEL_API_KEY;
	if (!kernelApiKey) throw new Error("KERNEL_API_KEY is required");
	requireCuaEnvApiKeyForModel(modelRef);
	const client = new Kernel({ apiKey: kernelApiKey });
	const browser = await client.browsers.create({ stealth: true });
	const scenario = SCENARIOS.find((entry) => entry.name === scenarioName) ?? SCENARIOS[0]!;

	try {
		const agent = new CuaAgent({
			browser,
			client,
			tools: toolsForModel(modelRef),
			initialState: { model: modelRef, systemPrompt: "Use the provided computer and browser tools to interact with the page." },
		});
		agent.subscribe(logAgentEvent);
		console.log(`model=${modelRef} scenario=${scenario.name}`);
		await agent.prompt(scenario.prompt);
		const assistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
		logAssistant(assistant?.role === "assistant" ? assistant : undefined);
	} finally {
		await client.browsers.deleteByID(browser.session_id);
	}
}

void main();
