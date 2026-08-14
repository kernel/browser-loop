---
name: update-models
description: Detect drift in CUA's provider-native tool surfaces and per-model request limits. Use when a provider ships a new native computer/browser tool version, when a model starts rejecting a tool schema CUA sends, or when auditing provider-native action vocabularies against official docs and examples.
---

# Update Models

Use this workflow to keep CUA's two model tables honest. Note what it is **not** for: CUA has no model allowlist. Every model pi-ai carries is selectable, and an id pi-ai has not caught up with is synthesized from its nearest sibling, so a newly released model needs no repo change to be usable.

What still needs maintaining is narrow:

- `CUA_NATIVE_SURFACES` — which models have a provider-native computer or browser tool CUA can offer.
- `CUA_MODEL_QUIRKS` — request-shape limits, each justified by a documented limit or an observed failure.
- The provider adapters themselves, when a native action vocabulary or tool version changes.

Do not trust a static list for any of those: combine provider metadata, official docs, official example repos, and live non-destructive smoke tests.

## Quick Start

1. Verify credentials are available: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` or `GEMINI_API_KEY`, `XAI_API_KEY`, and `MOONSHOT_API_KEY`.
2. If credentials live in `~/AGENTS.md`, load them into the current shell without printing them:

```bash
eval "$(python3 - <<'PY'
import pathlib, re, shlex
text = pathlib.Path('~/AGENTS.md').expanduser().read_text()
for key in ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY', 'MOONSHOT_API_KEY']:
    m = re.search(r'export\s+' + re.escape(key) + r'=(?:"([^"]+)"|([^\s\n]+))', text)
    if m:
        print(f'export {key}={shlex.quote(m.group(1) or m.group(2))}')
PY
)"
```

3. From the repo root, run the all-provider probe:

```bash
npx tsx .agents/skills/update-models/reference/discover-models.ts --provider all --out /tmp/cua-model-report.json
```

4. Audit official examples for tool shape drift:

```bash
npx tsx .agents/skills/update-models/reference/audit-official-examples.ts --out /tmp/cua-example-evidence.json
```

5. Compare docs, examples, live probes, and local adapter constants:

```bash
npx tsx .agents/skills/update-models/reference/provider-doc-drift.ts --examples /tmp/cua-example-evidence.json --out /tmp/cua-drift.json
```

6. Summarize findings with the template in `reference/report-schema.md`. Only recommend repo changes after checking the decision rules below.

## Evidence Order

Use all four evidence sources when possible:

- Provider metadata APIs: tells us what models are available to this API key.
- Official docs: tells us intended tool names, dated beta headers, and documented action vocabularies.
- Model-specific docs: tells us endpoint, streaming, feature, and tool support for a specific model ID.
- Official example repos: shows real response parsing, action execution, safety handling, and follow-up payload shapes.
- Live smoke tests: confirms the current model/API combination can emit provider-native computer-use tool calls.
- Local cua-ai smoke tests: confirms `@onkernel/cua-ai` resolves the model through `getCuaModel()` and its provider adapter emits executable CUA tool calls.

Treat example repos as strongest when they are provider-owned or linked from official docs. If discovered through search only, mark them lower confidence until verified.

## Model Enumeration

There are two enumeration layers:

- Live provider availability: `reference/discover-models.ts` uses provider APIs and docs (`OpenAI().models.list()`, `Anthropic().models.list({ limit: 1000 })`, `GoogleGenAI().models.list()` / documented Gemini computer-use IDs, and xAI's OpenAI-compatible `models.list()`) to discover what the current API key can access.
- Selectable refs: `listCuaModels(provider?)` from `@onkernel/cua-ai` returns pi-ai's whole catalog, each entry marked with the native surfaces CUA can offer for it. `cuaNativeSurfaces(model)` and `cuaModelQuirks(model)` answer those two questions for a single model.

When live discovery finds a new model with passing smoke tests, update `packages/ai/src/models.ts`; then verify it appears in `listCuaModels("<provider>")`.

## Provider Checks

Meta:

- Smoke-test the Responses API with screenshot input and explicit function tools matching CUA's canonical actions.
- Pass condition: response output contains a `function_call` for one of the supplied browser actions.
- Use `store: true` plus `previous_response_id` for CUA tool loops. Meta rejects `include: ["reasoning.encrypted_content"]` on requests that set `previous_response_id`.
- Set `parallel_tool_calls: false` because browser actions mutate shared state.
- Treat Meta computer use as custom-function-tool support, not a provider-native `{ type: "computer" }` tool.

OpenAI:

- Discover with `OpenAI().models.list()` and optionally `models.retrieve(modelId)`.
- OpenAI model metadata is sparse (`id`, `created`, `owned_by`), so computer-use support must be smoke-tested.
- Check the model-specific docs page at `https://developers.openai.com/api/docs/models/<model>` before adding support. For aliases/snapshots, check the canonical family page too, e.g. `gpt-5.5-pro-2026-04-23` -> `gpt-5.5-pro`.
- For CUA support, require `Responses` endpoint support, `Streaming` support, and `Function calling` support. Do not list models like `gpt-5.5-pro` that say `Streaming: Not supported`.
- For provider-native OpenAI computer use, require `Computer use: Supported`. If a model supports function calling but not native `computer`, label it custom-tool-only and do not treat it as provider-native computer-use support.
- Smoke-test `responses.create` with `tools: [{ type: "computer" }]` and `tool_choice: { type: "computer" }`.
- Pass condition: response output contains `type: "computer_call"` with `actions[]` or legacy `action`.
- Audit official examples for `computer_call`, `actions`, `computer_call_output`, `pending_safety_checks`, and screenshot payload handling.

Anthropic:

- Discover with `Anthropic().models.list({ limit: 1000 })`.
- Record `id`, `display_name`, `created_at`, token limits, and `capabilities`.
- Smoke-test `client.beta.messages.create` with discovered computer tool and beta pairs, newest first.
- Pass condition: `stop_reason === "tool_use"` and a `tool_use` block named `computer`.
- For CUA support, the passing pair should match the Anthropic tool version and beta header the cua-ai runtime (via `pi-ai`) sends for that model; `discover-models.ts` reports this as `runtime_compatible`. A pass on a different pair is provider support that needs a `pi-ai` bump before the runtime can use it.
- Watch for dated drift: `computer_YYYYMMDD` tool names and `computer-use-YYYY-MM-DD` beta headers.

Google/Gemini:

- Discover with `GoogleGenAI().models.list()` and `models.get(...)`.
- Filter models that support `generateContent`, then test official `computer_use`.
- Pass condition: response contains provider-native `functionCall.name` values such as `open_web_browser`, `click_at`, or `type_text_at`.
- Do not infer official computer-use support from CUA's custom Gemini `functionDeclarations`; those are a separate compatibility path.

xAI:

- Discover with the OpenAI SDK against `https://api.x.ai/v1` using `XAI_API_KEY`.
- Record aliases, context length, standard and long-context token prices, and the 200k long-context threshold returned by `models.list()`.
- Smoke-test the Responses API with screenshot input and explicit function tools matching CUA's canonical actions.
- Pass condition: response output contains a `function_call` for one of the supplied browser actions.
- Treat Grok computer use as custom-function-tool support, not a provider-native computer tool. xAI currently documents image understanding and function calling but no native coordinate protocol.
- Use CUA's normalized 0-1000 coordinate instructions, `parallel_tool_calls: false`, `store: true`, and `previous_response_id` for browser loops. xAI accepts encrypted reasoning replay in these requests.
- Use `reasoning: { effort: "low" }` for low-latency smoke tests; Grok 4.5 also supports `medium` and `high`, cannot disable reasoning, and defaults to `high`.

Moonshot:

- Discover with the OpenAI SDK against `https://api.moonshot.ai/v1` using `MOONSHOT_API_KEY`.
- Smoke-test the chat completions API with screenshot input and explicit function tools matching CUA's canonical actions.
- Pass condition: response `choices[0].message.tool_calls[]` contains one of the supplied browser actions.
- Treat Kimi computer use as custom-function-tool support, not a provider-native computer tool. Moonshot documents vision input and function calling but no coordinate protocol.
- Kimi grounding emits width/height fractions from 0 to 1 regardless of prompt or schema wording; keep CUA's fractional coordinate contract and verify emitted values stay in 0-1.
- Set `parallel_tool_calls: false` because browser actions mutate shared state. There is no response threading; the full context replays each turn.
- Kimi K3 launched with max-only thinking effort. pi-ai's registry entry clamps other levels away; re-check `thinkingLevelMap` when Moonshot ships low/high modes.

## Native Action Discovery

Run action probes when updating adapters or when docs/examples show drift:

```bash
npx tsx .agents/skills/update-models/reference/discover-models.ts --provider xai --models grok-4.5
npx tsx .agents/skills/update-models/reference/native-action-probe.ts --provider openai --model gpt-5.5
npx tsx .agents/skills/update-models/reference/native-action-probe.ts --provider anthropic --model claude-opus-4-7
npx tsx .agents/skills/update-models/reference/native-action-probe.ts --provider gemini --model gemini-3-flash-preview
npx tsx .agents/skills/update-models/reference/native-action-probe.ts --provider xai --model grok-4.5
```

The probe does not execute browser actions. It elicits tool calls for screenshot, click, type, keypress, scroll, drag, hover/move, wait, back/forward, and navigation. Compare:

- `documented_actions`: extracted from provider docs or SDK source.
- `example_repo_actions`: extracted from official examples.
- `observed_actions`: emitted by live smoke probes.
- `repo_supported_actions`: local adapter constants.
- `unknown_observed_actions`: actions emitted by providers but not supported locally.

## Decision Rules

Add a `CUA_NATIVE_SURFACES` entry only if:

- The provider documents a native computer or browser tool for that model.
- A live probe elicits a native tool call: `npx tsx .agents/skills/update-models/reference/native-action-probe.ts --provider <p> --model <id>`.
- The local adapter can execute the actions the probe emits; otherwise the adapter needs updating first.

Add a `CUA_MODEL_QUIRKS` entry only if you can state the failure it prevents. A quirk is not a preference — it is
a request CUA must not send because the provider rejects it. Record the evidence in the entry's `reason`, and
prefer the narrowest scope that covers it: a single model id over a family, a family over a whole provider.

Remove a quirk when the provider lifts the limit. A stale quirk silently denies a model a tool it now accepts,
which is harder to notice than the reverse.

Recommend adapter updates when:

- A provider exposes a newer dated tool version or beta header.
- Official examples handle response fields the local adapter ignores.
- Smoke probes emit native actions not present in local constants.

Do not print API keys. Keep smoke tests non-destructive. Do not edit repo defaults or adapters unless the user
explicitly asks after reviewing the report.

## Updating CUA Support

All model and adapter support lives in `packages/ai` (`@onkernel/cua-ai`).

- **New model id, no native surface, no quirk**: nothing to do. It already works.
- **New model with a provider-native tool**: add a `CUA_NATIVE_SURFACES` entry in `packages/ai/src/models.ts`
  citing first-party documentation. Use a `family` match to cover numeric revisions and dated snapshots, or an
  `exact` match for a single id. Anthropic's surfaces are version-gated in
  `providers/anthropic/capabilities.ts` instead.
- **A model rejects a tool CUA sends**: add a `CUA_MODEL_QUIRKS` entry with the observed error as its `reason`.
- **New provider-native action, response field, or tool version**: update that provider's adapter under
  `packages/ai/src/providers/`. Anthropic's computer tool version and `computer-use-*` beta header are selected
  by pi-ai per model, so a new dated version usually means bumping `@earendil-works/pi-ai`.
- **A provider pi-ai does not carry**: it is not selectable. Adding one means registering a provider in
  `packages/ai/src/providers.ts`, which is a deliberate decision — the repo has removed four such providers
  rather than carry them unused.

Update `packages/ai/docs/supported-models.md` to match either table change. Then run `npm run typecheck`,
`npm test --workspace @onkernel/cua-ai`, and at least one live smoke per changed provider, for example
`CUA_MODEL=<provider>:<model> npm run example:quickstart --workspace @onkernel/cua-ai`.

## Reference Files

- `reference/README.md`: script usage and output overview.
- `reference/discover-models.ts`: provider metadata plus smoke-test orchestration.
- `reference/native-action-probe.ts`: live provider-native action elicitation.
- `reference/audit-official-examples.ts`: clone/update official examples and extract implementation evidence.
- `reference/provider-doc-drift.ts`: compare docs/examples/local constants for drift.
- `reference/report-schema.md`: normalized report fields and Markdown summary template.
