import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySessionRepo } from "@onkernel/cua-agent";
import { createCuaModels, type CuaModelRef } from "@onkernel/cua-ai";
import { mapThinkingLevel } from "../src/cli-harness";
import { buildCuaHarness } from "../src/harness";
import { createFakeKernelEnvironment } from "./fixtures/fake-kernel";

const SSE_CHUNKS = [
	'data: {"id":"chatcmpl-k3","object":"chat.completion.chunk","created":1,"model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n',
	'data: {"id":"chatcmpl-k3","object":"chat.completion.chunk","created":1,"model":"kimi-k3","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
	"data: [DONE]\n\n",
];

function sseResponse(): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of SSE_CHUNKS) controller.enqueue(new TextEncoder().encode(chunk));
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Run one turn against the real pi provider with fetch stubbed, returning the request payloads. */
async function capturePayloads(apiKeyEnv: string, model: CuaModelRef): Promise<Record<string, unknown>[]> {
	vi.stubEnv(apiKeyEnv, "test-key");
	vi.stubGlobal("fetch", vi.fn(async () => sseResponse()));
	const kernel = createFakeKernelEnvironment();
	const harness = buildCuaHarness({
		cwd: mkdtempSync(join(tmpdir(), "cua-kimi-payload-")),
		client: kernel.client,
		browser: kernel.browser,
		session: await new InMemorySessionRepo().create(),
		model,
		thinkingLevel: mapThinkingLevel(undefined),
		models: createCuaModels(),
		tools: [],
	});
	const payloads: Record<string, unknown>[] = [];
	harness.on("before_provider_payload", (event) => {
		payloads.push(event.payload as Record<string, unknown>);
		return undefined;
	});
	await harness.prompt("hi");
	return payloads;
}

describe("Kimi K3 reasoning effort", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("resolves the CLI default to low when --thinking is not passed", () => {
		expect(mapThinkingLevel(undefined)).toBe("low");
	});

	it("sends reasoning_effort: low to Moonshot at the CLI default thinking level", async () => {
		const payloads = await capturePayloads("MOONSHOT_API_KEY", "moonshotai:kimi-k3");
		expect(payloads.length).toBe(1);
		expect(payloads[0]?.model).toBe("kimi-k3");
		expect(payloads[0]?.reasoning_effort).toBe("low");
	});

	it("sends reasoning effort through OpenRouter's nested reasoning object", async () => {
		const payloads = await capturePayloads("OPENROUTER_API_KEY", "openrouter:moonshotai/kimi-k3");
		expect(payloads.length).toBe(1);
		expect(payloads[0]?.model).toBe("moonshotai/kimi-k3");
		expect(payloads[0]?.reasoning).toEqual({ effort: "low" });
	});
});
