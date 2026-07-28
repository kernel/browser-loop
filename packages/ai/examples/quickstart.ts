import { readFile } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	compileCuaToolCatalog,
	cua,
	cuaModels,
	requireCuaEnvApiKeyForModel,
	type CuaModelRef,
	type CuaToolSpec,
} from "@onkernel/cua-ai";

// Switch providers by setting CUA_MODEL and the matching provider API key.
const modelRef = (process.env.CUA_MODEL ?? "openai:gpt-5.6-sol") as CuaModelRef;
const apiKey = requireCuaEnvApiKeyForModel(modelRef);
const screenshot = await readFile(new URL("./screenshot.png", import.meta.url));

// The caller requests the exact catalog. Nothing is inferred or appended.
const catalog = compileCuaToolCatalog({
	model: modelRef,
	requestedTools: [cua.tools.computer.click()],
	resources: {
		viewport: { width: 1440, height: 900 },
		materialize(spec: CuaToolSpec): AgentTool {
			return {
				...spec.declaration,
				label: spec.name,
				executionMode: "sequential",
				async execute() {
					throw new Error("This catalog-only example does not execute the returned click.");
				},
			};
		},
		async osScreenshot() {
			return { data: screenshot, mimeType: "image/png" };
		},
	},
});

const response = await cuaModels().complete(
	catalog.model,
	{
		systemPrompt: "Call computer_click with the target coordinates. Do not describe the click in prose.",
		messages: [{
			role: "user",
			content: [
				{ type: "text", text: "Click the sign in / up link in this Kernel homepage screenshot." },
				{ type: "image", data: screenshot.toString("base64"), mimeType: "image/png" },
			],
			timestamp: Date.now(),
		}],
		tools: [...catalog.agentTools],
	},
	{
		apiKey,
		maxTokens: 1024,
		headers: catalog.headers.merge(),
		onPayload: (payload) => catalog.payload.apply(payload, catalog.model),
	},
);

if (response.stopReason === "error" || response.stopReason === "aborted") {
	throw new Error(response.errorMessage ?? `request ended with stopReason "${response.stopReason}"`);
}

console.log(`model: ${modelRef}`);
for (const block of response.content) {
	if (block.type === "text") console.log(block.text);
	if (block.type === "toolCall") console.log(`${block.name}: ${JSON.stringify(block.arguments)}`);
}
