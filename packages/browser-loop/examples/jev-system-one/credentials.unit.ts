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

	it("groups native and formless login fields without unrelated inputs", { skip: chromiumPath() === undefined, timeout: 30_000 }, async () => {
		const launched = await launchChromium(chromiumPath()!);
		const executor = new BrowserExecutor(launched.endpoint);
		try {
			const html = `<main>
				<form><label>Email <input type="email" autocomplete="username"></label><label>Password <input type="password" autocomplete="current-password"></label><button>Sign in</button></form>
				<aside><label>Your email <input type="email"></label><button>Subscribe</button></aside>
			</main>`;
			await executor.execute({ type: "browser_evaluate", code: `document.title = "Sign in to Acme"; document.body.innerHTML = ${JSON.stringify(html)}; true` });
			const runtime = new ExecutorBrowserRuntime(executor, { credentials: true });
			const native = await runtime.observe();
			assert.equal(native.credentialForms.length, 1);
			assert.deepEqual(native.credentialForms[0]?.fields.map((field) => field.name), ["Email", "Password"]);

			const formless = `<main>
				<section><label>Email <input type="email"></label><button>Continue</button></section>
				<aside><label>Newsletter <input type="email"></label><button>Subscribe</button></aside>
			</main>`;
			await executor.execute({ type: "browser_evaluate", code: `document.title = "Sign in to Acme"; document.body.innerHTML = ${JSON.stringify(formless)}; true` });
			const identifierFirst = await runtime.observe();
			assert.equal(identifierFirst.credentialForms.length, 1);
			assert.deepEqual(identifierFirst.credentialForms[0]?.fields.map((field) => field.name), ["Email"]);

			const mainOnly = `<main><h1>Sign in</h1><label>Email <input type="email"></label><button>Next</button></main>`;
			await executor.execute({ type: "browser_evaluate", code: `document.title = "Sign in to Acme"; document.body.innerHTML = ${JSON.stringify(mainOnly)}; true` });
			const fallbackAction = await runtime.observe();
			assert.equal(fallbackAction.credentialForms.length, 1);
			assert.deepEqual(fallbackAction.credentialForms[0]?.fields.map((field) => field.name), ["Email"]);

			const paired = `<main>
				<form><input name="acct" autocomplete="username"><input name="pw" type="password"><button>Log in</button></form>
				<form><input name="acct" autocomplete="username"><input name="pw" type="password"><button>Create account</button></form>
			</main>`;
			await executor.execute({ type: "browser_evaluate", code: `document.title = "Accounts"; document.body.innerHTML = ${JSON.stringify(paired)}; true` });
			const distinctActions = await runtime.observe();
			assert.deepEqual(distinctActions.credentialForms.map((form) => form.name), ["Log in", "Create account"]);

			const unnamedAction = `<form><input type="password"><button><svg aria-hidden="true"></svg></button></form>`;
			await executor.execute({ type: "browser_evaluate", code: `document.title = ""; document.body.innerHTML = ${JSON.stringify(unnamedAction)}; true` });
			const unnamed = await runtime.observe();
			assert.equal(unnamed.credentialForms[0]?.name, "credential form");
		} finally {
			executor.close();
			await stopChromium(launched.process);
			rmSync(launched.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it("offers only one grouped credential action for a managed form", () => {
		const observation = observationFromElements({
			url: "https://example.com/login",
			elements: [{ ...element(""), name: "Email", sensitive: false, credentialSemantic: "identifier" }],
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

		const unmanaged = buildCandidateSpace(observation, "sign in");
		assert.equal(unmanaged.byOperation.has("USE_CREDENTIALS"), false);
		assert.equal(unmanaged.byOperation.get("TYPE_TEXT")?.length, 1);

		const managed = buildCandidateSpace(observation, "sign in", [], { credentials: true });
		const candidates = managed.byOperation.get("USE_CREDENTIALS");
		assert.equal(candidates?.length, 1);
		assert.equal(candidates?.[0]?.credentialForm?.fields.length, 1);
		assert.equal(managed.byOperation.has("TYPE_TEXT"), false);
		assert.equal(managed.byOperation.has("CLICK"), false);
		assert.equal(managed.byOperation.has("DONE"), false);
		assert.deepEqual(managed.elements[0]?.operations, []);

		observation.credentialForms[0]!.fields[0]!.hasValue = true;
		const filled = buildCandidateSpace(observation, "sign in", [], { credentials: true });
		assert.equal(filled.byOperation.has("USE_CREDENTIALS"), false);
		assert.equal(filled.byOperation.has("TYPE_TEXT"), false);
	});
});

function chromiumPath(): string | undefined {
	const executable = process.env.CHROMIUM_PATH;
	return executable && existsSync(executable) ? executable : undefined;
}

async function launchChromium(executable: string): Promise<{ process: ChildProcess; endpoint: string; directory: string }> {
	const directory = mkdtempSync(join(tmpdir(), "jev-credential-test-"));
	const child = spawn(executable, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=0", `--user-data-dir=${directory}`, "about:blank"], {
		detached: process.platform !== "win32",
		stdio: ["ignore", "ignore", "pipe"],
	});
	try {
		const endpoint = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Timed out starting Chromium")), 20_000);
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
	} catch (error) {
		await stopChromium(child);
		rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		throw error;
	}
}

async function stopChromium(child: ChildProcess): Promise<void> {
	if (child.exitCode === null && child.signalCode === null) {
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		try {
			if (process.platform === "win32" || child.pid === undefined) child.kill("SIGKILL");
			else process.kill(-child.pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
		await exited;
	}
	child.stderr?.destroy();
	child.unref();
}
