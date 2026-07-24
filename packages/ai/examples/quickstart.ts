import { readFile } from "node:fs/promises";
import {
	cuaModels,
	getCuaModel,
	requireCuaEnvApiKeyForModel,
	resolveCuaRuntimeSpec,
	type CuaModelRef,
} from "@onkernel/cua-ai";

// Switch providers by setting CUA_MODEL (and the matching API key env var):
//   anthropic:claude-opus-5          ANTHROPIC_API_KEY
//   google:gemini-3-flash-preview    GOOGLE_API_KEY
//   meta:muse-spark-1.1              META_API_KEY
//   xai:grok-4.5                     XAI_API_KEY
//   moonshotai:kimi-k3               MOONSHOT_API_KEY
//   tzafon:tzafon.northstar-cua-fast TZAFON_API_KEY
//   yutori:n1.5-latest               YUTORI_API_KEY
const modelRef = (process.env.CUA_MODEL ?? "openai:gpt-5.5") as CuaModelRef;
const model = getCuaModel(modelRef);
const apiKey = requireCuaEnvApiKeyForModel(modelRef);

// resolveCuaRuntimeSpec returns the provider's default tool definitions
// (narrowed here to click-only). For a single provider you can use its
// namespace directly, e.g. openai.computerTools({ actions: ["click"] }).
const spec = resolveCuaRuntimeSpec(modelRef, { actions: ["click"] });

const screenshot = await readFile(new URL("./screenshot.png", import.meta.url));

// The default CUA model collection: pi's builtin providers plus Kernel's
// computer-use providers, with API keys resolved from the env vars above.
// Use createCuaModels() instead for an isolated collection (e.g. with a
// custom credential store).
const models = cuaModels();

const response = await models.complete(
	model,
	{
		systemPrompt: [
			spec.defaultSystemPrompt,
			"Call the computer tool with the coordinates of the target. Do not describe the click in prose unless you cannot identify the target.",
		].filter(Boolean).join("\n"),
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "Click the sign in / up link in this Kernel homepage screenshot." },
					{ type: "image", data: screenshot.toString("base64"), mimeType: "image/png" },
				],
				timestamp: Date.now(),
			},
		],
		tools: spec.toolDefinitions,
	},
	{
		apiKey,
		maxTokens: 1024,
	},
);

// complete() resolves instead of throwing on provider errors; always check
// stopReason before reading content.
if (response.stopReason === "error" || response.stopReason === "aborted") {
	throw new Error(response.errorMessage ?? `request ended with stopReason "${response.stopReason}"`);
}

console.log(`model: ${modelRef}`);
for (const block of response.content) {
	if (block.type === "text") {
		console.log(block.text);
	}
	if (block.type === "toolCall") {
		console.log(`${block.name}: ${JSON.stringify(block.arguments)}`);
	}
}
