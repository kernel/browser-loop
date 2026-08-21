# Models and native surfaces

`@onkernel/browser-loop` accepts **any model pi-ai carries**, and any model id its
registry has not caught up with yet. There is no allowlist: a model id you pass
resolves, and the provider decides whether it exists. Run
`listLoopModels(provider?)` for the live catalog.

Two small tables in [`src/pi/models.ts`](https://github.com/kernel/browser-loop/blob/main/packages/browser-loop/src/pi/models.ts)
describe what is *different* about particular models. Neither decides whether a
model may run.

## Native surfaces

`COMPUTER_USE_NATIVE_SURFACES` records which models have a provider-native computer or
browser tool, so the tool menu can offer it and catalog compilation can refuse
it for a model the provider has not enabled it for — every provider answers 400
for that combination. Entries match either an exact id or
a `family` — the family root plus suffixes made of hyphen-separated numeric
segments, covering revisions and dated snapshots such as `claude-opus-4-7` or
`gpt-5.5-2026-04-23`. Named sibling variants like `gpt-5.4-mini` are distinct
models and need their own entry. Each cites first-party documentation.

| provider | models | surfaces |
| --- | --- | --- |
| `anthropic` | `claude-fable-5`, `claude-mythos-5`, `claude-opus-4-8`, `claude-opus-5`, `claude-sonnet-5` families | computer, browser |
| `openai` | `gpt-5.6-sol`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5` | computer |
| `google` | `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-2.5-computer-use-preview-10-2025` | browser |

Anthropic's entries live in `src/pi/providers/anthropic/capabilities.ts`, which is
version-gated separately; `computerUseNativeSurfaces(model)` reads both sources.

A model with no native surface is not restricted — it drives a Kernel browser
with Browser Loop's own CDP tools, which is the default for every provider.

## Quirks

`LOOP_MODEL_QUIRKS` records request-shape limits. Anything absent gets the
permissive default and is allowed to try; the provider's own error is the
feedback. Every entry exists because of a documented limit or an observed
failure, and carries its reason inline.

| provider | models | limit |
| --- | --- | --- |
| `moonshotai` | all | rejects the request once `browser_act`'s schema is attached |
| `moonshotai` | `kimi-k3` | serializes state mutations |
| `openrouter` | `moonshotai/kimi-k3` | the same Kimi limits, reached through OpenRouter |
| `openrouter` | `meta/muse-spark-1.1` | serializes state mutations |
| `xai` | all | serializes state mutations |

Google is absent on purpose: the Gemini function-declaration dialect is a subset
of JSON Schema, and a payload transform rewrites `const` and
`additionalProperties` into what it accepts, so no tool has to be withheld.

`loopModelCapabilities(model)` applies provider-wide quirks first, then
model-specific ones. `loopModelQuirks(model)` returns the entries that applied,
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
pricing get refreshed. Note that this package does not read pi's `models.json`: that is a
pi-coding-agent config file, and `createLoopModels()` builds its `Models`
collection from pi-ai directly. A provider pi-ai does not ship is not selectable without registering
it in `src/pi/providers.ts` — a deliberate decision, since the repo has removed
four such providers rather than carry them unused.

**A provider shipped or changed a native tool.** This is real adapter work, not
a table edit. Probe what the model actually emits:

```bash
npx tsx packages/browser-loop/scripts/native-action-probe.ts --provider openai --model gpt-5.5 --limit 3
```

Update that provider's adapter under `src/pi/providers/` to execute the actions the
probe returns, then add or adjust the `COMPUTER_USE_NATIVE_SURFACES` entry, citing the
provider's documentation. Anthropic's GA client toolsets are adapted in
`src/pi/providers/anthropic/toolsets.ts`; a new dated toolset version requires
updating its declarations and member transcript adapter together.

**A model rejects a tool Browser Loop sends.** Add a `LOOP_MODEL_QUIRKS` entry with the
observed error as its `reason`, scoped as narrowly as the evidence supports: a
single model id over a family, a family over a whole provider. Remove a quirk
when the provider lifts the limit — a stale quirk silently denies a model a tool
it now accepts, which is harder to notice than the reverse.
