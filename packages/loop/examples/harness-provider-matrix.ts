import Kernel from "@onkernel/sdk";
import {
	AgentHarness,
	attach,
	InMemorySessionRepo,
	type LoopModelRef,
	requireLoopEnvApiKeyForModel,
} from "../src/pi/index";
import { logAgentEvent, logAssistant } from "./shared/logging";
import { SCENARIOS } from "./shared/scenarios";
import { toolsForModel } from "./shared/tools";

const modelRef = (process.env.MODEL_REF as LoopModelRef | undefined) ?? "openai:gpt-5.6-sol";
const scenarioName = process.env.SCENARIO ?? SCENARIOS[0]!.name;

async function main(): Promise<void> {
	const kernelApiKey = process.env.KERNEL_API_KEY;
	if (!kernelApiKey) throw new Error("KERNEL_API_KEY is required");
	requireLoopEnvApiKeyForModel(modelRef);
	const client = new Kernel({ apiKey: kernelApiKey });
	const browser = await client.browsers.create({ stealth: true });
	const scenario = SCENARIOS.find((entry) => entry.name === scenarioName) ?? SCENARIOS[0]!;
	const kb = attach({ browser, client });

	try {
		const sessionRepo = new InMemorySessionRepo();
		const session = await sessionRepo.create({ id: `harness-provider-matrix-${scenario.name}` });
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
