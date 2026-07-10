# Changelog

## 0.6.0 - 2026-07-10

Breaking: response threading is now configured per request instead of through
`CUA_DISABLE_RESPONSE_THREADING`.

- `CuaSimpleStreamOptions` now includes `disableResponseThreading`, allowing
  OpenAI and Tzafon Responses API calls to send the complete current context
  instead of continuing through `previous_response_id`.
- Removed the process-wide `CUA_DISABLE_RESPONSE_THREADING` environment
  variable. `@onkernel/cua-agent` users can set `responseThreading: false` on
  `CuaAgent` or `CuaAgentHarness`; lower-level callers can pass
  `disableResponseThreading: true` in stream options.

## 0.5.0 - 2026-07-09

Introduces action planes (modes) and Anthropic native computer-use tools.

- New `mode` option (`"computer"` | `"browser"` | `"hybrid"`, exported as
  `CuaMode`) on `resolveCuaRuntimeSpec`, `computerTools`, and the executor
  builders selects which action plane(s) the model sees. `computer` is the
  pre-modes default and stays byte-compatible. `browser` exposes the new
  browser-plane canonical actions; `hybrid` exposes both planes deduplicated
  to one tool per capability, with browser actions restricted to element refs
  so the OS screenshot is the single coordinate frame.
- New browser-plane canonical actions (`CUA_BROWSER_ACTION_TYPES`):
  `browser_snapshot`, `browser_find`, `browser_text`, `browser_click`,
  `browser_fill`, `browser_scroll_to`, `browser_navigate`,
  `browser_list_tabs`, `browser_new_tab`, `browser_screenshot`,
  `browser_evaluate`, and friends, with per-mode tool naming
  (`cuaToolNameForAction`), descriptions, schemas, and system prompts.
- New `nativeTool` option drives Anthropic models through their native
  computer-use declarations: `computer_20260701` (computer mode, with
  `enable_zoom`) and `browser_20260701` (browser mode) behind
  `anthropic-beta: computer-use-2026-07-01`.
- JavaScript execution is on by default: `browser_evaluate` is part of the
  default browser/hybrid action sets, and native `browser_20260701`
  declarations default `enable_javascript_exec` to true (an explicit value on
  the spec wins). Opt out by passing an explicit `actions` list or native
  tool spec.
- New `zoom` computer action (cropped display inspection).

## 0.4.0 - 2026-07-07

Breaking: adopts pi-ai 0.80's instance-based `Models` API and drops the
global api-registry surface.

- Requests now stream through a pi `Models` collection. New exports:
  `createCuaModels(options?)` builds a collection with pi's builtin providers
  plus CUA's adjustments (OpenAI routed through `openai-cua-responses`,
  Google accepting `GOOGLE_API_KEY` or `GEMINI_API_KEY`, Tzafon and Yutori
  registered); `cuaModels()` returns the shared default collection.
- Removed `registerCuaProviders()` and the import-time registration side
  effect. Build a collection with `createCuaModels()` instead; nothing global
  is mutated.
- The pi-ai re-export now follows pi-ai 0.80: the free functions `complete`,
  `stream`, `completeSimple`, `streamSimple`, `getModel`, `getModels`, and
  the api-registry (`registerApiProvider`, `getApiProvider`,
  `resetApiProviders`, …) are gone. Call the equivalent methods on
  `cuaModels()`.
- API keys resolve from the documented env-var convention through provider
  auth when streaming via the collection; explicit `apiKey` stream options
  still take precedence.
- Removed the `claude-sonnet-5` and `gpt-5.5` model overrides (pi-ai 0.80's
  registry carries both) and the `gpt-5.5-2026-04-23` dated-snapshot
  override. Dated snapshot refs no longer resolve — use the family id
  (`openai:gpt-5.5`).
- Updated `@earendil-works/pi-ai` to 0.80.3.

## 0.3.4 - 2026-06-30

- Adapt newer Anthropic models to the adaptive thinking payload format, including `claude-sonnet-5`, `claude-opus-4-8`, and `claude-opus-4-7`.

## 0.3.3 - 2026-06-30

- Add computer-use support for the `claude-sonnet-5` Anthropic model.

## 0.3.2 - 2026-06-24

- Add computer-use support for the `gemini-3.5-flash` Google model.

## 0.3.1 - 2026-06-23

- Add the `playwright_execute` tool definition: `CuaPlaywrightSchema`,
  `CUA_PLAYWRIGHT_TOOL_NAME`, `CUA_PLAYWRIGHT_TOOL_DESCRIPTION`,
  `createCuaPlaywrightToolDefinition()`, and the `CuaPlaywrightInput` type.

## 0.3.0 - 2026-06-12

- Add `CuaSimpleStreamOptions`: pi-ai `SimpleStreamOptions` plus the
  `keepToolNames` extension the Yutori/Tzafon stream adapters consume, so
  callers can pass it through `streamSimple` without a cast.

## 0.2.2 - 2026-06-11

- Add computer-use support for `gpt-5.4-mini`, `gemini-3.1-flash-lite`, `tzafon.northstar-cua-fast-1.6`, and `tzafon.northstar-cua-fast-1.7-experiment`.
- Drop `gemini-3-pro-preview`, which Google has retired (the API now returns 404 for it).

## 0.2.1 - 2026-06-11

- Add computer-use support for the `claude-fable-5` Anthropic model.

## 0.2.0 - 2026-06-10

### Fixed

- The published package is now importable under plain Node ESM. 0.1.0 shipped
  extensionless relative imports in `dist/`, so `import "@onkernel/cua-ai"`
  failed outside bundlers; `dist/` is now bundled with tsdown.
- The shipped `examples/quickstart.ts` imports `@onkernel/cua-ai` instead of a
  `../src` path that does not exist in the tarball, checks `stopReason` so
  provider errors are no longer silent, resolves its API key via
  `requireCuaEnvApiKeyForModel`, and switches providers with the `CUA_MODEL`
  env var.
- `docs/` (the supported-models list the README links to) is now included in
  the npm tarball.
- A malformed Yutori tool call now degrades to an empty-arguments call instead
  of failing the entire response, matching the existing Tzafon hardening.

### Breaking changes

- Provider namespaces follow one convention. Every namespace now exports
  `computerTools({ actions? })` / `computerToolExecutors({ actions? })`,
  `createActionSchema`, `coordinateSystem()`, `providerModule`,
  `<PROVIDER>_CUA_ACTION_TYPES`, `<PROVIDER>_COMPUTER_INSTRUCTIONS`, a
  `<Provider>Action` type, and `ComputerToolsOptions`. This replaces 0.1.0's
  `createComputerToolDefinitions(options)` /
  `CreateComputerToolDefinitionsOptions`, the per-namespace
  `COMPUTER_TOOL_COORDINATES` constants, `TZAFON_ACTION_TYPES` /
  `YUTORI_ACTION_TYPES`, and the `OPENAI_BATCH_INSTRUCTIONS` /
  `GEMINI_INSTRUCTIONS_RAW` / `TZAFON_INSTRUCTIONS_RAW` /
  `YUTORI_INSTRUCTIONS_RAW` prompt constants.
- `CUA_BATCH_TOOL_NAME` is now `"computer_batch"` (was
  `"batch_computer_actions"`), matching the batch tool Anthropic ships by
  default. `anthropic.ANTHROPIC_BATCH_TOOL_NAME` carries the same new value;
  the other per-namespace batch aliases (`TZAFON_BATCH_TOOL_NAME`,
  `YUTORI_BATCH_TOOL_NAME`, `*_BATCH_DESCRIPTION`, `*BatchSchema`,
  `*BatchInput`) were removed — use `CUA_BATCH_TOOL_NAME`,
  `CUA_BATCH_TOOL_DESCRIPTION`, `CuaBatchSchema`, and `CuaBatchInput`.
- Anthropic tools are now the 13 canonical browser actions Anthropic supports
  (no `back`/`forward`/`url`) plus a `computer_batch` batch tool by default;
  pass `excludeBatch: true` to omit it. Unsupported `actions` entries throw.
  `anthropic.ANTHROPIC_CUA_ACTION_TYPES` reflects the supported subset rather
  than aliasing the full canonical list.
- Yutori models now use Yutori's documented native `tool_set` request field.
  `streamYutori` strips canonical action tools from the outbound payload
  (preserve specific tools via the `keepToolNames` stream option), selects the
  n1.5 core tool set where applicable, and normalizes native tool calls back
  to canonical names. `yutori.providerModule.toolDefinitions()` is `[]`;
  `yutori.computerTools()` builds local mirrors for executor lookup, validates
  `{ actions }` against the supported subset, and throws on unsupported
  actions. `yutoriBuiltinToolsOnPayload` was replaced by
  `yutoriNativeToolSetOnPayload`. The Yutori runtime spec also carries a
  screenshot policy (append a 1280x800 webp screenshot to the latest message).
- Family model annotations now match only the family root plus numeric
  revision or dated-snapshot suffixes (`claude-opus-4-7`,
  `gpt-5.5-2026-04-23`). Named sibling variants such as `gpt-5.4-mini` are no
  longer listed by `listCuaModels()` or accepted by `getCuaModel()` without
  their own annotation.
- `google:gemini-2.5-computer-use-preview-10-2025` was removed from the
  catalog: it rejects the standard function declarations this package sends
  and requires Google's native `tools.computer_use` wrapper. Use
  `google:gemini-3-flash-preview` or `google:gemini-3-pro-preview`.
- `streamTzafonResponses` no longer accepts a `maxOutputTokens` option — use
  the standard `maxTokens` stream option.

### Added

- `CuaProviderModule` contract plus a `providerModule` export per namespace,
  and a richer `CuaRuntimeSpec`: `toolExecutors` (local adapters that turn
  provider tool calls into canonical `CuaAction`s via `CuaToolExecutorSpec`),
  `coordinateSystem`, and optional `screenshot` policy alongside the existing
  tool definitions, default prompt, and payload middleware.
- `resolveCuaRuntimeSpec(input, options?)` accepts `ComputerToolsOptions` and
  forwards it to the provider module, so runtime consumers can narrow tool
  definitions and executors (e.g. `{ actions: ["click"] }`).
- `registerCuaProviders()` is exported: importing the package still registers
  the Yutori/Tzafon stream providers automatically, and this restores them
  after pi-ai registry mutators (`clearApiProviders`, `resetApiProviders`,
  `unregisterApiProviders`).
- `parseCuaModelRef` / `getCuaModel` accept `"gemini:"` refs as an alias for
  `"google:"`, and unsupported-provider errors now list the valid providers.
- `CuaMouseButton` and `CuaDragMouseButton` closed unions type the `button`
  field on click/mouse_down/mouse_up and drag actions.
- `yutori.YutoriOptions` and `tzafon.TzafonResponsesOptions` are exported and
  aligned; both support `keepToolNames` to preserve caller tools that collide
  with canonical action names on the wire.
- Yutori native action vocabulary exports: `YUTORI_N1_ACTION_TYPES`,
  `YUTORI_N15_CORE_ACTION_TYPES`, `YUTORI_N15_EXPANDED_ACTION_TYPES`,
  tool-set ids, `yutoriToolSetForModel`, `yutoriNativeActionsForModel`, and
  `toCanonicalActions`; Tzafon exports `toCanonicalActions`,
  `TzafonCanonicalAction`, `tzafonComputerUseOnPayload`, and
  `tzafonToolCallId`.
- README and JSDoc coverage across the public surface: API key prerequisites
  and helpers, error handling (`stopReason` semantics), a multi-turn
  tool-result example, the complete export list, and per-provider canonical
  action subsets.

## 0.1.0

- Provider-qualified CUA model catalog with support annotations and curated overrides.
- Unified runtime-spec resolution for provider defaults (tools, prompts, payload middleware).
- Registers CUA provider adapters and exports canonical computer-use schemas/tool definitions.
