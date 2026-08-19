import Kernel from "@onkernel/sdk";
import { Agent } from "@earendil-works/pi-agent-core";
import { attach, requireLoopEnvApiKeyForModel } from "../src/pi/index";
import { logAgentEvent, logAssistant } from "./shared/logging";
import { parseExampleOptions } from "./shared/options";
import { toolsForModel } from "./shared/tools";

async function main(): Promise<void> {
	const { modelRef, scenario } = parseExampleOptions();
	const kernelApiKey = process.env.KERNEL_API_KEY;
	if (!kernelApiKey) throw new Error("KERNEL_API_KEY is required");
	requireLoopEnvApiKeyForModel(modelRef);
	const client = new Kernel({ apiKey: kernelApiKey });
	const browser = await client.browsers.create({ stealth: true });
	const kb = attach({ browser, client });

	try {
		const compiled = kb.compile({ model: modelRef, tools: toolsForModel(modelRef) });
		const agent = new Agent({
			streamFn: (selected, context, options) => compiled.models.streamSimple(selected, context, options),
			initialState: {
				model: compiled.model,
				tools: [...compiled.agentTools],
				systemPrompt: "Use the provided computer and browser tools to interact with the page.",
			},
		});
		agent.subscribe(logAgentEvent);

		console.log(`model=${modelRef} scenario=${scenario.name}`);
		await agent.prompt(scenario.prompt);
		const assistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
		logAssistant(assistant?.role === "assistant" ? assistant : undefined);
	} finally {
		await kb.dispose();
		await client.browsers.deleteByID(browser.session_id);
	}
}

void main();
