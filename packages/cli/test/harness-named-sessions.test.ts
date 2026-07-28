import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyNamedSessionDefaults, type HarnessCliFlags } from "../src/cli-harness";
import {
	listNamedSessions,
	type NamedSessionMetadata,
	readNamedSession,
	recordSessionModel,
	updateNamedSessionRuntime,
	writeNamedSession,
	writeNamedSessionRefs,
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

	it("records the model onto the metadata file", async () => {
		await writeNamedSession(baseMeta());
		await recordSessionModel("foo", { model: "anthropic:claude-opus-4-8" });
		const meta = await readNamedSession("foo");
		expect(meta?.model).toBe("anthropic:claude-opus-4-8");
	});

	it("overwrites a previously recorded model on an explicit switch", async () => {
		await writeNamedSession(baseMeta({ model: "openai:gpt-5.5" }));
		await recordSessionModel("foo", { model: "anthropic:claude-opus-4-8" });
		const meta = await readNamedSession("foo");
		expect(meta?.model).toBe("anthropic:claude-opus-4-8");
	});

	it("is a no-op for an unknown session", async () => {
		await recordSessionModel("missing", { model: "openai:gpt-5.5" });
		expect(await readNamedSession("missing")).toBeUndefined();
	});

	it("patches the model without clobbering session identity", async () => {
		await writeNamedSession(baseMeta({ model: "openai:gpt-5.5" }));
		await updateNamedSessionRuntime("foo", { model: "anthropic:claude-opus-4-8" });
		const meta = await readNamedSession("foo");
		expect(meta?.model).toBe("anthropic:claude-opus-4-8");
		expect(meta?.kernel_session_id).toBe("ks_123");
	});

	it("defaults flags from the stored session model when -m is omitted", () => {
		const meta = baseMeta({ model: "anthropic:claude-opus-4-8" });
		const flags = applyNamedSessionDefaults(baseFlags(), meta);
		expect(flags.model).toBe("anthropic:claude-opus-4-8");
	});

	it("keeps an explicit model over the stored session value", () => {
		const meta = baseMeta({ model: "anthropic:claude-opus-4-8" });
		const flags = applyNamedSessionDefaults(baseFlags({ model: "openai:gpt-5.5" }), meta);
		expect(flags.model).toBe("openai:gpt-5.5");
	});

	it("excludes refs sidecar files from listNamedSessions", async () => {
		await writeNamedSession(baseMeta());
		await writeNamedSessionRefs("foo", { refCounter: 3, generations: [], refs: [] });
		const sessions = await listNamedSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.name).toBe("foo");
	});

	it("skips metadata entries missing required fields", async () => {
		await writeNamedSession(baseMeta());
		const dir = join(process.env.XDG_DATA_HOME!, "cua", "named-sessions");
		writeFileSync(join(dir, "bogus.json"), JSON.stringify({ unrelated: true }));
		writeFileSync(join(dir, "no-age.json"), JSON.stringify({ name: "no-age", kernel_session_id: "k1" }));
		const sessions = await listNamedSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.name).toBe("foo");
	});
});
