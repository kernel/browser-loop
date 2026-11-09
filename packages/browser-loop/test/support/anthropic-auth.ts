import { identityTokenFromFile } from "@anthropic-ai/sdk/lib/credentials/identity-token";
import { oidcFederationProvider } from "@anthropic-ai/sdk/lib/credentials/oidc-federation";
import { TokenCache } from "@anthropic-ai/sdk/lib/credentials/token-cache";
import { OAUTH_API_BETA_HEADER } from "@anthropic-ai/sdk/lib/credentials/types";

export interface AnthropicRequestAuth {
	apiKey?: string;
	env?: Record<string, string>;
	headers?: Record<string, string>;
}

/**
 * Per-request Anthropic auth for live tests. `ANTHROPIC_API_KEY` wins when set;
 * otherwise the SDK's workload identity federation exchanges the identity token
 * in `ANTHROPIC_IDENTITY_TOKEN_FILE` (re-read on every exchange) and caches the
 * access token until shortly before it expires. pi's Anthropic transport takes
 * neither an SDK credential provider nor, with client toolsets, a custom client,
 * so the token goes through pi's per-request `ANTHROPIC_AUTH_TOKEN` (sent as a
 * bearer token) with the OAuth beta header the API requires for it. Returns
 * undefined when neither is configured.
 */
export function anthropicRequestAuth(
	env: NodeJS.ProcessEnv = process.env,
	fetch: typeof globalThis.fetch = globalThis.fetch,
): (() => Promise<AnthropicRequestAuth>) | undefined {
	const apiKey = env.ANTHROPIC_API_KEY;
	if (apiKey) return async () => ({ apiKey });
	const federationRuleId = env.ANTHROPIC_FEDERATION_RULE_ID;
	const organizationId = env.ANTHROPIC_ORGANIZATION_ID;
	const identityTokenFile = env.ANTHROPIC_IDENTITY_TOKEN_FILE;
	if (!federationRuleId || !organizationId || !identityTokenFile) return undefined;
	const tokens = new TokenCache(oidcFederationProvider({
		identityTokenProvider: identityTokenFromFile(identityTokenFile),
		federationRuleId,
		organizationId,
		serviceAccountId: env.ANTHROPIC_SERVICE_ACCOUNT_ID,
		baseURL: "https://api.anthropic.com",
		fetch,
	}));
	return async () => ({
		env: { ANTHROPIC_AUTH_TOKEN: await tokens.getToken() },
		headers: { "anthropic-beta": OAUTH_API_BETA_HEADER },
	});
}
