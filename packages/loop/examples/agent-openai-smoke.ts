import Kernel from "@onkernel/sdk";
import { loop } from "../src/index";
import { Agent, attach, type LoopModelRef, requireLoopEnvApiKeyForModel } from "../src/pi/index";
import { logAgentEvent, logAssistant } from "./shared/logging";
import { SCENARIOS } from "./shared/scenarios";

const modelRef = (process.env.MODEL_REF as LoopModelRef | undefined) ?? "openai:gpt-5.6-sol";

async function main(): Promise<void> {
	const kernelApiKey = process.env.KERNEL_API_KEY;
	if (!kernelApiKey) throw new Error("KERNEL_API_KEY is required");
	requireLoopEnvApiKeyForModel(modelRef);
	const client = new Kernel({ apiKey: kernelApiKey });
	const browser = await client.browsers.create({ stealth: true });
	const kb = attach({ browser, client });

	try {
		// Prefer structured browser refs and semantic reads for the OpenAI smoke,
		// and opt into verified dependent plans without changing the base toolset.
		const compiled = kb.compile({
			model: modelRef,
			tools: [...loop.toolsets.browser(), loop.tools.browser.act()],
		});
		const agent = new Agent({
			streamFn: (selected, context, options) => compiled.models.streamSimple(selected, context, options),
			initialState: {
				model: compiled.model,
				tools: [...compiled.agentTools],
				systemPrompt: "Use the provided computer and browser tools to interact with the page.",
			},
		});

		agent.subscribe(logAgentEvent);

		const scenario = SCENARIOS[0]!;
		console.log(`running scenario: ${scenario.name} model=${modelRef}`);
		await agent.prompt(scenario.prompt);
		const assistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
		logAssistant(assistant?.role === "assistant" ? assistant : undefined);
	} finally {
		await kb.dispose();
		await client.browsers.deleteByID(browser.session_id);
	}
}

void main();
