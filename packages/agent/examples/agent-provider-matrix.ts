import Kernel from "@onkernel/sdk";
import {
	cua,
	parseCuaModelRef,
	requireCuaEnvApiKeyForModel,
	type CuaAgentTool,
	type CuaModelRef,
} from "@onkernel/cua-ai";
import { CuaAgent } from "../src/index";
import { logAgentEvent, logAssistant } from "./shared/logging";
import { SCENARIOS } from "./shared/scenarios";

const modelRef = (process.env.MODEL_REF as CuaModelRef | undefined) ?? "openai:gpt-5.6-sol";
const scenarioName = process.env.SCENARIO ?? SCENARIOS[0]!.name;

function structuredBrowserTools(): CuaAgentTool[] {
	return [...cua.toolsets.browser(), cua.tools.browser.act()];
}

function toolsForModel(model: CuaModelRef): CuaAgentTool[] {
	const { provider, model: modelId } = parseCuaModelRef(model);
	switch (provider) {
		case "openai":
			// Favor refs, semantic reads, and verified plans over coordinate-only computer use.
			return structuredBrowserTools();
		case "anthropic":
			// Claude 5 can use Anthropic's native browser tool; older models use portable
			// CUA tools plus the explicit semantic action-plan surface.
			return cua.providers.anthropic.supports.browser(modelId)
				? [cua.providers.anthropic.tools.browser({ version: "20260701", javascript: true })]
				: structuredBrowserTools();
		case "google":
			// Current Gemini computer-use models expect Google's predefined browser actions.
			return cua.providers.google.toolsets.browser();
		case "meta":
		case "xai":
		case "moonshotai":
			// No first-party native browser surface exists, so use CUA browser primitives
			// plus verified dependent plans.
			return structuredBrowserTools();
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
