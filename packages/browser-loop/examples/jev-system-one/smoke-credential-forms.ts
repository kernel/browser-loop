import Kernel from "@onkernel/sdk";
import { BrowserExecutor } from "../../src/core/translator/browser";
import { buildCandidateSpace } from "./actions";
import { ExecutorBrowserRuntime } from "./browser";

const CASES = [
	["https://github.com/login", true],
	["https://news.ycombinator.com/login?goto=news", true],
	["https://accounts.google.com/signin/v2/identifier", true],
	["https://login.microsoftonline.com/", true],
	["https://id.atlassian.com/login", true],
	["https://www.dropbox.com/login", true],
	["https://www.notion.so/login", true],
	["https://login.salesforce.com/", true],
	["https://app.slack.com/signin", true],
	["https://www.linkedin.com/login", true],
	["https://account.proton.me/login", true],
	["https://login.yahoo.com/", true],
	["https://x.com/i/flow/login", true],
	["https://www.facebook.com/login/", true],
	["https://www.spotify.com/login/", true],
	["https://www.google.com/", false],
	["https://github.com/", false],
	["https://stripe.com/", false],
] as const;

const apiKey = process.env.KERNEL_API_KEY;
if (!apiKey) throw new Error("KERNEL_API_KEY is required");
const client = new Kernel({ apiKey });
const browser = await client.browsers.create({ stealth: true, timeout_seconds: 600 });
const executor = new BrowserExecutor(browser.cdp_ws_url);
const runtime = new ExecutorBrowserRuntime(executor, { credentials: true });
let failures = 0;
try {
	for (const [url, expected] of CASES) {
		await navigate(runtime, url);
		let observation;
		for (let attempt = 0; ; attempt += 1) {
			await delay(750);
			observation = await runtime.observe();
			if (!expected || observation.credentialForms.length > 0 || attempt === 5) break;
		}
		const detected = observation.credentialForms.length > 0;
		const leaked = observation.elements.some((element) => element.hasValue !== undefined && element.value.length > 0);
		const space = buildCandidateSpace(observation, "Sign in", [], { credentials: true });
		const credentialNodes = new Set(observation.credentialForms.flatMap((form) => form.fields.map((field) => field.target.node)));
		const hasFieldAction = space.candidates.some((candidate) => candidate.target && credentialNodes.has(candidate.target.node));
		const grouped = space.byOperation.has("USE_CREDENTIALS") && !hasFieldAction;
		const passed = detected === expected && !leaked && (!expected || grouped);
		if (!passed) failures += 1;
		console.error(`${passed ? "pass" : "fail"} ${url} forms=${observation.credentialForms.length} redacted=${!leaked} grouped=${!expected || grouped}`);
	}
} finally {
	executor.close();
	await client.browsers.deleteByID(browser.session_id);
}
if (failures) throw new Error(`${failures} credential-form smoke cases failed`);

async function navigate(runtime: ExecutorBrowserRuntime, url: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await runtime.execute({ type: "browser_navigate", url });
			return;
		} catch (error) {
			lastError = error;
			await delay(500 * (attempt + 1));
		}
	}
	throw lastError;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
