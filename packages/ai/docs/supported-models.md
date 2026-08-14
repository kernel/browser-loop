# Models and native surfaces

`@onkernel/cua-ai` accepts **any model pi-ai carries**, and any model id its
registry has not caught up with yet. There is no allowlist: a model id you pass
resolves, and the provider decides whether it exists. Run
`listCuaModels(provider?)` for the live catalog.

Two small tables in [`src/models.ts`](https://github.com/kernel/cua/blob/main/packages/ai/src/models.ts)
describe what is *different* about particular models. Neither decides whether a
model may run.

## Native surfaces

`CUA_NATIVE_SURFACES` records which models have a provider-native computer or
browser tool, so the tool menu can offer it. Entries match either an exact id or
a `family` — the family root plus suffixes made of hyphen-separated numeric
segments, covering revisions and dated snapshots such as `claude-opus-4-7` or
`gpt-5.5-2026-04-23`. Named sibling variants like `gpt-5.4-mini` are distinct
models and need their own entry. Each cites first-party documentation.

| provider | models | surfaces |
| --- | --- | --- |
| `anthropic` | `claude-opus-4-8`, `claude-opus-5`, `claude-sonnet-5` families | computer, browser |
| `anthropic` | `claude-fable-5` family | computer |
| `openai` | `gpt-5.6-sol`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5` | computer |
| `google` | `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite` | browser |

Anthropic's entries live in `providers/anthropic/capabilities.ts`, which is
version-gated separately; `cuaNativeSurfaces(model)` reads both sources.

A model with no native surface is not restricted — it drives a Kernel browser
with CUA's own CDP tools, which is the default for every provider.

## Quirks

`CUA_MODEL_QUIRKS` records request-shape limits. Anything absent gets the
permissive default and is allowed to try; the provider's own error is the
feedback. Every entry exists because of a documented limit or an observed
failure, and carries its reason inline.

| provider | models | limit |
| --- | --- | --- |
| `google` | all | rejects `browser_wait_for`'s schema shape; the Gemini API accepts a subset of JSON Schema for function declarations |
| `moonshotai` | `kimi-k3` | rejects the request once `browser_act`'s schema is attached; serializes state mutations |
| `openrouter` | `moonshotai/kimi-k3` | the same Kimi limit, reached through OpenRouter |
| `openrouter` | `meta/muse-spark-1.1` | serializes state mutations |
| `xai` | all | serializes state mutations |

`cuaModelCapabilities(model)` applies provider-wide quirks first, then
model-specific ones. `cuaModelQuirks(model)` returns the entries that applied,
for diagnostics and menu hints.

## Model ids pi-ai does not carry

A ref whose id is missing from the registry is synthesized from the sibling
sharing the longest id prefix, preferring the latest such sibling. Providers
migrate transports mid-generation — xAI carries `grok-4.3` on chat completions
and `grok-4.5` on Responses — so a new id follows its nearest, newest relative.
This is what lets a model work the day the provider ships it rather than when
models.dev catches up.

Only an unqualified ref or a provider pi-ai does not carry is refused.
