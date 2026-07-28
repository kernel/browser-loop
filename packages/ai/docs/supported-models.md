# Supported CUA Models

`@onkernel/cua-ai` accepts any pi-ai model whose ID is annotated as
CUA-supporting in `CUA_MODEL_ANNOTATIONS` (see
[`src/models.ts`](https://github.com/kernel/cua/blob/main/packages/ai/src/models.ts)).
Annotations are either a `family`
match or an `exact` ID match. A family match covers the family root plus
suffixes made of hyphen-separated numeric segments — revisions and dated
snapshots such as `claude-opus-4-7`, `gpt-5.5-2026-04-23`, or
`claude-3-7-sonnet-20250219`. Named sibling variants like `gpt-5.4-mini`
are distinct models that may not support computer use, so they need their
own annotation. Each annotation cites the provider's CUA docs.

The list below is the current snapshot. Run
`listCuaModels(provider?)` for the live list — it merges pi-ai's registry
with CUA-only entries that pi-ai does not ship yet.

## `openai`

Default interaction: CUA browser tools. The optional native computer tool uses
pixel coordinates.

Exact IDs:

- `gpt-5.6-sol` ([docs](https://developers.openai.com/api/docs/models/gpt-5.6-sol))

Family matches (root + numeric revision/dated-snapshot suffixes):

- `gpt-5.4` ([docs](https://developers.openai.com/api/docs/models/gpt-5.4))
- `gpt-5.4-mini` ([docs](https://developers.openai.com/api/docs/models/gpt-5.4-mini))
- `gpt-5.5` ([docs](https://developers.openai.com/api/docs/models/gpt-5.5))

## `anthropic`

Default interaction: native `browser_20260701` on supported model families,
with the CUA browser toolset as the model-compatibility fallback. If the active
credential cannot access the native browser beta, CUA uses its equivalent
function-tool transport. The optional native computer tool uses pixel
coordinates.

Family matches (root + numeric revision/dated-snapshot suffixes):

- `claude-3-7-sonnet`
- `claude-opus-4`
- `claude-opus-5`
- `claude-sonnet-4`
- `claude-sonnet-5`
- `claude-haiku-4`
- `claude-fable-5`

Source: [Anthropic computer use docs](https://docs.anthropic.com/en/docs/build-with-claude/computer-use).

## `google`

Coordinates: normalized 0–999

Model refs use the `google:` prefix; `gemini:` is accepted as an alias.

Exact IDs:

- `gemini-3-flash-preview`
- `gemini-3.1-flash-lite`
- `gemini-3.5-flash`

Current Gemini 3.x computer use is configured explicitly with
`cua.providers.google.toolsets.browser()`, which emits Google's native
`tools.computer_use` declaration and current predefined action names. To keep
partial catalogs exact when Gemini 3 preview endpoints surface legacy names,
the declaration excludes unselected functions across both published
vocabularies without installing legacy helpers.
`gemini-2.5-computer-use-preview-10-2025` is deliberately absent from the
curated model list because it is legacy; callers supplying a concrete legacy
pi model may pair it with `cua.providers.google.toolsets.legacyBrowser()`.

Source: [Gemini computer use docs](https://ai.google.dev/gemini-api/docs/computer-use).

## `meta`

Default interaction: CUA browser tools.

Exact IDs:

- `muse-spark-1.1`

Muse Spark uses Meta's OpenAI-compatible Responses API with ordinary function
tools. CUA continues tool loops through `previous_response_id`.

Source: [Meta computer-use cookbook](https://dev.meta.ai/docs/getting-started/cookbook/computer-use-macos).

## `xai`

Default interaction: CUA browser tools.

Exact IDs:

- `grok-4.5`

Grok 4.5 uses xAI's OpenAI-compatible Responses API with ordinary CUA browser
function tools. xAI does not define a native computer tool. Tool loops continue
through `previous_response_id`.
CUA adds xAI's doubled token-price tier above 200k input tokens to pi-ai's
Grok 4.5 model metadata.

Source: [Grok 4.5 docs](https://docs.x.ai/developers/grok-4-5), [function calling](https://docs.x.ai/developers/tools/function-calling), and [image understanding](https://docs.x.ai/developers/model-capabilities/images/understanding).

## `moonshotai`

Default interaction: CUA browser tools.

Model refs use the `moonshotai:` prefix; `moonshot:` is accepted as an alias.

Exact IDs:

- `kimi-k3`

Kimi K3 uses Moonshot's OpenAI-compatible chat completions API with ordinary
CUA browser function tools. Moonshot does not define a native computer tool.
K3 launched with max-only thinking effort—other levels are clamped away until
Moonshot ships them.

Source: [Kimi K3 announcement](https://www.kimi.com/blog/kimi-k3), [tool use](https://platform.kimi.ai/docs/api/tool-use), and [vision input](https://platform.kimi.ai/docs/guide/use-kimi-vision-model).

## `tzafon`

Coordinates: normalized 0–999

Exact IDs:

- `tzafon.northstar-cua-fast` ([model card](https://huggingface.co/Tzafon/Northstar-CUA-Fast))
- `tzafon.northstar-cua-fast-1.6` ([model card](https://huggingface.co/Tzafon/Northstar-CUA-Fast))
- `tzafon.northstar-cua-fast-1.7-experiment` ([model card](https://huggingface.co/Tzafon/Northstar-CUA-Fast))

## `yutori`

Coordinates: normalized 0–1000

Exact IDs:

- `n1-latest`
- `n1-20260203`
- `n1.5-latest`
- `n1.5-20260428`

Source: [Yutori Navigator reference](https://docs.yutori.com/reference/navigator).
