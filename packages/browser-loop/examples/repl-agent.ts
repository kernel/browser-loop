import { Agent } from "@earendil-works/pi-agent-core";
import Kernel from "@onkernel/sdk";
import { loop } from "../src/index";
import { attach } from "../src/pi/index";

const client = new Kernel({ apiKey: process.env.KERNEL_API_KEY! });
const browser = await client.browsers.create({ stealth: true, timeout_seconds: 600 });
const handle = attach({ client, browser });
const compiled = handle.compile({
	model: "anthropic:claude-opus-5",
	tools: [loop.tools.repl()],
});
const agent = new Agent({
	streamFn: (model, context, options) => compiled.models.streamSimple(model, context, options),
	initialState: {
		model: compiled.model,
		tools: [...compiled.agentTools],
		systemPrompt: "Use browser_repl. Persist useful JavaScript helpers between calls and emit answers with repl.write().",
	},
});

try {
	await agent.prompt("Open example.com, save a helper that reads the page title, then call it and report the title.");
} finally {
	await handle.dispose();
	await client.browsers.deleteByID(browser.session_id);
}
