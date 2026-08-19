import type { LoopModelRef } from "../../src/pi/index";
import { SCENARIOS, type BrowserScenario } from "./scenarios";

export interface ExampleOptions {
	modelRef: LoopModelRef;
	scenario: BrowserScenario;
}

export function parseExampleOptions(argv = process.argv.slice(2)): ExampleOptions {
	let modelRef = (process.env.MODEL_REF as LoopModelRef | undefined) ?? "openai:gpt-5.6-sol";
	let scenarioName = process.env.SCENARIO ?? SCENARIOS[0]!.name;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const value = argv[index + 1];
		if (arg === "--model" && value) {
			modelRef = value as LoopModelRef;
			index += 1;
		} else if (arg === "--scenario" && value) {
			scenarioName = value;
			index += 1;
		} else {
			throw new Error(`Unknown or incomplete option: ${arg}`);
		}
	}

	const scenario = SCENARIOS.find((entry) => entry.name === scenarioName);
	if (!scenario) {
		const available = SCENARIOS.map((entry) => entry.name).join(", ");
		throw new Error(`Unknown scenario ${JSON.stringify(scenarioName)}. Choose one of: ${available}`);
	}
	return { modelRef, scenario };
}
