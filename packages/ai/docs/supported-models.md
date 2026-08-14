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

## Keeping these tables current

There is no periodic audit to run. The allowlist that once needed one is gone,
so maintenance is reactive — four cases, in rough order of how often they come up.

**A provider released a model.** Nothing to do. If pi-ai's registry carries it,
it resolves; if not, it is synthesized from its nearest sibling. Neither needs a
change here.

**The catalog looks stale.** Bump `@earendil-works/pi-ai`. Its registry is
generated from models.dev, so a newer pi-ai is how names, context windows, and
pricing get refreshed. Note that cua does not read pi's `models.json`: that is a
pi-coding-agent config file, and cua builds its `Models` collection from pi-ai
directly. A provider pi-ai does not ship is not selectable without registering
it in `src/providers.ts` — a deliberate decision, since the repo has removed
four such providers rather than carry them unused.

**A provider shipped or changed a native tool.** This is real adapter work, not
a table edit. Probe what the model actually emits:

```bash
npx tsx packages/ai/scripts/native-action-probe.ts --provider openai --model gpt-5.5 --limit 3
```

Update that provider's adapter under `src/providers/` to execute the actions the
probe returns, then add or adjust the `CUA_NATIVE_SURFACES` entry, citing the
provider's documentation. Anthropic's computer tool version and its
`computer-use-*` beta header are chosen by pi-ai per model, so a new dated
version there usually means bumping pi-ai rather than editing this package.

**A model rejects a tool CUA sends.** Add a `CUA_MODEL_QUIRKS` entry with the
observed error as its `reason`, scoped as narrowly as the evidence supports: a
single model id over a family, a family over a whole provider. Remove a quirk
when the provider lifts the limit — a stale quirk silently denies a model a tool
it now accepts, which is harder to notice than the reverse.
