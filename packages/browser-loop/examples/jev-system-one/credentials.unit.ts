import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BrowserExecutor } from "../../src/core/translator/browser";
import { buildCandidateSpace } from "./actions";
import { ExecutorBrowserRuntime, observationFromElements } from "./browser";
import { mergeCredentialForms } from "./credentials";
import type { ObservationElement } from "./types";

function element(value: string): ObservationElement {
	return {
		id: "n1",
		node: 1,
		role: "textbox",
		name: "Password",
		value,
		operations: ["TYPE_TEXT", "CLICK"],
		options: [],
		guard: "raw-guard",
		rect: { x: 10, y: 10, width: 100, height: 30 },
	};
}

describe("credential form observations", () => {
	it("redacts sensitive values while retaining filled state", () => {
		const elements = [element("not-for-models")];
		const forms = mergeCredentialForms(elements, [{
			id: "form:1",
			name: "Sign in",
			fields: [{
				id: "credential:1",
				node: 1,
				name: "Password",
				semantic: "password",
				type: "password",
				autocomplete: "current-password",
				sensitive: true,
				hasValue: true,
				guard: "redacted-guard",
			}],
		}], "doc");
		const observation = observationFromElements({ url: "https://example.com/login", documentId: "doc", elements, credentialForms: forms });

		assert.equal(observation.elements[0]?.value, "");
		assert.equal(observation.elements[0]?.hasValue, true);
		assert.equal(observation.elements[0]?.operations.includes("TYPE_TEXT"), false);
		assert.doesNotMatch(JSON.stringify(observation), /not-for-models/);
	});

	it("describes redacted editable fields with filled state instead of an empty value", () => {
		const observation = observationFromElements({
			url: "https://example.com/login",
			elements: [{ ...element(""), name: "Email", sensitive: false, hasValue: true, operations: ["TYPE_TEXT", "CLICK"] }],
		});
		const candidate = buildCandidateSpace(observation, "sign in").byOperation.get("TYPE_TEXT")?.[0];
		assert.match(candidate?.label ?? "", /has_value=true/);
		assert.doesNotMatch(candidate?.label ?? "", /current value=""/);
	});

	it("keeps a native login form separate from an unrelated main-page input", { skip: chromiumPath() === undefined, timeout: 15_000 }, async () => {
		const launched = await launchChromium(chromiumPath()!);
		const executor = new BrowserExecutor(launched.endpoint);
		try {
			const html = `<main>
				<form><label>Email <input type="email" autocomplete="username"></label><label>Password <input type="password" autocomplete="current-password"></label><button>Sign in</button></form>
				<aside><label>Your email <input type="email"></label><button>Subscribe</button></aside>
			</main>`;
			await executor.execute({ type: "browser_evaluate", code: `document.title = "Sign in to Acme"; document.body.innerHTML = ${JSON.stringify(html)}; true` });
			const observation = await new ExecutorBrowserRuntime(executor, { credentials: true }).observe();
			assert.equal(observation.credentialForms.length, 1);
			assert.deepEqual(observation.credentialForms[0]?.fields.map((field) => field.name), ["Email", "Password"]);
		} finally {
			executor.close();
			if (launched.process.exitCode === null) {
				const exited = new Promise((resolve) => launched.process.once("exit", resolve));
				try {
					if (process.platform === "win32" || launched.process.pid === undefined) launched.process.kill("SIGKILL");
					else process.kill(-launched.process.pid, "SIGKILL");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
				await exited;
			}
			launched.process.stderr?.destroy();
			launched.process.unref();
			rmSync(launched.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it("offers one grouped credential action only when a broker is available", () => {
		const observation = observationFromElements({
			url: "https://example.com/login",
			credentialForms: [{
				id: "form:1",
				name: "Sign in",
				fields: [{
					id: "credential:1",
					name: "Email",
					semantic: "identifier",
					type: "email",
					autocomplete: "username",
					sensitive: false,
					hasValue: false,
					target: { documentId: "test-document", node: 1, guard: "guard" },
				}],
			}],
		});

		assert.equal(buildCandidateSpace(observation, "sign in").byOperation.has("USE_CREDENTIALS"), false);
		const candidates = buildCandidateSpace(observation, "sign in", [], { credentials: true }).byOperation.get("USE_CREDENTIALS");
		assert.equal(candidates?.length, 1);
		assert.equal(candidates?.[0]?.credentialForm?.fields.length, 1);
		observation.credentialForms[0]!.fields[0]!.hasValue = true;
		assert.equal(buildCandidateSpace(observation, "sign in", [], { credentials: true }).byOperation.has("USE_CREDENTIALS"), false);
	});
});

function chromiumPath(): string | undefined {
	return [process.env.CHROMIUM_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]
		.find((candidate): candidate is string => candidate !== undefined && existsSync(candidate));
}

async function launchChromium(executable: string): Promise<{ process: ChildProcess; endpoint: string; directory: string }> {
	const directory = mkdtempSync(join(tmpdir(), "jev-credential-test-"));
	const child = spawn(executable, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=0", `--user-data-dir=${directory}`, "about:blank"], {
		detached: process.platform !== "win32",
		stdio: ["ignore", "ignore", "pipe"],
	});
	const endpoint = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timed out starting Chromium")), 10_000);
		let output = "";
		child.stderr?.on("data", (chunk) => {
			output += String(chunk);
			const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
			if (!match) return;
			clearTimeout(timer);
			resolve(match[1]!);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
	return { process: child, endpoint, directory };
}
