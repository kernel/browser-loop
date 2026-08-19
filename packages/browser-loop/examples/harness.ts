import Kernel from "@onkernel/sdk";
import { AgentHarness, InMemorySessionRepo } from "@earendil-works/pi-agent-core";
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
		const session = await new InMemorySessionRepo().create({ id: `harness-${scenario.name}` });
		const compiled = kb.compile({ model: modelRef, tools: toolsForModel(modelRef) });
		const harness = new AgentHarness({
			session,
			model: compiled.model,
			models: compiled.models,
			tools: [...compiled.tools],
			activeToolNames: compiled.tools.map((tool) => tool.name),
			systemPrompt: "Use the provided computer and browser tools to interact with the page.",
		});
		compiled.activate(harness);
		harness.subscribe(logAgentEvent);

		console.log(`model=${modelRef} scenario=${scenario.name}`);
		const response = await harness.prompt(scenario.prompt);
		const branch = await session.getBranch();
		const lastAssistant = [...branch]
			.reverse()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
			)[0];
		logAssistant(lastAssistant ?? response);
	} finally {
		await kb.dispose();
		await client.browsers.deleteByID(browser.session_id);
	}
}

void main();
