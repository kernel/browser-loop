import { fileURLToPath } from "node:url";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCuaModel } from "@onkernel/cua-ai";
import { describe, expect, it, vi } from "vitest";

import { CuaBrowserRuntime } from "../src/browser-runtime";
import { allSelectableSpecs } from "../src/selection";
import extension from "../src/index";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface FakeTool {
	name: string;
	description: string;
	sourceInfo: { source: string; path?: string };
	execute?: (toolCallId: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;
}

interface FakeCommand {
	handler(args: string, ctx: ExtensionContext): Promise<void> | void;
}

interface FakePi {
	api: ExtensionAPI;
	handlers: Map<string, Handler>;
	commands: Map<string, FakeCommand>;
	tools: FakeTool[];
	entries: unknown[];
	providers: Provider[];
	readonly active: string[];
}

const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

function makePi(flags: Record<string, string | boolean | undefined>): FakePi {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, FakeCommand>();
	const tools: FakeTool[] = [];
	const entries: unknown[] = [];
	const providers: Provider[] = [];
	let active = ["bash"];
	const implementation = {
		registerFlag() {},
		getFlag: (name: string) => flags[name],
		registerTool: (tool: Omit<FakeTool, "sourceInfo">) => {
			const registered = { ...tool, sourceInfo: { source: "extension", path: extensionPath } };
			const existing = tools.findIndex((candidate) => candidate.name === tool.name);
			if (existing >= 0) tools[existing] = registered;
			else tools.push(registered);
		},
		registerCommand: (name: string, command: FakeCommand) => commands.set(name, command),
		registerProvider: (provider: Provider) => providers.push(provider),
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		getAllTools: () => tools,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	};
	const result: FakePi = {
		api: implementation as unknown as ExtensionAPI,
		handlers,
		commands,
		tools,
		entries,
		providers,
		get active() {
			return active;
		},
	};
	return result;
}

function getHandler(pi: FakePi, name: string): Handler {
	const handler = pi.handlers.get(name);
	if (!handler) throw new Error(`missing ${name} handler`);
	return handler;
}

function getCommand(pi: FakePi, name: string): FakeCommand {
	const command = pi.commands.get(name);
	if (!command) throw new Error(`missing ${name} command`);
	return command;
}

const model = { provider: "openai", id: "gpt-5.6-sol", api: "openai-responses" } as unknown as Model<Api>;
const ctx = {
	model,
	mode: "rpc",
	sessionManager: { getBranch: () => [] },
	ui: { setStatus() {}, notify() {} },
} as unknown as ExtensionContext;
const anthropicCtx = { ...ctx, model: getCuaModel("anthropic:claude-fable-5") } as ExtensionContext;

describe("pi extension activation", () => {
	it("reads parsed flags at session_start, installs selectable batch tools, and preserves unrelated tools", async () => {
		const pi = makePi({
			"cua-tools": "browser-batch",
			"cua-coordinates": "pixels",
			"cua-browser-timeout": "300",
			"cua-profile-save-changes": false,
		});
		extension(pi.api);
		await getHandler(pi, "session_start")({}, ctx);
		expect(pi.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(allSelectableSpecs("pixels").map((tool) => tool.name)));
		expect(pi.active).toEqual(["bash", "browser_batch"]);
	});

	it("rejects invalid parsed flags instead of silently activating no tools", () => {
		const pi = makePi({
			"cua-tools": "nope",
			"cua-coordinates": "pixels",
			"cua-browser-timeout": "300",
			"cua-profile-save-changes": false,
		});
		extension(pi.api);
		expect(() => getHandler(pi, "session_start")({}, ctx)).toThrow('unknown CUA tool selector "nope"');
	});

	it("registers the CUA Anthropic provider and serializes native computer use", async () => {
		const pi = makePi({
			"cua-tools": "anthropic-computer",
			"cua-coordinates": "pixels",
			"cua-browser-timeout": "300",
			"cua-profile-save-changes": false,
		});
		extension(pi.api);
		expect(pi.providers.map((provider) => provider.id)).toContain("anthropic");
		await getHandler(pi, "session_start")({}, anthropicCtx);
		expect(pi.active).toContain("computer");

		const headers: Record<string, string> = {};
		await getHandler(pi, "before_provider_headers")({ headers }, anthropicCtx);
		expect(headers["anthropic-beta"]).toContain("computer-use-2026-07-01");

		const payload = { tools: [{ name: "computer", input_schema: { type: "object" } }] };
		const transformed = await getHandler(pi, "before_provider_request")({ payload }, anthropicCtx);
		expect(transformed).toEqual({ tools: [expect.objectContaining({ name: "computer", type: "computer_20260701" })] });
	});

	it("keeps the browser out of the request path, and blocks execution after shutdown", async () => {
		const get = vi.spyOn(CuaBrowserRuntime.prototype, "get");
		try {
			const pi = makePi({
				"cua-tools": "anthropic-computer",
				"cua-coordinates": "pixels",
				"cua-browser-timeout": "300",
				"cua-profile-save-changes": false,
			});
			extension(pi.api);
			await getHandler(pi, "session_start")({}, anthropicCtx);

			// Compiling is declaration-only, so generating headers and transforming a
			// payload must not provision a browser. Only executing a tool does.
			await getHandler(pi, "before_provider_headers")({ headers: {} }, anthropicCtx);
			await getHandler(pi, "before_provider_request")(
				{ payload: { tools: [{ name: "computer", input_schema: { type: "object" } }] } },
				anthropicCtx,
			);
			expect(get).not.toHaveBeenCalled();

			await getHandler(pi, "session_shutdown")({}, anthropicCtx);
			const computer = pi.tools.find((tool) => tool.name === "computer");
			await expect(computer?.execute?.("call-1", {}, undefined)).rejects.toThrow("outside an active pi session");
		} finally {
			get.mockRestore();
		}
	});

	it("applies provider transforms only for the active CUA subset", async () => {
		const pi = makePi({
			"cua-tools": "browser_snapshot",
			"cua-coordinates": "pixels",
			"cua-browser-timeout": "300",
			"cua-profile-save-changes": false,
		});
		extension(pi.api);
		await getHandler(pi, "session_start")({}, ctx);
		const headers: Record<string, string> = {};
		await getHandler(pi, "before_provider_headers")({ headers }, ctx);
		const transformed = await getHandler(pi, "before_provider_request")({ payload: { tools: [] } }, ctx);
		expect(transformed).toEqual({ tools: [] });

		const inactive = makePi({ "cua-coordinates": "pixels", "cua-browser-timeout": "300", "cua-profile-save-changes": false });
		extension(inactive.api);
		await getHandler(inactive, "session_start")({}, ctx);
		expect(await getHandler(inactive, "before_provider_request")({ payload: { tools: [] } }, ctx)).toBeUndefined();
	});

	it("does not persist a flag baseline and restores only command-origin selections", async () => {
		const pi = makePi({
			"cua-tools": "browser_snapshot",
			"cua-coordinates": "pixels",
			"cua-browser-timeout": "300",
			"cua-profile-save-changes": false,
		});
		extension(pi.api);
		await getHandler(pi, "session_start")({}, ctx);
		await getHandler(pi, "session_shutdown")({}, ctx);
		expect(pi.entries).toEqual([]);

		await getCommand(pi, "cua-tools").handler("computer", ctx);
		expect(pi.entries).toEqual([
			{
				type: "custom",
				customType: "cua-pi-config-v1",
				data: expect.objectContaining({ origin: "command", selectors: ["computer"] }),
			},
		]);

		const resumed = makePi({
			"cua-tools": "browser_snapshot",
			"cua-coordinates": "pixels",
			"cua-browser-timeout": "300",
			"cua-profile-save-changes": false,
		});
		const resumedCtx = { ...ctx, sessionManager: { getBranch: () => pi.entries } } as unknown as ExtensionContext;
		extension(resumed.api);
		await getHandler(resumed, "session_start")({}, resumedCtx);
		expect(resumed.active).toContain("computer_click");
		expect(resumed.active).not.toContain("browser_snapshot");

		const legacy = makePi({
			"cua-tools": "browser_snapshot",
			"cua-coordinates": "pixels",
			"cua-browser-timeout": "300",
			"cua-profile-save-changes": false,
		});
		const legacyCtx = {
			...ctx,
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: "cua-pi-config-v1",
						data: { version: 1, selectors: ["computer"], coordinates: "normalized-1000" },
					},
				],
			},
		} as unknown as ExtensionContext;
		extension(legacy.api);
		await getHandler(legacy, "session_start")({}, legacyCtx);
		expect(legacy.active).toContain("browser_snapshot");
		expect(legacy.active).not.toContain("computer_click");
	});

	it("removes stale incompatible CUA schemas from the provider payload", async () => {
		// A provider-native surface is the incompatibility that survives the model
		// allowlist's removal: an unknown provider now compiles fine, but Anthropic's
		// native computer still cannot reach an OpenAI model.
		const pi = makePi({
			"cua-tools": "anthropic-computer",
			"cua-coordinates": "pixels",
			"cua-browser-timeout": "300",
			"cua-profile-save-changes": false,
		});
		extension(pi.api);
		await getHandler(pi, "session_start")({}, anthropicCtx);
		expect(pi.active).toContain("computer");

		const payload = {
			tools: [
				{ type: "function", function: { name: "computer" } },
				{ type: "function", function: { name: "bash" } },
				{ functionDeclarations: [{ name: "computer" }, { name: "write" }] },
				{ functionDeclarations: [{ name: "computer" }] },
			],
		};
		const transformed = await getHandler(pi, "before_provider_request")({ payload }, ctx);
		expect(transformed).toEqual({
			tools: [{ type: "function", function: { name: "bash" } }, { functionDeclarations: [{ name: "write" }] }],
		});
		expect(pi.active).toEqual(["bash"]);
	});

	it("keeps an ordinary function tool active on a model the registry does not carry", async () => {
		const pi = makePi({
			"cua-tools": "browser_snapshot",
			"cua-coordinates": "pixels",
			"cua-browser-timeout": "300",
			"cua-profile-save-changes": false,
		});
		extension(pi.api);
		await getHandler(pi, "session_start")({}, ctx);
		const unlisted = {
			...ctx,
			model: { provider: "unlisted", id: "not-in-the-registry", api: "openai-completions" },
		} as unknown as ExtensionContext;

		// Removing the model allowlist made this the expected outcome: a plain
		// function tool has no provider binding to violate, so it stays selected.
		await getHandler(pi, "before_provider_request")({ payload: { tools: [] } }, unlisted);
		expect(pi.active).toContain("browser_snapshot");
	});

	it("lists selector availability without changing the selection, and clears it only on request", async () => {
		const notices: string[] = [];
		const pi = makePi({
			"cua-tools": "browser_snapshot",
			"cua-coordinates": "pixels",
			"cua-browser-timeout": "300",
			"cua-profile-save-changes": false,
		});
		// An OpenAI model so a native selector it cannot take shows up unavailable.
		const listingCtx = {
			...ctx,
			model: getCuaModel("openai:gpt-5.6-sol"),
			ui: { setStatus() {}, notify: (text: string) => notices.push(text) },
		} as unknown as ExtensionContext;
		extension(pi.api);
		await getHandler(pi, "session_start")({}, listingCtx);

		await getCommand(pi, "cua-tools").handler("", listingCtx);
		const listing = notices.at(-1) ?? "";
		expect(listing).toContain("* browser_snapshot");
		// The reason comes from the catalog compiler, not from a rule restated here.
		expect(listing).toMatch(/anthropic-computer — unavailable: .*requires a anthropic model/);
		// Listing is not a mutation: an empty argument must not clear the selection.
		expect(pi.active).toContain("browser_snapshot");
		expect(pi.entries).toEqual([]);

		await getCommand(pi, "cua-tools").handler("none", listingCtx);
		expect(pi.active).not.toContain("browser_snapshot");
	});

	it("re-registers declarations when a new session changes coordinate mode", async () => {
		const flags: Record<string, string | boolean | undefined> = {
			"cua-tools": "computer",
			"cua-coordinates": "pixels",
			"cua-browser-timeout": "300",
			"cua-profile-save-changes": false,
		};
		const pi = makePi(flags);
		extension(pi.api);
		await getHandler(pi, "session_start")({}, ctx);
		expect(pi.tools.find((tool) => tool.name === "computer_click")?.description).not.toContain("[0, 1000]");

		flags["cua-coordinates"] = "normalized-1000";
		await getHandler(pi, "session_start")({}, ctx);
		expect(pi.tools.find((tool) => tool.name === "computer_click")?.description).toContain("[0, 1000]");
	});
});
