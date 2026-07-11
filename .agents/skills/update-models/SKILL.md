---
name: update-models
description: Discover latest OpenAI, Anthropic, Google/Gemini, Meta, Tzafon, and Yutori models and verify computer-use support. Use when updating CUA model defaults, checking new model releases, auditing provider-native computer tool actions, or comparing provider metadata, official examples, and smoke-test results.
---

# Update Models

Use this workflow to keep CUA current with provider model releases and computer-use support. Do not trust a static model list: combine provider metadata, official docs, official example repos, and live non-destructive smoke tests.

## Quick Start

1. Verify credentials are available: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` or `GEMINI_API_KEY`, `META_MODEL_API_KEY` or `MODEL_API_KEY`, `TZAFON_API_KEY`, and `YUTORI_API_KEY`.
2. If credentials live in `~/AGENTS.md`, load them into the current shell without printing them:

```bash
eval "$(python3 - <<'PY'
import pathlib, re, shlex
text = pathlib.Path('~/AGENTS.md').expanduser().read_text()
for key in ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'META_MODEL_API_KEY', 'MODEL_API_KEY', 'TZAFON_API_KEY', 'YUTORI_API_KEY']:
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

- Live provider availability: `reference/discover-models.ts` uses provider APIs and docs (`OpenAI().models.list()`, `Anthropic().models.list({ limit: 1000 })`, `GoogleGenAI().models.list()` / documented Gemini computer-use IDs, Tzafon's `Lightcone().models.list()` with known-model fallback, and Yutori OpenAPI/docs model enums) to discover what the current API key can access.
- CUA-supported refs: `listCuaModels(provider?)` from `@onkernel/cua-ai` reads `packages/ai/src/models.ts` and returns the provider-qualified refs CUA accepts (e.g. `anthropic:claude-opus-4-7`). The `CUA_MODEL_ANNOTATIONS` table there is also what `getCuaModel()` and runtime provider routing use.

When live discovery finds a new model with passing smoke tests, update `packages/ai/src/models.ts`; then verify it appears in `listCuaModels("<provider>")`.

## Provider Checks

Meta:

- Discover with the OpenAI SDK against `https://api.meta.ai/v1` using `META_MODEL_API_KEY` (or Meta's documented `MODEL_API_KEY` alias).
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

Tzafon:

- Discover with `new Lightcone({ apiKey }).models.list()` from `@tzafon/lightcone` when available.
- If model listing is unavailable or returns an undocumented shape, record the error/shape and fall back to known smoke-test candidates such as `tzafon.northstar-cua-fast`.
- Smoke-test `responses.create` with explicit function tools matching the Tzafon template: `click`, `double_click`, `point_and_type`, `key`, `scroll`, `drag`, and `done`.
- Pass condition: response output contains `type: "function_call"` with one of those tool names, or a documented `computer_call` action if Lightcone switches to native computer-use output.
- Track coordinate convention separately from Gemini/Yutori: Tzafon uses a 0-999 grid.

Yutori:

- Discover model IDs from `https://docs.yutori.com/openapi.json` plus the Navigator docs. Current expected IDs include `n1.5-latest`, `n1.5-20260428`, `n1-latest`, and `n1-20260203`.
- Smoke-test the OpenAI-compatible `chat.completions` endpoint with `baseURL: "https://api.yutori.com/v1"` and `YUTORI_API_KEY`.
- Pass condition: response `choices[0].message.tool_calls[]` contains browser action function names such as `left_click`, `goto_url`, `type`, `scroll`, or `wait`.
- Track action-space differences between n1 and n1.5. n1 uses the legacy fixed tool set; n1.5 supports `tool_set`, `disable_tools`, expanded actions, and structured JSON output.
- Do not send duplicate browser action schemas when testing local CUA behavior. The local adapter registers matching AgentTools for execution but filters Yutori's built-in browser tool definitions out of the outbound API payload.

## Native Action Discovery

Run action probes when updating adapters or when docs/examples show drift:

```bash
npx tsx .agents/skills/update-models/reference/discover-models.ts --provider meta --models muse-spark-1.1
npx tsx .agents/skills/update-models/reference/native-action-probe.ts --provider openai --model gpt-5.5
npx tsx .agents/skills/update-models/reference/native-action-probe.ts --provider anthropic --model claude-opus-4-7
npx tsx .agents/skills/update-models/reference/native-action-probe.ts --provider gemini --model gemini-3-flash-preview
npx tsx .agents/skills/update-models/reference/native-action-probe.ts --provider tzafon --model tzafon.northstar-cua-fast
npx tsx .agents/skills/update-models/reference/native-action-probe.ts --provider yutori --model n1.5-latest
```

The probe does not execute browser actions. It elicits tool calls for screenshot, click, type, keypress, scroll, drag, hover/move, wait, back/forward, and navigation. Compare:

- `documented_actions`: extracted from provider docs or SDK source.
- `example_repo_actions`: extracted from official examples.
- `observed_actions`: emitted by live smoke probes.
- `repo_supported_actions`: local adapter constants.
- `unknown_observed_actions`: actions emitted by providers but not supported locally.

## Decision Rules

Recommend a model as CUA-supported only if:

- It appears in the provider metadata API for the available key.
- Its model-specific docs do not rule out required CUA runtime features such as streaming.
- Its provider-native computer-use smoke test passes.
- Its local cua-ai smoke test emits a computer tool call: `CUA_MODEL=<provider>:<model> npm run example:quickstart --workspace @onkernel/cua-ai` returns a `toolCall` block.
- Official docs or examples support the same tool mechanism, or the smoke result clearly supersedes stale docs.
- The model is annotated in `CUA_MODEL_ANNOTATIONS` in `packages/ai/src/models.ts`, resolved from `pi-ai`'s registry or backed by a `CUA_MODEL_OVERRIDES` entry.

Recommend adapter updates when:

- A provider exposes a newer dated tool version or beta header.
- Official examples handle response fields the local adapter ignores.
- Smoke probes emit native actions not present in local constants.

Do not print API keys. Keep smoke tests non-destructive. Do not edit repo defaults or adapters unless the user explicitly asks after reviewing the report.

## Updating CUA Support

All CUA model and adapter support lives in `packages/ai` (`@onkernel/cua-ai`). When a new model is discovered, decide which layer needs changing:

- New model ID, same provider/tool surface:
  - Add a `CUA_MODEL_ANNOTATIONS` entry in `packages/ai/src/models.ts` under the correct provider, citing the official source that documents computer-use support. Use a `family` match for a root that covers numeric revisions and dated snapshots (e.g. `claude-opus-4`), or an `exact` match for a single ID. A model already covered by an existing family annotation needs no change.
  - If `pi-ai`'s registry does not carry the ID yet (`pi_ai_registry: "missing"` in the discovery report), add a `CUA_MODEL_OVERRIDES` entry so `getCuaModel()` can return a provider-shaped model. When the ID is already in the registry, the annotation alone is enough.
  - Update the snapshot in `packages/ai/docs/supported-models.md` to match.

- New provider-native action, response field, or tool version:
  - Meta: update `packages/ai/src/providers/meta/index.ts` and `provider.ts`, including Responses threading and reasoning compatibility.
  - OpenAI: update `packages/ai/src/providers/openai/index.ts` and its action vocabulary, plus the shared canonical types in `packages/ai/src/providers/common.ts` if the action set changes.
  - Anthropic: update the `ANTHROPIC_CUA_ACTION_TYPES` set in `packages/ai/src/providers/anthropic/actions.ts` and `index.ts`. The computer tool version and `computer-use-*` beta header are selected by `pi-ai` per model, so a new dated tool version usually means bumping `@earendil-works/pi-ai`, not editing this package.
  - Gemini: update `packages/ai/src/providers/gemini/index.ts`, including coordinate handling if needed.
  - Tzafon: update `packages/ai/src/providers/tzafon/index.ts` and `provider.ts`, including coordinate/action handling.
  - Yutori: update `packages/ai/src/providers/yutori/actions.ts`, `index.ts`, and `provider.ts`, including payload filtering and coordinate/action handling.
  - Shared canonical action semantics go in `packages/ai/src/providers/common.ts`.

- New provider or routing rule:
  - Update `CuaProvider`, `CUA_PROVIDERS`, `CUA_MODEL_ANNOTATIONS`, and `CUA_MODEL_OVERRIDES` in `packages/ai/src/models.ts`, plus the provider-module wiring in `packages/ai/src/providers.ts`.

After changing support, run `npm run typecheck`, `npm test --workspace @onkernel/cua-ai`, and at least one live smoke per changed provider, for example `CUA_MODEL=<provider>:<model> npm run example:quickstart --workspace @onkernel/cua-ai`.

## Reference Files

- `reference/README.md`: script usage and output overview.
- `reference/discover-models.ts`: provider metadata plus smoke-test orchestration.
- `reference/native-action-probe.ts`: live provider-native action elicitation.
- `reference/audit-official-examples.ts`: clone/update official examples and extract implementation evidence.
- `reference/provider-doc-drift.ts`: compare docs/examples/local constants for drift.
- `reference/report-schema.md`: normalized report fields and Markdown summary template.
