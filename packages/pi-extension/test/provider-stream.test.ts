import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCuaModel } from "@onkernel/cua-ai";
import { describe, expect, it, vi } from "vitest";

// Only createCuaModels is replaced: the wrapped providers echo back what the
// extension forwarded, so the test observes the model and options that would go
// on the wire without a network call. Everything else in cua-ai stays real, and
// this mock is scoped to this file so it cannot weaken assertions elsewhere.
vi.mock("@onkernel/cua-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@onkernel/cua-ai")>();
	const echo = (id: string) => ({
		id,
		name: `echo-${id}`,
		auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "test" } }) } },
		getModels: () => [],
		stream: (model: unknown, context: unknown, options: unknown) => ({ model, context, options }),
		streamSimple: (model: unknown, context: unknown, options: unknown) => ({ model, context, options }),
	});
	return {
		...actual,
		createCuaModels: () => ({
			...actual.createCuaModels(),
			getProvider: (id: string) => (["anthropic", "openai", "google"].includes(id) ? echo(id) : undefined),
		}),
	};
});

import extension from "../src/index";

interface FakeProvider {
	id: string;
	streamSimple(model: Model<Api>, context: unknown, options?: unknown): unknown;
}

function makePi(flags: Record<string, string | boolean | undefined>) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const providers: FakeProvider[] = [];
	let active: string[] = [];
	const api = {
		registerFlag() {},
		getFlag: (name: string) => flags[name],
		registerTool() {},
		registerCommand() {},
		registerProvider: (provider: FakeProvider) => providers.push(provider),
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		getAllTools: () => [],
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	return { api, handlers, providers, get active() { return active; } };
}

const ctx = {
	mode: "rpc",
	sessionManager: { getBranch: () => [] },
	ui: { setStatus() {}, notify() {} },
} as unknown as ExtensionContext;

describe("provider stream ownership", () => {
	it("streams a native surface with the derived transport and the incoming plan", async () => {
		const pi = makePi({
			"cua-tools": "openai-computer",
			"cua-coordinates": "pixels",
			"cua-browser-timeout": "300",
			"cua-profile-save-changes": false,
		});
		extension(pi.api);
		const openaiCtx = { ...ctx, model: getCuaModel("openai:gpt-5.6-sol") } as ExtensionContext;
		await pi.handlers.get("session_start")!({}, openaiCtx);
		expect(pi.active).toContain("computer");

		// pi resolves its own registry model, whose api is the builtin transport. The
		// registered provider has to put the *compiled* api on the wire instead, or
		// the CUA adapter never runs and `computer_call` items never normalize.
		const provider = pi.providers.find((candidate) => candidate.id === "openai");
		expect(provider).toBeDefined();
		const registryModel = getCuaModel("openai:gpt-5.6-sol");
		expect(registryModel.api).toBe("openai-responses");

		const streamed = provider!.streamSimple(registryModel, { messages: [] } as never, { apiKey: "from-pi" } as never) as unknown as {
			model: Model<string>;
			options: { cuaIncomingToolPlan?: { openaiComputerName?: string }; apiKey?: string };
		};
		expect(streamed.model.api).toBe("openai-cua-computer");
		expect(streamed.options.cuaIncomingToolPlan?.openaiComputerName).toBe("computer");
		// pi's resolved credential must survive the swap.
		expect(streamed.options.apiKey).toBe("from-pi");
	});
});
