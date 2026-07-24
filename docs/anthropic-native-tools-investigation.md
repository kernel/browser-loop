# Anthropic native browser/computer tools investigation

**Investigation date:** 2026-07-24

**Scope:** Anthropic's early-access `computer_20260701` and `browser_20260701` client tools in `@onkernel/cua-ai` / `@onkernel/cua-agent`.

This report intentionally contains no API keys, request IDs, live-view URLs, or verbatim material from Anthropic's confidential early-access documents. Both supplied PDFs were read completely and used as the primary specification; extracted text stayed in a mode-0600 directory under `/tmp` and was not committed.

## Conclusion

The July native tools have **not been retired**. With the newly provisioned key, both tools return valid `tool_use` blocks through direct `/v1/messages` requests, through CUA's pi-ai serialization path, and through full Kernel-browser agent runs.

The reproducible rejection is a **model/tool mismatch exposed by a CUA validation bug**:

- `claude-opus-4-7` rejects both July tool types with HTTP 400.
- CUA previously accepted any Anthropic computer-use model with either July native tool. Unit tests even used Claude Opus 4.5, which the live API rejects.
- The repository's normal Anthropic examples/tests prominently use Claude Opus 4.7, making it easy for live QA to combine that model with `--native-tool` and reach the server-side 400.

The other suspected causes were ruled out for the new key and the supported configuration:

- **Entitlement:** the new key is entitled; correct early-access requests return 200. Entitlement remains an account/workspace prerequisite.
- **Header/version retirement:** the old June computer draft pair is gone, but CUA already sends the live July pair. The July pair returns 200.
- **Endpoint:** the tools work on the first-party Anthropic Messages endpoint, `POST https://api.anthropic.com/v1/messages`.
- **SDK/pi serialization:** CUA's placeholder-tool replacement and beta-header injection work live despite the installed Anthropic SDK not having types for these private tool versions.

CUA now rejects unsupported model/tool combinations locally, before provisioning a browser, and enforces the native multi-action stop-on-first-failure result contract.

## Compatibility matrix

### Tool version and header

| Tool declaration | `anthropic-beta` | Live result on eligible model | Status |
| --- | --- | --- | --- |
| `computer_20260601` | `computer-use-2026-06-01` | HTTP 400: beta value no longer recognized | Obsolete early draft; do not use |
| `computer_20260601` | `computer-use-2026-07-01` | HTTP 400: tool type unknown | Obsolete tool string |
| `computer_20260701` | omitted | HTTP 400: tool type unknown without beta | Header required |
| `computer_20260701` | `computer-use-2026-07-01` | HTTP 200 + `computer` tool use | Current early-access computer pair |
| `browser_20260701` | omitted | HTTP 400: tool type unknown without beta | Header required |
| `browser_20260701` | `browser-use-2026-07-01` | HTTP 200 + `browser` tool uses | Current early-access browser pair |
| `computer_20251124` | `computer-use-2025-11-24` | HTTP 200 on Claude Opus 4.7 | Current public computer-use fallback; not CUA's July `nativeTool` option |

The June-to-July computer drift was already discovered in git commit `e6219bb` and merged in `3caf6cc` (#51). The current CUA header and tool strings are correct.

### Model eligibility observed from the new key

The model-list endpoint returned the models below. Each was probed with the correct July header/tool pair; a pass means the response contained the expected native `tool_use` block.

| Model ID | `computer_20260701` | `browser_20260701` |
| --- | --- | --- |
| `claude-sonnet-5` | Pass | Pass |
| `claude-fable-5` | Pass | **Rejected** |
| `claude-opus-4-8` | Pass | Pass |
| `claude-opus-4-7` | **Rejected** | **Rejected** |
| `claude-sonnet-4-6` | **Rejected** | **Rejected** |
| `claude-opus-4-6` | **Rejected** | **Rejected** |
| `claude-opus-4-5-20251101` | **Rejected** | **Rejected** |
| `claude-haiku-4-5-20251001` | **Rejected** | **Rejected** |
| `claude-sonnet-4-5-20250929` | **Rejected** | **Rejected** |
| `claude-opus-4-1-20250805` | **Rejected** | **Rejected** |

These lists are deliberately fail-closed in `packages/ai/src/native-tools.ts`. Re-run the live integration test before expanding them when Anthropic changes eligibility.

### Request declaration and flags

| Dimension | `computer_20260701` | `browser_20260701` |
| --- | --- | --- |
| Required declaration | `type`, name (normally `computer`) | `type`, name (normally `browser`) |
| Optional CUA-exposed fields | `display_number`, `enable_zoom`, `cache_control` | `enable_javascript_exec`, `cache_control` |
| Dimensions | CUA does not send width/height; the screenshot establishes the coordinate frame | No declared dimensions; viewport screenshots establish the frame |
| Zoom | `enable_zoom` defaults false at the API; both true and false passed | `zoom` is part of the browser action set |
| JavaScript | Not applicable | API default is false; CUA intentionally defaults it to true to match canonical browser mode. Explicit false and true both passed live. |
| `strict: true` | HTTP 400 | HTTP 400 |
| Both July tools together | Rejected: desktop and viewport coordinate frames cannot be mixed | Rejected for the same reason |
| Endpoint | First-party Anthropic `/v1/messages` only for this early-access version | First-party Anthropic `/v1/messages` only for this early-access version |
| Account requirement | Matching early-access entitlement | Matching early-access entitlement |

### Action and result contract

`computer_20260701` emits one action per `tool_use`: screenshot; left/right/middle/double/triple click; drag; mouse move/down/up; scroll; type; key (with repeat); hold key; wait; cursor position; and optional zoom. Coordinates are screenshot pixels.

`browser_20260701` emits one action per `tool_use`: navigation/tabs; accessibility-tree and text reads; find/fill/scroll-to; viewport screenshot/zoom; ref- or coordinate-targeted pointer actions; keyboard/scroll/wait; and optional JavaScript execution. Coordinates are viewport pixels and element refs are scoped to their tab/document generation.

Both tools can emit several `tool_use` blocks in one assistant turn. CUA executes them sequentially and returns one matching `tool_result` per block. Screenshot/zoom results contain images; structured reads and acknowledgements contain text. After the first failed action, CUA now skips every remaining call in that assistant turn and returns the tool-specific required error result rather than executing against stale state.

## CUA implementation audit

### Correct before this investigation

- `packages/ai/src/providers/anthropic/native.ts` replaces pi-ai's permissive placeholder tool with the Anthropic-defined declaration after ordinary tool serialization.
- `packages/ai/src/providers.ts` routes CUA's synthetic native API IDs back through pi-ai's `anthropic-messages` transport and injects the matching beta header.
- Incoming native actions map onto CUA's canonical computer/browser actions, including key repeat, seconds-to-milliseconds duration conversion, browser refs, tabs, zoom, and JavaScript execution.
- Native CUA tools use sequential tool execution, and browser navigation results include tab context.
- Full native computer and browser runs completed against a Kernel browser.

### Bugs fixed

1. **Missing model eligibility validation.** `resolveNativeTool()` checked only provider and mode. It now rejects unsupported model families with an error that identifies the early-access requirement and lists the supported families.
2. **Incomplete multi-action failure semantics.** pi-agent-core's sequential mode continued with later calls after an earlier call failed. `CuaRuntimeSpec` now carries the provider-required skip message as data, and both `CuaAgent` and `CuaAgentHarness` block the rest of that assistant turn after the first failure.
3. **Documentation ambiguity.** Architecture and changelog text now distinguish the two headers, list the live-verified models, and state that the tools are allowlisted early access.
4. **No live serialization regression.** `packages/ai/test/anthropic-native.integration.test.ts` now checks both tools through CUA's actual pi-ai transport.

## Official public documentation comparison

Fetched on 2026-07-24:

- [Public computer-use guide](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- [Claude API release notes](https://platform.claude.com/docs/en/release-notes/overview)

The public guide still documents `computer_20251124` / `computer-use-2025-11-24` (and the older January pair). It does not document the July native computer version or the client-side July browser tool. The public release notes likewise do not announce either July pair. The installed `@anthropic-ai/sdk` types contain neither July tool string.

That discrepancy is expected for allowlisted early access, but it means public docs cannot be used to infer that `computer_20260701` or `browser_20260701` is generally available. The confidential specifications plus live first-party API behavior are the source of truth for these pairs.

## Sanitized evidence and commands

Credential-presence check (does not print the value):

```bash
test -n "${ANTHROPIC_API_KEY:-}" && echo 'ANTHROPIC_API_KEY is set'
```

Core direct probe shape (repeat with the browser declaration/header for browser use). The response filter omits IDs and usage:

```bash
curl -sS https://api.anthropic.com/v1/messages \
  -H 'content-type: application/json' \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H 'anthropic-version: 2023-06-01' \
  -H 'anthropic-beta: computer-use-2026-07-01' \
  -d '{
    "model":"claude-opus-4-8",
    "max_tokens":96,
    "tools":[{"type":"computer_20260701","name":"computer","enable_zoom":true}],
    "messages":[{"role":"user","content":"Use the computer tool to take one screenshot."}]
  }' | jq '{stop_reason, blocks: [.content[] | {type, name, action: .input.action}]}'
```

Live CUA/pi-ai serialization regression:

```bash
cd packages/ai
npx vitest --run --config vitest.integration.config.ts \
  test/anthropic-native.integration.test.ts
```

Full Kernel-browser smoke tests:

```bash
MODEL_REF=anthropic:claude-opus-4-8 CONFIG=native-computer \
  NODE_OPTIONS=--conditions=source \
  npx tsx packages/agent/examples/anthropic-native-smoke.ts

MODEL_REF=anthropic:claude-opus-4-8 CONFIG=native-browser \
  NODE_OPTIONS=--conditions=source \
  npx tsx packages/agent/examples/anthropic-native-smoke.ts
```

Repository validation:

```bash
npm run build
npm run typecheck
npm test --workspace @onkernel/cua-ai
npm test --workspace @onkernel/cua-agent
npm test --workspace @onkernel/cua-cli
cd packages/ai
npx vitest --run --config vitest.integration.config.ts \
  test/anthropic-native.integration.test.ts
```

Observed sanitized outcomes:

- Direct baseline Messages request: 200.
- Direct July computer request on Opus 4.8: 200, `tool_use` action `screenshot`.
- Direct July browser request on Opus 4.8: 200, `tool_use` actions including `navigate`.
- CUA/pi-ai live integration: 2/2 passed.
- Kernel browser native-computer smoke: completed the `example.com` task.
- Kernel browser native-browser smoke: completed the `example.com` task.
- Unit tests added for fail-closed model validation and stop-on-first-failure behavior in both agent classes.

## Recommended integration path

1. For the strongest shared configuration, use `anthropic:claude-opus-4-8` with either July native tool and an API key from the entitled organization.
2. Claude Sonnet 5 also supports both tools. Claude Fable 5 supports only the July computer tool in the observed account.
3. Never pair Claude Opus 4.7 (or earlier listed models) with a July native tool. Omit `nativeTool` to use CUA's canonical function-tool path instead.
4. For a generally documented provider-native computer integration, evaluate `computer_20251124` separately. There is no public native browser-tool equivalent to the July early-access browser tool.
5. Keep the live integration test gated on the entitled key. Treat an unrecognized beta header as an entitlement/version incident; treat a “model does not support tool type” response as model eligibility drift.
