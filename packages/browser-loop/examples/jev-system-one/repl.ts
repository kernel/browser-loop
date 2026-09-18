import { BrowserExecutor } from "../../src/core/translator/browser";
import { runAgent } from "./agent";
import { ExecutorBrowserRuntime } from "./browser";
import { SystemOneJevPolicy } from "./models";
import { OpenAICompatibleTextResolver } from "./text";
import type { AgentResult } from "./types";

export interface CreateJevAgentOptions {
	maxSteps?: number;
}

export interface JevAgent {
	(goal: string): Promise<AgentResult>;
	close(): void;
}

export function createJevAgent(options: CreateJevAgentOptions = {}): JevAgent {
	const cdpEndpoint = process.env.CDP_ENDPOINT;
	if (!cdpEndpoint) throw new Error("CDP_ENDPOINT is required");

	const executor = new BrowserExecutor(cdpEndpoint);
	const browser = new ExecutorBrowserRuntime(executor);
	const policy = new SystemOneJevPolicy();
	const textResolver = process.env.TEXT_MODEL_API_KEY ? new OpenAICompatibleTextResolver() : undefined;
	const run = (goal: string) => runAgent({
		goal,
		browser,
		policy,
		...(textResolver ? { textResolver } : {}),
		...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
	});
	return Object.assign(run, { close: () => executor.close() });
}
