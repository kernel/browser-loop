import type { BrowserExecutor, BrowserFindCandidate, InternalComputerTranslator as Translator } from "@onkernel/cua-agent";
import { InternalComputerTranslator } from "@onkernel/cua-agent";
import type { CuaBrowserAction } from "@onkernel/cua-ai";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isCoordinatePair,
	parseDeterministicArgs,
	runDeterministicCommand,
	runDeterministicOnHandle,
} from "../src/cli-executor";
import type { HarnessCliFlags } from "../src/cli-harness";
import type { CuaBrowserHandle } from "../src/harness-browser";
import { createFakeKernelEnvironment, type FakeKernelEnvironment } from "./fixtures/fake-kernel";

const PROVIDER_ENV_KEYS = [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"TZAFON_API_KEY",
	"YUTORI_API_KEY",
];

function baseFlags(overrides: Partial<HarnessCliFlags> = {}): HarnessCliFlags {
	return {
		verbose: false,
		profileSaveChanges: true,
		continueLatest: false,
		resumePicker: false,
		noSession: false,
		noSkills: false,
		debugTui: false,
		jsonlIncludeDeltas: false,
		jsonlIncludeImages: false,
		playwright: false,
		skillPaths: [],
		...overrides,
	};
}

interface FakeExecutorState {
	actions: CuaBrowserAction[];
	closed: number;
}

interface FakeExecutorScript {
	candidates?: BrowserFindCandidate[];
	url?: string;
	texts?: Partial<Record<string, string>>;
	failWith?: Error;
}

function fakeExecutor(script: FakeExecutorScript = {}): { executor: BrowserExecutor; state: FakeExecutorState } {
	const state: FakeExecutorState = { actions: [], closed: 0 };
	const executor = {
		async execute(action: CuaBrowserAction) {
			if (script.failWith) throw script.failWith;
			state.actions.push(action);
			const text = script.texts?.[action.type];
			return text !== undefined ? [{ type: "browser_text", label: action.type, text }] : [];
		},
		async findCandidates() {
			if (script.failWith) throw script.failWith;
			return script.candidates ?? [];
		},
		async currentUrl() {
			return script.url ?? "";
		},
		close() {
			state.closed += 1;
		},
	};
	return { executor: executor as unknown as BrowserExecutor, state };
}

interface TestSetup {
	kernel: FakeKernelEnvironment;
	handle: CuaBrowserHandle;
	handleCloses: () => number;
	createTranslator: (handle: CuaBrowserHandle) => Translator;
	state: FakeExecutorState;
}

function setup(script: FakeExecutorScript = {}): TestSetup {
	const kernel = createFakeKernelEnvironment();
	let closes = 0;
	const handle: CuaBrowserHandle = {
		client: kernel.client,
		browser: kernel.browser,
		async close() {
			closes += 1;
		},
	};
	const { executor, state } = fakeExecutor(script);
	const createTranslator = (h: CuaBrowserHandle) =>
		new InternalComputerTranslator({ browser: h.browser, client: h.client, createBrowserExecutor: () => executor });
	return { kernel, handle, handleCloses: () => closes, createTranslator, state };
}

let stdoutLines: string[] = [];
let originalWrite: typeof process.stdout.write;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	stdoutLines = [];
	originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdoutLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("latin1"));
		return true;
	}) as typeof process.stdout.write;
	savedEnv = {};
	for (const key of [...PROVIDER_ENV_KEYS, "KERNEL_API_KEY"]) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	process.stdout.write = originalWrite;
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("isCoordinatePair", () => {
	it("accepts exactly two integer tokens", () => {
		expect(isCoordinatePair(["10", "20"])).toBe(true);
	});

	it("rejects descriptions, partial pairs, and non-integers", () => {
		expect(isCoordinatePair(["3", "dots", "menu"])).toBe(false);
		expect(isCoordinatePair(["10"])).toBe(false);
		expect(isCoordinatePair(["10", "20px"])).toBe(false);
		expect(isCoordinatePair([])).toBe(false);
	});
});

describe("parseDeterministicArgs", () => {
	it("rejects invalid argv before any provisioning", () => {
		expect(() => parseDeterministicArgs("open", [], baseFlags())).toThrow("usage: cua open");
		expect(() => parseDeterministicArgs("find", [], baseFlags())).toThrow("usage: cua find");
		expect(() => parseDeterministicArgs("fill", ["query"], baseFlags())).toThrow("usage: cua fill");
		expect(() => parseDeterministicArgs("press", [], baseFlags())).toThrow("usage: cua press");
		expect(() => parseDeterministicArgs("click", ["a", "b"], baseFlags())).toThrow("usage: cua click");
		expect(() => parseDeterministicArgs("snapshot", [], baseFlags({ filter: "everything" }))).toThrow(
			"invalid --filter",
		);
	});

	it("accepts the documented forms", () => {
		expect(parseDeterministicArgs("open", ["back"], baseFlags())).toEqual({ action: "open", url: "back" });
		expect(parseDeterministicArgs("snapshot", [], baseFlags({ filter: "interactive" }))).toEqual({
			action: "snapshot",
			filter: "interactive",
		});
		expect(parseDeterministicArgs("fill", ["email", "a@b.c"], baseFlags())).toEqual({
			action: "fill",
			query: "email",
			value: "a@b.c",
		});
		expect(parseDeterministicArgs("click", ["10", "20"], baseFlags())).toEqual({ action: "click", x: 10, y: 20 });
	});

	it("runDeterministicCommand surfaces argv errors before touching the Kernel API", async () => {
		// KERNEL_API_KEY is unset in this suite: reaching provisioning would
		// throw "missing Kernel API key" instead of the usage error.
		await expect(runDeterministicCommand("open", [], baseFlags())).rejects.toThrow("usage: cua open");
	});
});

describe("runDeterministicOnHandle", () => {
	it("open navigates via CDP and prints ok (no provider keys in env)", async () => {
		const t = setup({ texts: { browser_navigate: "Navigated to https://example.test/." } });
		const code = await runDeterministicOnHandle({ action: "open", url: "example.test" }, t.handle, t.createTranslator);
		expect(code).toBe(0);
		expect(stdoutLines.join("")).toBe("ok\n");
		expect(t.state.actions).toEqual([{ type: "browser_navigate", url: "example.test" }]);
		expect(t.state.closed).toBe(1);
		expect(t.handleCloses()).toBe(1);
	});

	it("url prints the current URL", async () => {
		const t = setup({ url: "https://example.test/page" });
		const code = await runDeterministicOnHandle({ action: "url" }, t.handle, t.createTranslator);
		expect(code).toBe(0);
		expect(stdoutLines.join("")).toBe("https://example.test/page\n");
	});

	it("snapshot passes --filter through and prints the tree", async () => {
		const t = setup({ texts: { browser_snapshot: 'button "Go" [e1]' } });
		const code = await runDeterministicOnHandle(
			{ action: "snapshot", filter: "interactive" },
			t.handle,
			t.createTranslator,
		);
		expect(code).toBe(0);
		expect(stdoutLines.join("")).toBe('button "Go" [e1]\n');
		expect(t.state.actions).toEqual([{ type: "browser_snapshot", filter: "interactive" }]);
	});

	it("text prints the page text", async () => {
		const t = setup({ texts: { browser_text: "hello world" } });
		const code = await runDeterministicOnHandle({ action: "text" }, t.handle, t.createTranslator);
		expect(code).toBe(0);
		expect(stdoutLines.join("")).toBe("hello world\n");
	});

	it("tabs prints one line per tab", async () => {
		const t = setup({ texts: { browser_list_tabs: 'tab_id AAAA: "One" (https://a)\ntab_id BBBB: "Two" (https://b)' } });
		const code = await runDeterministicOnHandle({ action: "tabs" }, t.handle, t.createTranslator);
		expect(code).toBe(0);
		expect(stdoutLines.join("")).toContain("tab_id AAAA");
	});

	it("find exits 1 when no candidates match", async () => {
		const t = setup({ candidates: [] });
		const code = await runDeterministicOnHandle({ action: "find", query: "missing thing" }, t.handle, t.createTranslator);
		expect(code).toBe(1);
		expect(stdoutLines.join("")).toBe('not_found no elements matched "missing thing"\n');
	});

	it("find prints one candidate per line", async () => {
		const t = setup({
			candidates: [
				{ ref: "e1", role: "button", name: "Search", score: 2 },
				{ ref: "e2", role: "link", name: "Search help", score: 1 },
			],
		});
		const code = await runDeterministicOnHandle({ action: "find", query: "search" }, t.handle, t.createTranslator);
		expect(code).toBe(0);
		expect(stdoutLines.join("")).toBe('button "Search" [e1]\nlink "Search help" [e2]\n');
	});

	it("fill exits 1 when nothing fillable matches", async () => {
		const t = setup({ candidates: [{ ref: "e1", role: "button", name: "Email us", score: 1 }] });
		const code = await runDeterministicOnHandle(
			{ action: "fill", query: "email", value: "a@b.c" },
			t.handle,
			t.createTranslator,
		);
		expect(code).toBe(1);
		expect(stdoutLines.join("")).toBe('not_found no fillable element matched "email"\n');
		expect(t.state.actions).toEqual([]);
	});

	it("fill exits 1 on a tied top score and lists the matches", async () => {
		const t = setup({
			candidates: [
				{ ref: "e1", role: "textbox", name: "Email", score: 1 },
				{ ref: "e2", role: "textbox", name: "Email confirmation", score: 1 },
			],
		});
		const code = await runDeterministicOnHandle(
			{ action: "fill", query: "email", value: "a@b.c" },
			t.handle,
			t.createTranslator,
		);
		expect(code).toBe(1);
		expect(stdoutLines.join("")).toBe(
			'not_found ambiguous query "email" (2 matches): textbox "Email", textbox "Email confirmation"\n',
		);
		expect(t.state.actions).toEqual([]);
	});

	it("fill fills the unique best fillable match by ref", async () => {
		const t = setup({
			candidates: [
				{ ref: "e1", role: "button", name: "Email us", score: 3 },
				{ ref: "e2", role: "textbox", name: "Email", score: 2 },
				{ ref: "e3", role: "textbox", name: "Name", score: 1 },
			],
		});
		const code = await runDeterministicOnHandle(
			{ action: "fill", query: "email", value: "a@b.c" },
			t.handle,
			t.createTranslator,
		);
		expect(code).toBe(0);
		expect(stdoutLines.join("")).toBe('ok filled textbox "Email"\n');
		expect(t.state.actions).toEqual([{ type: "browser_fill", ref: "e2", value: "a@b.c" }]);
	});

	it("press dispatches one key chord through the computer batch API", async () => {
		const t = setup();
		const code = await runDeterministicOnHandle({ action: "press", keys: ["ctrl", "l"] }, t.handle, t.createTranslator);
		expect(code).toBe(0);
		expect(stdoutLines.join("")).toBe("ok pressed\n");
		expect(t.kernel.batchCalls).toHaveLength(1);
		const body = t.kernel.batchCalls[0]!.body as { actions: Array<{ type: string; press_key?: { keys: string[]; hold_keys?: string[] } }> };
		expect(body.actions).toEqual([{ type: "press_key", press_key: { keys: ["l"], hold_keys: ["Control_L"] } }]);
	});

	it("click <x> <y> dispatches an OS-level click at the coordinates", async () => {
		const t = setup();
		const code = await runDeterministicOnHandle({ action: "click", x: 10, y: 20 }, t.handle, t.createTranslator);
		expect(code).toBe(0);
		expect(stdoutLines.join("")).toBe("ok clicked (10, 20)\n");
		const body = t.kernel.batchCalls[0]!.body as { actions: Array<{ type: string; click_mouse?: { x: number; y: number } }> };
		expect(body.actions[0]!.type).toBe("click_mouse");
		expect(body.actions[0]!.click_mouse).toMatchObject({ x: 10, y: 20 });
	});

	it("screenshot captures via the SDK and writes the file", async () => {
		const t = setup();
		const out = join(mkdtempSync(join(tmpdir(), "cua-shot-")), "shot.png");
		const code = await runDeterministicOnHandle({ action: "screenshot", out }, t.handle, t.createTranslator);
		expect(code).toBe(0);
		expect(stdoutLines.join("")).toBe(`${out}\n`);
		expect(t.kernel.screenshots).toBe(1);
		expect((await readFile(out)).length).toBeGreaterThan(0);
	});

	it("exits 2 and still closes executor and handle when the executor throws", async () => {
		const t = setup({ failWith: new Error("cdp exploded") });
		const code = await runDeterministicOnHandle({ action: "open", url: "example.test" }, t.handle, t.createTranslator);
		expect(code).toBe(2);
		expect(stdoutLines.join("")).toBe("error cdp exploded\n");
		expect(t.state.closed).toBe(1);
		expect(t.handleCloses()).toBe(1);
	});
});
