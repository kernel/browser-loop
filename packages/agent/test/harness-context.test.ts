import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createAssistantMessageEventStream,
	createCuaModels,
	type AssistantMessage,
	type Model,
} from "@onkernel/cua-ai";
import type Kernel from "@onkernel/sdk";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	AgentHarness,
	attach,
	InMemorySessionRepo,
	NodeExecutionEnv,
	type AgentHarnessTool,
	type ExecutionToolContext,
	type KernelBrowser,
	type StreamFn,
} from "../src/index";

const browser = { session_id: "browser_123", viewport: { width: 1440, height: 900 } } as KernelBrowser;
const client = {} as Kernel;

function assistant(model: Model<string>, content: AssistantMessage["content"] = [], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function scriptedStream(turns: Array<(model: Model<string>) => AssistantMessage>): StreamFn {
	let call = 0;
	return (model) => {
		const stream = createAssistantMessageEventStream();
		const message = turns[call++]?.(model) ?? assistant(model);
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
		stream.end(message);
		return stream;
	};
}

function modelsFromStream(streamFn: StreamFn, provider = "openai") {
	const models = createCuaModels();
	models.setProvider({
		id: provider,
		name: "scripted",
		auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "test" } }) } },
		getModels: () => [],
		stream: streamFn,
		streamSimple: streamFn,
	} as never);
	return models;
}

/** Build a stock pi harness from a handle, exactly as a consumer does. */
async function openHarness<TContext extends object | undefined>(options: {
	models: ReturnType<typeof modelsFromStream>;
	tools: readonly AgentHarnessTool<TContext>[];
	toolContext: TContext;
}): Promise<AgentHarness<TContext>> {
	const handle = attach({ browser, client, models: options.models });
	const compiled = handle.compile<TContext>({ model: "openai:gpt-5.5", tools: options.tools });
	const harness = new AgentHarness<TContext>({
		session: await new InMemorySessionRepo().create(),
		model: compiled.model,
		models: compiled.models,
		tools: [...compiled.tools],
		activeToolNames: compiled.tools.map((tool) => tool.name),
		toolContext: options.toolContext,
	});
	compiled.activate(harness);
	return harness;
}

describe("harness tool context", () => {
	it("delivers the exact supplied context object to custom harness tools", async () => {
		interface CustomContext {
			env: ExecutionToolContext["env"];
			requestId: string;
		}
		const cwd = mkdtempSync(join(tmpdir(), "cua-harness-context-"));
		const toolContext: CustomContext = { env: new NodeExecutionEnv({ cwd }), requestId: "req-1" };
		const received: CustomContext[] = [];
		const custom: AgentHarnessTool<CustomContext> = {
			name: "custom_context",
			label: "custom_context",
			description: "records its tool context",
			parameters: { type: "object", properties: {}, additionalProperties: false } as never,
			execute: async (_toolCallId, _params, _signal, _onUpdate, context) => {
				received.push(context);
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const harness = await openHarness<CustomContext>({
			models: modelsFromStream(scriptedStream([
				(model) => assistant(model, [{ type: "toolCall", id: "call-1", name: "custom_context", arguments: {} }], "toolUse"),
				(model) => assistant(model, [{ type: "text", text: "done" }]),
			])),
			tools: [custom],
			toolContext,
		});

		await harness.prompt("run the tool");

		expect(received.length).toBe(1);
		expect(received[0]).toBe(toolContext);
	});

	it("runs pi's native read/write/edit/bash tools against the context's execution env", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cua-harness-tools-"));
		const harness = await openHarness<ExecutionToolContext>({
			models: modelsFromStream(scriptedStream([
				(model) => assistant(model, [{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "notes.txt", content: "hello cua\n" } }], "toolUse"),
				(model) => assistant(model, [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "notes.txt", edits: [{ oldText: "hello", newText: "goodbye" }] } }], "toolUse"),
				(model) => assistant(model, [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "notes.txt" } }], "toolUse"),
				(model) => assistant(model, [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "cat notes.txt" } }], "toolUse"),
				(model) => assistant(model, [{ type: "text", text: "done" }]),
			])),
			tools: [createReadTool(), createBashTool(), createEditTool(), createWriteTool()],
			toolContext: { env: new NodeExecutionEnv({ cwd }) },
		});
		const results = new Map<string, { content: Array<{ type: string; text?: string }>; isError: boolean }>();
		harness.on("tool_result", (event) => {
			results.set(event.toolName, { content: event.content, isError: event.isError });
			return undefined;
		});

		await harness.prompt("write, edit, read, and cat a file");

		expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("goodbye cua\n");
		expect(results.get("write")?.isError).toBe(false);
		expect(results.get("edit")?.isError).toBe(false);
		expect(results.get("read")?.content.some((block) => block.text?.includes("goodbye cua"))).toBe(true);
		expect(results.get("bash")?.content.some((block) => block.text?.includes("goodbye cua"))).toBe(true);
	});
});
