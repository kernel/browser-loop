import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyNamedSessionDefaults, type HarnessCliFlags } from "../src/cli-harness";
import {
	type NamedSessionMetadata,
	readNamedSession,
	recordSessionModel,
	writeNamedSession,
} from "../src/harness-named-sessions";

const originalXdg = process.env.XDG_DATA_HOME;

function baseMeta(overrides: Partial<NamedSessionMetadata> = {}): NamedSessionMetadata {
	return { name: "foo", kernel_session_id: "ks_123", created_at: Date.now(), ...overrides };
}

function baseFlags(overrides: Partial<HarnessCliFlags> = {}): HarnessCliFlags {
	return {
		verbose: false,
		profileSaveChanges: false,
		continueLatest: false,
		resumePicker: false,
		noSession: false,
		noSkills: false,
		debugTui: false,
		jsonlIncludeDeltas: false,
		jsonlIncludeImages: false,
		playwright: false,
		namedSession: "foo",
		skillPaths: [],
		...overrides,
	};
}

describe("named session model persistence", () => {
	beforeEach(() => {
		process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "cua-cli-named-"));
	});

	afterEach(() => {
		if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = originalXdg;
	});

	it("records the model/mode/native-tool onto the metadata file", async () => {
		await writeNamedSession(baseMeta());
		await recordSessionModel("foo", { model: "anthropic:claude-opus-4-8", mode: "hybrid", native_tool: "computer_20260701" });
		const meta = await readNamedSession("foo");
		expect(meta?.model).toBe("anthropic:claude-opus-4-8");
		expect(meta?.mode).toBe("hybrid");
		expect(meta?.native_tool).toBe("computer_20260701");
	});

	it("overwrites a previously recorded model on an explicit switch", async () => {
		await writeNamedSession(baseMeta({ model: "openai:gpt-5.5" }));
		await recordSessionModel("foo", { model: "anthropic:claude-opus-4-8", mode: "hybrid" });
		const meta = await readNamedSession("foo");
		expect(meta?.model).toBe("anthropic:claude-opus-4-8");
		expect(meta?.mode).toBe("hybrid");
	});

	it("is a no-op for an unknown session", async () => {
		await recordSessionModel("missing", { model: "openai:gpt-5.5" });
		expect(await readNamedSession("missing")).toBeUndefined();
	});

	it("defaults flags from the stored session model when -m is omitted", () => {
		const meta = baseMeta({ model: "anthropic:claude-opus-4-8", mode: "hybrid", native_tool: "computer_20260701" });
		const flags = applyNamedSessionDefaults(baseFlags(), meta);
		expect(flags.model).toBe("anthropic:claude-opus-4-8");
		expect(flags.mode).toBe("hybrid");
		expect(flags.nativeTool).toBe("computer_20260701");
	});

	it("keeps explicit flags over stored session values", () => {
		const meta = baseMeta({ model: "anthropic:claude-opus-4-8", mode: "hybrid" });
		const flags = applyNamedSessionDefaults(baseFlags({ model: "openai:gpt-5.5", mode: "browser" }), meta);
		expect(flags.model).toBe("openai:gpt-5.5");
		expect(flags.mode).toBe("browser");
	});
});
