import Kernel from "@onkernel/sdk";
import {
	cua,
	parseCuaModelRef,
	requireCuaEnvApiKeyForModel,
	type CuaAgentTool,
	type CuaModelRef,
} from "@onkernel/cua-ai";
import { CuaAgentHarness, InMemorySessionRepo, NodeExecutionEnv } from "../src/index";
import { logAgentEvent, logAssistant } from "./shared/logging";
import { SCENARIOS } from "./shared/scenarios";

const modelRef = (process.env.MODEL_REF as CuaModelRef | undefined) ?? "openai:gpt-5.6-sol";
const scenarioName = process.env.SCENARIO ?? SCENARIOS[0]!.name;

function toolsForModel(model: CuaModelRef): CuaAgentTool[] {
	const { provider, model: modelId } = parseCuaModelRef(model);
	switch (provider) {
		case "openai":
			// This example favors refs and semantic reads over coordinate-only computer use.
			return cua.toolsets.browser();
		case "anthropic":
			// Claude 5 can use Anthropic's native browser tool; older models use portable CUA tools.
			return cua.providers.anthropic.supports.browser(modelId)
				? [cua.providers.anthropic.tools.browser({ version: "20260701", javascript: true })]
				: cua.toolsets.browser();
		case "google":
			// Current Gemini computer-use models expect Google's predefined browser actions.
			return cua.providers.google.toolsets.browser();
		case "meta":
		case "xai":
		case "moonshotai":
			// These providers have no first-party native browser surface in the catalog.
			return cua.toolsets.browser();
		case "tzafon":
			// Northstar's documented native computer schema is its supported interaction contract.
			return [cua.providers.tzafon.tools.computer()];
		case "yutori":
			// Match Yutori's documented model generation and add explicit visual access.
			return [
				...(modelId.startsWith("n1.5")
					? cua.providers.yutori.toolsets.n15Core()
					: cua.providers.yutori.toolsets.n1()),
				cua.tools.computer.screenshot(),
			];
	}
}

async function main(): Promise<void> {
	const kernelApiKey = process.env.KERNEL_API_KEY;
	if (!kernelApiKey) throw new Error("KERNEL_API_KEY is required");
	requireCuaEnvApiKeyForModel(modelRef);
	const client = new Kernel({ apiKey: kernelApiKey });
	const browser = await client.browsers.create({ stealth: true });
	const scenario = SCENARIOS.find((entry) => entry.name === scenarioName) ?? SCENARIOS[0]!;

	try {
		const sessionRepo = new InMemorySessionRepo();
		const session = await sessionRepo.create({ id: `harness-provider-matrix-${scenario.name}` });
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
		await client.browsers.deleteByID(browser.session_id);
	}
}

void main();
