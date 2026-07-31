import { readFile } from "node:fs/promises";
import {
	compileCuaToolCatalog,
	cua,
	cuaModels,
	requireCuaEnvApiKeyForModel,
	type CuaModelRef,
} from "@onkernel/cua-ai";

// Switch providers by setting CUA_MODEL and the matching provider API key.
const modelRef = (process.env.CUA_MODEL ?? "openai:gpt-5.6-sol") as CuaModelRef;
const apiKey = requireCuaEnvApiKeyForModel(modelRef);
const screenshot = await readFile(new URL("./screenshot.png", import.meta.url));

// The caller requests the exact catalog. Nothing is inferred or appended.
// Compilation is declaration-only: cua-ai has no pi-agent-core dependency and
// never constructs executable tools. `@onkernel/cua-agent` materializes specs
// against a live Kernel browser when execution is needed.
const catalog = compileCuaToolCatalog({
	model: modelRef,
	requestedTools: [cua.tools.computer.click()],
	viewport: { width: 1440, height: 900 },
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
		tools: [...catalog.toolDeclarations],
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
