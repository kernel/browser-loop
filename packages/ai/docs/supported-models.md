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

API: `openai-responses` · coordinates: pixel

Family matches (root + numeric revision/dated-snapshot suffixes):

- `gpt-5.4` ([docs](https://developers.openai.com/api/docs/models/gpt-5.4))
- `gpt-5.4-mini` ([docs](https://developers.openai.com/api/docs/models/gpt-5.4-mini))
- `gpt-5.5` ([docs](https://developers.openai.com/api/docs/models/gpt-5.5))

## `anthropic`

API: `anthropic-messages` · coordinates: pixel

Family matches (root + numeric revision/dated-snapshot suffixes):

- `claude-3-7-sonnet`
- `claude-opus-4`
- `claude-sonnet-4`
- `claude-sonnet-5`
- `claude-haiku-4`
- `claude-fable-5`

Source: [Anthropic computer use docs](https://docs.anthropic.com/en/docs/build-with-claude/computer-use).

## `google`

API: `google-generative-ai` · coordinates: normalized 0–999

Model refs use the `google:` prefix; `gemini:` is accepted as an alias.

Exact IDs:

- `gemini-3-flash-preview`
- `gemini-3.1-flash-lite`
- `gemini-3.5-flash`

`gemini-2.5-computer-use-preview-10-2025` is deliberately not annotated: it
rejects the standard function declarations this package sends and requires
Google's native `tools.computer_use` request wrapper instead.

Source: [Gemini computer use docs](https://ai.google.dev/gemini-api/docs/computer-use).

## `meta`

Coordinates: normalized 0–1000

Exact IDs:

- `muse-spark-1.1`

Muse Spark uses Meta's OpenAI-compatible Responses API with ordinary function
tools. CUA continues tool loops through `previous_response_id`.

Source: [Meta computer-use cookbook](https://dev.meta.ai/docs/getting-started/cookbook/computer-use-macos).

## `tzafon`

API: `tzafon-responses` · coordinates: normalized 0–999

Exact IDs:

- `tzafon.northstar-cua-fast` ([model card](https://huggingface.co/Tzafon/Northstar-CUA-Fast))
- `tzafon.northstar-cua-fast-1.6` ([model card](https://huggingface.co/Tzafon/Northstar-CUA-Fast))
- `tzafon.northstar-cua-fast-1.7-experiment` ([model card](https://huggingface.co/Tzafon/Northstar-CUA-Fast))

## `yutori`

API: `yutori-chat-completions` · coordinates: normalized 0–1000

Exact IDs:

- `n1-latest`
- `n1-20260203`
- `n1.5-latest`
- `n1.5-20260428`

Source: [Yutori Navigator reference](https://docs.yutori.com/reference/navigator).
