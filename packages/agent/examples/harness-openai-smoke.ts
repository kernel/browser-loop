import Kernel from "@onkernel/sdk";
import { requireCuaEnvApiKeyForModel, type CuaModelRef } from "@onkernel/cua-ai";
import { CuaAgentHarness, InMemorySessionRepo, NodeExecutionEnv } from "../src/index";
import { logAgentEvent, logAssistant } from "./shared/logging";
import { SCENARIOS } from "./shared/scenarios";
import { toolsForModel } from "./shared/tools";

const modelRef = (process.env.MODEL_REF as CuaModelRef | undefined) ?? "openai:gpt-5.6-sol";

async function main(): Promise<void> {
	const kernelApiKey = process.env.KERNEL_API_KEY;
	if (!kernelApiKey) throw new Error("KERNEL_API_KEY is required");
	requireCuaEnvApiKeyForModel(modelRef);
	const client = new Kernel({ apiKey: kernelApiKey });
	const browser = await client.browsers.create({ stealth: true });

	try {
		const sessionRepo = new InMemorySessionRepo();
		const session = await sessionRepo.create({ id: "harness-openai-smoke" });
		const harness = new CuaAgentHarness({
			browser,
			client,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			model: modelRef,
			session,
			tools: toolsForModel(modelRef),
			systemPrompt: "Use the provided computer and browser tools to interact with the page.",
		});

		harness.subscribe(logAgentEvent);

		const scenario = SCENARIOS[0]!;
		console.log(`running scenario: ${scenario.name} model=${modelRef}`);
		const response = await harness.prompt(scenario.prompt);
		const branch = await session.getBranch();
		const lastAssistant = [...branch]
			.reverse()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
			)[0];
		logAssistant(lastAssistant ?? response);
	} finally {
		await client.browsers.deleteByID(browser.session_id);
	}
}

void main();
