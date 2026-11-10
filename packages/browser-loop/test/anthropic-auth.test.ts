import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLoopModels } from "../src/pi/index";
import { compileLoopToolCatalog, loop } from "../src/index";
import { anthropicRequestAuth } from "./support/anthropic-auth";

let dir: string;
let tokenFile: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "anthropic-auth-"));
	tokenFile = join(dir, "identity-token");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function federationEnv(): NodeJS.ProcessEnv {
	return {
		ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
		ANTHROPIC_ORGANIZATION_ID: "org_test",
		ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_test",
		ANTHROPIC_IDENTITY_TOKEN_FILE: tokenFile,
	};
}

function tokenEndpoint(responses: { access_token: string; expires_in: number }[]) {
	const requests: { url: string; body: Record<string, unknown> }[] = [];
	const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
		const next = responses.shift();
		if (!next) throw new Error("unexpected token exchange");
		return new Response(JSON.stringify({ ...next, token_type: "Bearer" }), { status: 200 });
	}) as typeof globalThis.fetch;
	return { fetch, requests };
}

describe("anthropicRequestAuth", () => {
	it("uses ANTHROPIC_API_KEY when set, even with federation configured", async () => {
		writeFileSync(tokenFile, "jwt-1");
		const auth = anthropicRequestAuth({ ...federationEnv(), ANTHROPIC_API_KEY: "sk-ant-test" });
		await expect(auth!()).resolves.toEqual({ apiKey: "sk-ant-test" });
	});

	it("returns undefined without a key or complete federation settings", () => {
		expect(anthropicRequestAuth({})).toBeUndefined();
		expect(anthropicRequestAuth({ ...federationEnv(), ANTHROPIC_IDENTITY_TOKEN_FILE: undefined })).toBeUndefined();
	});

	it("exchanges the identity token once and reuses the access token while fresh", async () => {
		writeFileSync(tokenFile, "jwt-1\n");
		const endpoint = tokenEndpoint([{ access_token: "access-1", expires_in: 600 }]);
		const auth = anthropicRequestAuth(federationEnv(), endpoint.fetch)!;

		const expected = { env: { ANTHROPIC_AUTH_TOKEN: "access-1" }, headers: { "anthropic-beta": "oauth-2025-04-20" } };
		await expect(auth()).resolves.toEqual(expected);
		await expect(auth()).resolves.toEqual(expected);
		expect(endpoint.requests).toEqual([{
			url: "https://api.anthropic.com/v1/oauth/token",
			body: {
				grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
				assertion: "jwt-1",
				federation_rule_id: "fdrl_test",
				organization_id: "org_test",
				service_account_id: "svac_test",
			},
		}]);
	});

	it("re-reads the identity token file and re-exchanges near expiry", async () => {
		writeFileSync(tokenFile, "jwt-1");
		const endpoint = tokenEndpoint([
			{ access_token: "access-1", expires_in: 10 },
			{ access_token: "access-2", expires_in: 600 },
		]);
		const auth = anthropicRequestAuth(federationEnv(), endpoint.fetch)!;

		expect((await auth()).env?.ANTHROPIC_AUTH_TOKEN).toBe("access-1");
		writeFileSync(tokenFile, "jwt-2");
		expect((await auth()).env?.ANTHROPIC_AUTH_TOKEN).toBe("access-2");
		expect(endpoint.requests.map((request) => request.body.assertion)).toEqual(["jwt-1", "jwt-2"]);
	});

	it("sends the federated token through pi's Anthropic transport without an API key", async () => {
		writeFileSync(tokenFile, "jwt-1");
		const auth = anthropicRequestAuth(federationEnv(), tokenEndpoint([{ access_token: "access-1", expires_in: 600 }]).fetch)!;
		const { apiKey, env, headers } = await auth();
		const catalog = compileLoopToolCatalog({
			model: "anthropic:claude-opus-5",
			requestedTools: [loop.providers.anthropic.tools.browser({ version: "20260801", javascript: true })],
		});
		let sent: Headers | undefined;
		await createLoopModels().complete(
			catalog.model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [...catalog.toolDeclarations] },
			{
				apiKey,
				env,
				headers: catalog.headers.merge(headers),
				loopIncomingToolPlan: catalog.incoming,
				maxRetries: 0,
				fetch: async (_url, init) => {
					sent = new Headers(init?.headers);
					return new Response("{}", { status: 400 });
				},
			},
		);
		expect(sent?.get("authorization")).toBe("Bearer access-1");
		expect(sent?.get("x-api-key")).toBeNull();
		expect(sent?.get("anthropic-beta")?.split(",")).toContain("oauth-2025-04-20");
	});
});
