# `@onkernel/cua-ai`

Extension of [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)'s
unified LLM API with computer-use specific models, providers, and tool schemas
for building CUA agents on Kernel.

## Installation

```bash
npm install @onkernel/cua-ai
```

## Prerequisites

You need an API key for each provider you call. The helpers in this package
check these environment variables, in order:

| Provider    | Environment variables (checked in order)    |
| ----------- | ------------------------------------------- |
| `openai`    | `OPENAI_API_KEY`                            |
| `anthropic` | `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` |
| `google`    | `GOOGLE_API_KEY`, `GEMINI_API_KEY`          |
| `meta`      | `META_API_KEY`                              |
| `xai`       | `XAI_API_KEY`                               |
| `moonshotai` | `MOONSHOT_API_KEY`                         |
| `tzafon`    | `TZAFON_API_KEY`                            |
| `yutori`    | `YUTORI_API_KEY`                            |

The exported helpers wrap this table:

- `cuaApiKeyEnvVarsForProvider(provider)` — the env var names for a provider
  (accepts `"gemini"` as an alias for `"google"`).
- `getCuaEnvApiKey(provider)` — read the key, or `undefined` when unset.
- `requireCuaEnvApiKey(provider)` — read the key, or throw naming the
  variables to set.
- `getCuaEnvApiKeyForModel(refOrModel)` / `requireCuaEnvApiKeyForModel(refOrModel)`
  — the same, keyed by a model ref like `"openai:gpt-5.5"` or a concrete
  `Model<Api>`.

Pass the resolved key as the `apiKey` stream option (as in the Quick Start
below) so a missing key fails loudly before any request is made. If you omit
`apiKey`, the `cuaModels()` collection resolves auth per provider from the
same table above.

## Quick Start

```ts
import { readFile } from "node:fs/promises";
import { cuaModels, getCuaModel, openai, requireCuaEnvApiKeyForModel } from "@onkernel/cua-ai";

const model = getCuaModel("openai:gpt-5.5");
const apiKey = requireCuaEnvApiKeyForModel("openai:gpt-5.5"); // throws unless OPENAI_API_KEY is set

// Any screenshot of the page you want to act on, resolved relative to this
// module so the snippet does not depend on the process working directory.
const screenshot = await readFile(new URL("./screenshot.png", import.meta.url));

// The default CUA model collection: pi's builtin providers plus Kernel's
// computer-use providers. Use createCuaModels() for an isolated collection.
const models = cuaModels();

const response = await models.complete(
  model,
  {
    systemPrompt: "You are a browser automation agent.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Click the sign in / up link in this screenshot." },
          { type: "image", data: screenshot.toString("base64"), mimeType: "image/png" },
        ],
        timestamp: Date.now(),
      },
    ],
    tools: openai.computerTools({ actions: ["click"] }),
  },
  { apiKey },
);

if (response.stopReason === "error" || response.stopReason === "aborted") {
  throw new Error(response.errorMessage ?? `request ended with stopReason "${response.stopReason}"`);
}

for (const block of response.content) {
  if (block.type === "toolCall" && block.name === "click") {
    console.log("click:", block.arguments);
  }
}
```

A runnable version ships at [`examples/quickstart.ts`](./examples/quickstart.ts)
(with a sample screenshot). In this repo, run it from `packages/ai` with
`npm run example:quickstart`; switch providers with the `CUA_MODEL` env var,
e.g. `CUA_MODEL=anthropic:claude-opus-5`.

## Error Handling

pi-ai's `complete()` and `stream()` methods **resolve instead of throwing**
when a request fails. The returned `AssistantMessage` carries the outcome on
`stopReason`:

- `"stop"`, `"length"`, `"toolUse"` — success; `content` holds the response.
- `"error"` — the provider call failed (bad API key, no model access, network
  error, …). `content` is empty and `errorMessage` holds the provider error.
- `"aborted"` — the request was cancelled via the `signal` stream option.

Always check `stopReason` before reading `content` — otherwise a typo'd API
key looks like a successful run that produced nothing:

```ts
if (response.stopReason === "error" || response.stopReason === "aborted") {
  throw new Error(response.errorMessage ?? `request ended with stopReason "${response.stopReason}"`);
}
```

`getCuaModel()`, `requireCuaEnvApiKey*()`, and `computerTools({ actions })`
validate eagerly and throw regular errors.

## Continuing the Loop

[`@onkernel/cua-agent`](https://www.npmjs.com/package/@onkernel/cua-agent)
runs this loop for you — `CuaAgent`/`CuaAgentHarness` classes with browser
execution against a Kernel browser. Reach for it first; the rest of this
section is for driving the loop yourself against your own browser stack.

A computer-use session is a loop: the model calls a tool, you execute it
against a real browser, and you send the result (with a fresh screenshot) back
so the model can plan the next step. Tool results are pi-ai
`ToolResultMessage`s:

```ts
type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string; // ToolCall.id from the assistant message
  toolName: string;   // ToolCall.name
  content: (TextContent | ImageContent)[];
  details?: unknown;  // optional executor metadata, not sent to the model
  isError: boolean;
  timestamp: number;
};
```

A minimal two-turn loop:

```ts
import { cuaModels, getCuaModel, openai, requireCuaEnvApiKeyForModel, type Message } from "@onkernel/cua-ai";

const models = cuaModels();
const model = getCuaModel("openai:gpt-5.5");
const apiKey = requireCuaEnvApiKeyForModel("openai:gpt-5.5");
const tools = openai.computerTools({ actions: ["click", "type", "screenshot"] });

const messages: Message[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "Click the sign in / up link in this screenshot." },
      { type: "image", data: screenshotBase64, mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  },
];

// Turn 1: the model responds with tool calls.
const first = await models.complete(model, { messages, tools }, { apiKey });
if (first.stopReason === "error" || first.stopReason === "aborted") {
  throw new Error(first.errorMessage);
}
messages.push(first); // the AssistantMessage joins the transcript as-is

// Execute each tool call against your browser stack, then append a
// toolResult message carrying a fresh screenshot.
for (const block of first.content) {
  if (block.type !== "toolCall") continue;
  const freshScreenshotBase64 = await runInYourBrowser(block.name, block.arguments);
  messages.push({
    role: "toolResult",
    toolCallId: block.id,
    toolName: block.name,
    content: [
      { type: "text", text: "done" },
      { type: "image", data: freshScreenshotBase64, mimeType: "image/png" },
    ],
    isError: false,
    timestamp: Date.now(),
  });
}

// Turn 2: the model sees the results and plans the next action.
const second = await models.complete(model, { messages, tools }, { apiKey });
```

## Core Concepts

`@onkernel/cua-ai` re-exports the full surface of
[`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai)
(`export * from "@earendil-works/pi-ai"`), including the core primitives:
`Model`, `Context`, `Message`, `Tool`, `Models`, `createModels`,
`createProvider`, `Type`, `Static`, `TSchema`, and the event/validation
helpers. Requests stream through a pi `Models` collection — use
`cuaModels()` (or build your own with `createCuaModels()`) and call
`complete`/`stream`/`completeSimple`/`streamSimple` on it. Some familiarity
with pi-ai is assumed; Kernel adds the computer-use model catalog and
provider/tool metadata.

### Model Refs

`getCuaModel()` accepts only provider-qualified model refs of the form
`<provider>:<model-id>`:

```ts
getCuaModel("openai:gpt-5.5");
getCuaModel("anthropic:claude-opus-5");
getCuaModel("google:gemini-3-flash-preview");
getCuaModel("meta:muse-spark-1.1");
getCuaModel("xai:grok-4.5");
getCuaModel("moonshotai:kimi-k3"); // "moonshot:" is accepted as an alias
getCuaModel("tzafon:tzafon.northstar-cua-fast");
getCuaModel("yutori:n1.5-latest");
```

`getCuaModel(ref)` returns a pi-ai `Model<Api>` you can pass to
`cuaModels().complete()` or `cuaModels().stream()`. It throws when the ref
names a model without a CUA-support annotation.

See [`docs/supported-models.md`](./docs/supported-models.md) for the current
list of CUA-supporting models per provider.

### CuaProvider

`CuaProvider` is the string union of provider IDs this package targets:

```ts
type CuaProvider = "openai" | "anthropic" | "google" | "meta" | "xai" | "moonshotai" | "tzafon" | "yutori";
```

The IDs match pi-ai's `Model.provider` values exactly. `providerForModel(model)`
narrows a pi-ai `Model<Api>` to a `CuaProvider`.

### Listing Models

`listCuaModels(provider?)` returns every CUA-supporting model, optionally
filtered to one provider:

```ts
interface CuaModelInfo {
  ref: CuaModelRef;
  provider: CuaProvider;
  model: string;
  name: string;
}
```

## Exports

Everything below is importable from the package root. pi-ai's full surface is
re-exported alongside (see [Core Concepts](#core-concepts)).

### Models and refs

- `getCuaModel(ref: CuaModelRef): Model<Api>`
- `listCuaModels(provider?: CuaProvider): CuaModelInfo[]`
- `parseCuaModelRef(ref: string): { provider: CuaProvider; model: string }` —
  accepts the `"gemini:"` alias
- `formatCuaModelRef(provider, model): CuaModelRef`
- `providerForModel(model: Model<Api>): CuaProvider`
- `isCuaProvider(value: string): value is CuaProvider`
- `findCuaAnnotation(provider, modelId): CuaModelAnnotation | undefined`
- `CUA_PROVIDERS: readonly CuaProvider[]`
- `CUA_MODEL_ANNOTATIONS: Record<CuaProvider, readonly CuaModelAnnotation[]>` —
  the source-cited support table
- Types: `CuaProvider`, `CuaModelRef`, `CuaModelInfo`, `CuaModelAnnotation`,
  `CuaModelMatch`

### API keys

- `cuaApiKeyEnvVarsForProvider(provider): readonly string[]`
- `getCuaEnvApiKey(provider): string | undefined`
- `requireCuaEnvApiKey(provider): string`
- `getCuaEnvApiKeyForModel(refOrModel): string | undefined`
- `requireCuaEnvApiKeyForModel(refOrModel): string`

### Runtime specs

- `resolveCuaRuntimeSpec(input: CuaModelRef | Model<Api>, options?: ComputerToolsOptions): CuaRuntimeSpec`
- Types: `CuaRuntimeSpec`, `CuaRuntimeSpecInput`, `CuaProviderModule`,
  `CuaScreenshotSpec`, `CuaScreenshotTransformSpec`, `CuaPayloadHook`,
  `CuaPayloadContext`

`resolveCuaRuntimeSpec()` centralizes provider-specific defaults for
runtime consumers:

- canonical provider id
- provider-facing CUA tool definitions used in model requests
- local execution adapters used by `CuaAgent`/`CuaAgentHarness`
- default system prompt text
- provider coordinate convention
- optional provider screenshot input policy
- optional provider payload middleware (for protocol quirks)

Pass `options` (e.g. `{ actions: ["click"] }`) to narrow the resolved tool
definitions and executors; it is forwarded to the provider module's
`toolDefinitions()`/`toolExecutors()`, so providers with a restricted subset
(Anthropic, Yutori) throw on unsupported actions.

### Canonical actions and tools

- `CUA_ACTION_TYPES: readonly CuaActionType[]` — the 16 canonical action names
- `computerTools(options?: ComputerToolsOptions): Tool[]` /
  `createCuaActionToolDefinitions(actions?)` — one `Tool` per canonical action
  (the full canonical superset; provider namespaces apply provider defaults
  and validation on top)
- `computerToolExecutors(options?)` / `createCuaActionToolExecutors(actions?)`
  — matching `CuaToolExecutorSpec[]` execution adapters
- `createCuaActionSchema(actions?)`, `CuaActionSchema` — TypeBox union schema
- `createCuaBatchSchema(actions?)`, `CuaBatchSchema`,
  `createCuaBatchToolDefinition(actions?, options?)`,
  `createCuaBatchToolExecutor(actions?, options?)`,
  `CUA_BATCH_TOOL_NAME` (`"computer_batch"`), `CUA_BATCH_TOOL_DESCRIPTION`
- `createCuaNavigationToolDefinition()`, `CuaNavigationSchema`,
  `CUA_NAVIGATION_TOOL_NAME` (`"computer_use_extra"`),
  `CUA_NAVIGATION_TOOL_DESCRIPTION`
- `createCuaPlaywrightToolDefinition()`, `CuaPlaywrightSchema`,
  `CUA_PLAYWRIGHT_TOOL_NAME` (`"playwright_execute"`),
  `CUA_PLAYWRIGHT_TOOL_DESCRIPTION`
- `canonicalToolCallName(action)`, `canonicalToolCallArguments(action)` — map
  a normalized `CuaAction` back to its tool-call name/arguments
- `normalizeGotoUrl(value)` — prefix bare hostnames with `https://`
- Types: `CuaAction` (plus the 16 per-action interfaces), `CuaActionType`,
  `CuaMouseButton`, `CuaDragMouseButton`, `CuaBatchInput`,
  `CuaNavigationInput`, `CuaPlaywrightInput`, `CuaToolExecutorSpec`, `ComputerToolsOptions`,
  `ComputerToolCoordinateSystem`

### Model collections

- `createCuaModels(options?): MutableModels` — build a pi `Models` collection
  with pi's builtin providers plus CUA's adjustments: OpenAI models route
  through cua's `openai-cua-responses` stream (threads
  `previous_response_id`), Google resolves `GOOGLE_API_KEY` or
  `GEMINI_API_KEY`, xAI Grok 4.5 routes through a stateful Responses stream,
  and the Meta/Tzafon/Yutori providers are registered. Each call returns an
  independent collection.
- `cuaModels(): MutableModels` — the shared default collection, created on
  first use. `CuaAgent` and `CuaAgentHarness` stream through it unless given
  another one.

## Provider Tools

Provider namespaces expose `computerTools({ actions? })` for
building the provider's default CUA `Tool[]` definitions. These are the tools
sent to the model when you call `cuaModels().complete()` or
`cuaModels().stream()` directly. The
default set can differ by provider: Anthropic includes its `computer_batch`
tool from the computer-use best-practices reference, while providers such as
OpenAI currently expose individual canonical browser actions. Omit `actions`
for the provider's default computer tool set, or pass an action subset to narrow
the schema for a single `complete()` call:

```ts
import { openai } from "@onkernel/cua-ai";

const allComputerTools = openai.computerTools();
const clickOnlyTools = openai.computerTools({ actions: ["click"] });
```

When `actions` is provided, it must be a subset of that provider's supported
canonical action set; unsupported actions throw (e.g.
`anthropic.computerTools({ actions: ["back"] })` throws
`unsupported Anthropic canonical action(s): back`).

Per-provider canonical action subsets (each namespace exports its list as
`<PROVIDER>_CUA_ACTION_TYPES`):

| Namespace   | Canonical actions                                                                  |
| ----------- | ---------------------------------------------------------------------------------- |
| `openai`    | all 16                                                                              |
| `anthropic` | 13 — everything except `back`, `forward`, `url`; adds `computer_batch` by default  |
| `gemini`    | all 16                                                                              |
| `meta`      | all 16                                                                              |
| `xai`       | all 16                                                                              |
| `moonshot`  | all 16                                                                              |
| `tzafon`    | all 16 (replaced on the wire by Tzafon's native `computer_use` tool)                |
| `yutori`    | 13 — everything except `screenshot`, `url`, `cursor_position` (local mirrors only)  |

Runtime specs also include `toolExecutors`: provider-owned adapters that use
the same tool-call names as the model-facing tools and translate their
arguments into canonical CUA actions for `@onkernel/cua-agent`. For most
providers, `toolDefinitions` and `toolExecutors` line up one-for-one. Some
providers are different on the wire: Yutori exposes browser actions through its
documented `tool_set` request field, so its runtime spec has no model-facing
`toolDefinitions` (`yutori.providerModule.toolDefinitions()` is `[]`) but
still provides local `toolExecutors` for the canonical actions emitted after
Yutori's native tool calls are normalized. `yutori.computerTools()` builds
local mirrors of those canonical tools — they are never sent to the API
(`streamYutori` strips them from the outbound payload) and exist so the
normalized tool calls have matching local definitions/executors. Caller-provided
tools that should remain on the provider payload can be preserved by payload
middleware via `CuaPayloadContext.keepToolNames`.

Provider namespaces also expose `coordinateSystem()`, which returns the
coordinates the provider's computer tool calls are expected to emit:

```ts
openai.coordinateSystem()
// { type: "pixel" }

gemini.coordinateSystem()
// { type: "normalized", range: [0, 999] }
```

Current coordinate contracts:

- `openai`: pixel coordinates
- `anthropic`: pixel coordinates, matching Anthropic's computer-use quickstart
- `gemini`: normalized coordinates in the 0-999 range ([source](https://ai.google.dev/gemini-api/docs/computer-use))
- `meta`: normalized coordinates in the 0-1000 range ([source](https://dev.meta.ai/docs/getting-started/cookbook/computer-use-macos))
- `xai`: CUA-defined normalized coordinates in the 0-1000 range; Grok exposes image input and function calling rather than a native coordinate protocol ([source](https://docs.x.ai/developers/grok-4-5))
- `moonshot`: CUA-defined normalized coordinates as 0-1 fractions; Kimi's visual grounding natively emits width/height fractions and Moonshot documents function calling and image input rather than a coordinate protocol ([source](https://platform.kimi.ai/docs/api/tool-use))
- `yutori`: normalized coordinates in the 0-1000 range ([source](https://docs.yutori.com/reference/navigator), [SDK helper](https://github.com/yutori-ai/yutori-sdk-python/blob/main/yutori/navigator/coordinates.py))
- `tzafon`: normalized coordinates in the 0-999 range ([source](https://docs.lightcone.ai/guides/coordinates/), [model card](https://huggingface.co/Tzafon/Northstar-CUA-Fast))

The action vocabulary is intentionally provider-neutral and OpenAI-shaped
because it maps cleanly to most browser computer-use APIs:

```ts
type CuaAction =
  | CuaActionClick
  | CuaActionDoubleClick
  | CuaActionMouseDown
  | CuaActionMouseUp
  | CuaActionTypeText
  | CuaActionKeypress
  | CuaActionScroll
  | CuaActionMove
  | CuaActionDrag
  | CuaActionWait
  | CuaActionScreenshot
  | CuaActionGoto
  | CuaActionBack
  | CuaActionForward
  | CuaActionUrl
  | CuaActionCursorPosition;
```

For example:

```ts
type CuaActionClick = {
  type: "click";
  x: number;
  y: number;
  button?: CuaMouseButton; // "left" | "right" | "middle" | "back" | "forward"
  hold_keys?: string[];
};

type CuaActionGoto = {
  type: "goto";
  url: string;
};
```

Mouse buttons are closed unions: `CuaMouseButton` for `click`/`mouse_down`/
`mouse_up` and `CuaDragMouseButton` (`"left" | "right" | "middle"`) for
`drag`. Executors coerce anything outside the set to `"left"`. `keys` stays
`string[]` — the agent-side key-alias table passes unrecognized keys through.

`createCuaBatchToolDefinition(actions?, options?)` builds a batch tool schema
whose input is:

```ts
type CuaBatchInput = {
  actions: CuaAction[];
};
```

Providers can include a batch tool when their model is expected to use one.
Anthropic does this by default with `computer_batch` (also exported as
`anthropic.ANTHROPIC_BATCH_TOOL_NAME`, equal to the top-level
`CUA_BATCH_TOOL_NAME`); Yutori does not.
`createCuaBatchToolExecutor()` is the matching execution adapter for turning
that provider-defined batch input into canonical CUA actions.

`createCuaNavigationToolDefinition()` can synthesize a `computer_use_extra`
navigation tool whose input is:

```ts
type CuaNavigationInput = {
  action: "goto" | "back" | "forward" | "url";
  url?: string;
};
```

## Provider Namespaces

Every provider namespace (`openai`, `anthropic`, `gemini`, `meta`, `xai`,
`moonshot`, `tzafon`, `yutori`) follows one convention:

- `computerTools(options?)` and `computerToolExecutors(options?)`
- `createActionSchema(actions?)` — TypeBox schema for the provider's subset
- `coordinateSystem()`
- `build<Provider>SystemPrompt({ suffix? })` and
  `<PROVIDER>_COMPUTER_INSTRUCTIONS` (the prompt text)
- `<PROVIDER>_CUA_ACTION_TYPES` — the supported canonical action subset
- `<Provider>Action` type — the canonical action union for that subset
- `ComputerToolsOptions` type (Anthropic's adds `excludeBatch`, also exported
  as `AnthropicComputerToolsOptions`)
- `providerModule` — the uniform `CuaProviderModule` object that
  `resolveCuaRuntimeSpec` looks up

Provider-specific extras:

- `openai`: the `openai-cua-responses` stream adapter (`OPENAI_CUA_RESPONSES_API`,
  `streamOpenAIResponses`, `streamSimpleOpenAIResponses`, `OpenAIResponsesOptions`),
  the pure `buildOpenAIRequestInput` request builder (threads
  `previous_response_id` + delta input with `store: true`), plus the
  `computer_use_extra` navigation aliases `OPENAI_EXTRA_TOOL_NAME`,
  `OPENAI_EXTRA_TOOL_DESCRIPTION`, `OpenAIExtraSchema`, `OpenAIExtraInput`
- `anthropic`: `ANTHROPIC_BATCH_TOOL_NAME` (`"computer_batch"`)
- `meta`: the `meta-responses` stream adapter (`META_RESPONSES_API`,
  `streamMetaResponses`, `streamSimpleMetaResponses`, `MetaResponsesOptions`),
  with `previous_response_id` threading and Meta-compatible reasoning payloads
- `xai`: the `xai-cua-responses` stream adapter (`XAI_CUA_RESPONSES_API`,
  `streamXaiResponses`, `streamSimpleXaiResponses`, `XaiResponsesOptions`),
  with serial function tools, encrypted reasoning replay, and
  `previous_response_id` threading
- `moonshot`: no stream adapter — Kimi flows through pi's builtin
  `openai-completions` transport; the provider module's payload middleware
  disables parallel tool calls
- `tzafon`: the `tzafon-responses` stream adapter (`TZAFON_RESPONSES_API`,
  `streamTzafonResponses`, `streamSimpleTzafonResponses`,
  `TzafonResponsesOptions` with `keepToolNames`), `tzafonComputerUseOnPayload`
  payload middleware, `tzafonToolCallId`, and the native-to-canonical
  normalizer `toCanonicalActions` (+ `TzafonCanonicalAction`)
- `yutori`: the `yutori-chat-completions` stream adapter
  (`YUTORI_CHAT_COMPLETIONS_API`, `streamYutori`, `streamSimpleYutori`,
  `YutoriOptions` with `keepToolNames`), `yutoriNativeToolSetOnPayload`
  payload middleware, the native Navigator action sets
  (`YUTORI_N1_ACTION_TYPES`, `YUTORI_N15_CORE_ACTION_TYPES`,
  `YUTORI_N15_EXPANDED_ACTION_TYPES`, `YUTORI_N15_ACTION_TYPES`, the
  `YUTORI_N15_CORE_TOOL_SET`/`YUTORI_N15_EXPANDED_TOOL_SET` tool-set ids, and
  the matching `Yutori*ActionType` types), `yutoriToolSetForModel`,
  `yutoriNativeActionsForModel`, and the native-to-canonical normalizer
  `toCanonicalActions`

This package does not execute browser actions. Use `@onkernel/cua-agent` when
you want model tool calls executed against a Kernel browser.
