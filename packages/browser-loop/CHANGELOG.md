# Changelog

## Unreleased

- Replace Anthropic's early-access `computer_20260701` and `browser_20260701`
  integrations with the generally available `computer_toolset_20260801` and
  `browser_toolset_20260801` client toolsets. Requests no longer send beta
  headers or use the browser access fallback; member calls/results preserve
  `toolset_name`, sequential batches stop at the first failure, and both
  toolsets may be selected together.
- Rename the product and unpublished package to Browser Loop: the repository is
  prepared for `kernel/browser-loop`, the package is `@onkernel/browser-loop`,
  and release tags use `browser-loop/v*`. The public `loop` namespace, `Loop*`
  TypeScript names, and `kloop.*.v1` tool identities are unchanged.
- The three packages are one: `@onkernel/browser-loop` replaces `@onkernel/cua-ai`,
  `@onkernel/cua-agent`, and `@onkernel/cua-pi-extension`. `.` exports the
  framework-neutral core (canonical actions, tool declarations, catalog
  compiler, tool menu, tool manager, browser execution), `./pi` exports the pi
  binding (`attach()`, model resolution, provider adapters, retry), and the pi
  extension is registered from the package's own `pi.extensions` field.
- `Cua*` names are `Loop*`, or plain domain names where the concept is
  computer use rather than this product: `CuaAction` is `ComputerUseAction`,
  `CuaBrowserAction` is `BrowserAction`, `CuaComputerAction` is
  `ComputerAction`. Tool identities move from `cua.*.v1` to `kloop.*.v1`, so a
  transcript recorded against an older build no longer resumes. Model-facing
  tool names (`browser_snapshot` and friends) are unchanged.
- The package root no longer re-exports `@earendil-works/pi-ai`. Import pi's
  types and helpers from pi directly.
- The changelogs of the retired `@onkernel/cua-agent` and
  `@onkernel/cua-pi-extension` packages are folded in below; their released
  history stays in git.

Breaking: `CuaAgent` and `CuaAgentHarness` are removed. The package hands back
plain pi objects; the caller constructs the agent.

- Add `attach({ browser, client })`, returning a handle that compiles
  (model, tools) pairs into plain pi objects: `model` carrying the transport its
  tools derive, `tools` / `agentTools` materialized against the handle's browser
  pool, `models` adding provider retry, required headers, the catalog's payload
  transforms and the tool-result image bound, `activate(harness)` for the
  behaviors that are pi event handlers rather than constructor options, and
  `apply(harness)` to swap a running harness onto a new pair. The handle owns
  what actually persists — the Kernel client and browser, the translator, the
  raw-CDP executor, ref and frame state — so a spec materializes once across
  repeat compiles.
- `getTools()`, `setTools()`, `setModel()`, and `setModelAndTools()` are gone
  with the classes. A change compiles a new pair and applies it, so the current
  selection belongs to the caller and there is no second copy of it to drift.
  `compile()` throws before anything reaches pi, and `apply()` restores the
  previous pair if pi rejects the new one, so the atomicity those methods
  provided is preserved. `apply()` sets the model only when the derived
  transport actually moved, so a tools-only change records no model change.
- The tool manager is immutable: one compiled pair per instance. Removing its
  execution scope also removes cache-preserving deferred tool addition, which
  only that mutation path produced; the transport still consumes
  `addedToolNames` on a transcript that carries them.
- The tool-result image bound, payload transforms, and required headers now
  follow whichever pair is active rather than the one a harness was built with.
  pi fixes `models` at construction while those are per-catalog, so one
  collection per handle is what makes a swap possible at all.
- A model ref absent from a supplied `Models` collection falls back to the
  registry, and an id the registry lacks is synthesized.
- `responseThreading` (`LoopAttachOptions`) no longer affects OpenAI models:
  OpenAI streams through pi-ai's builtin Responses transport and its automatic
  prompt caching regardless of this flag. The option still governs Google's
  `previous_response_id`-style continuation.
- Exempt OpenAI's native computer tool from the tool-result image replay limit.
  Its `computer_call_output` items must each carry a screenshot, and stateless
  replay no longer leaves them in provider-stored state.
- `browser_act` no longer spends a plan's whole deadline waiting for the effect
  of a step whose action failed. An unresolvable ref throws immediately, but the
  step's `expect` was still awaited afterwards, so a model that invented a ref
  burned a full global timeout per attempt instead of being told to snapshot
  first. A step whose action never dispatched now skips its own expectation and
  stops the plan. Uncertain *delivery* still waits, because a lost
  acknowledgement may mean the input landed and the expectation is how that is
  discovered.
- Remove `LoopExecutionResources.viewport`. It only fed the removed catalog
  viewport option; the same value is still on `resources.browser.viewport`.

Breaking: the `cua` CLI is removed, and the pi extension replaces it.

- Everything the CLI built because it needed an agent front-end — sessions and
  resume, skills, the TUI, print and RPC modes, model selection — pi supplies.
  The `cua act` model-free executor path and the `--print -o jsonl` telemetry
  schema are gone with it.
- The extension contributes Kernel browser tools to pi's own agent session. Its
  menu is eight entries, one per capability: `browser` and `computer`
  (primitives plus their batch form), `browser-act`, `playwright`, and the four
  provider-native surfaces — `anthropic-computer`, `anthropic-browser`,
  `openai-computer`, `google-browser`. Packaging variants are deliberately
  absent: `mixed`, the batch tools on their own, and the 37 individual tool
  names offered nothing the eight entries do not.
- Tools are selected with `--browser-tools` and `/browser-tools`, coordinates
  with `--browser-coordinates`, and browser configuration is one
  `--browser-options` JSON object forwarded verbatim to Kernel's browser-create
  call. A flag per create-call field grows every time the SDK does; JSON tracks
  it for free. The only default is `timeout_seconds: 600`, and `stealth` is not
  forced on. `--browser-session` attaches an existing browser and cannot be
  combined with `--browser-options`.
- A selection is validated by compiling it for the active model, so an
  incompatible tool deactivates with the catalog compiler's own reason instead
  of failing at request time. `/browser-tools` with no argument lists every
  selector for the current model with those reasons, deciding each entry's
  availability by compiling it on its own and reporting pairwise conflicts
  separately. A deactivated selection reports itself on stderr in print and RPC
  modes, once per distinct reason, so a scripted run cannot silently lose its
  tools and answer from memory with exit 0.
- Provider-native surfaces work because the extension owns the stream for the
  providers it registers, swapping pi's registry model for the compiled
  catalog's model — which carries the transport the selected tools derive — and
  passing the incoming native-call plan. Without that, `requiresApi` never takes
  effect and native calls arrive unnormalized.
- One browser is provisioned lazily per session on first tool execution and
  deleted on shutdown if this session created it. Declaration compilation,
  header generation, and payload transforms never provision a browser.

- Fix OpenAI's native computer transport rejecting every request after a
  screenshot-less action. A `computer_call_output` whose result carried no image
  put the failure text in an `error` key, which the Responses API refuses outright
  (`400 Unknown parameter: 'input[N].output.error'`), so one failed action poisoned
  the rest of the conversation. The output now always carries a valid
  `computer_screenshot`, and the failure text follows as a user message so the
  model still learns what happened. A 1x1 placeholder is not enough — the
  Responses API rejects it even though the vision endpoint accepts one.
- Anthropic's native browser and native computer tools can no longer be selected
  together. Anthropic answers 400 because the browser tool addresses a viewport
  coordinate frame and the computer tool a display frame; the catalog now refuses
  the pair at compile time instead of on the wire.
- Google no longer carries a schema quirk. The Gemini API rejects the JSON Schema
  keywords `const` and `additionalProperties` outright rather than ignoring them,
  so a payload transform rewrites both for Google — `const: x` becomes a
  single-value `enum`, which means the same thing. Gemini now accepts every
  function tool CUA offers, including `browser_act` and `browser_wait_for`, which
  the removed quirk had marked unavailable.

- Add `cuaToolMenu(model, selected)`: every tool CUA can offer for a model, each
  marked available or not with the compiler's own reason when it is not. It
  decides availability by compiling the candidate catalog rather than restating
  the compiler's rules, so the menu cannot drift from what
  `compileCuaToolCatalog` accepts. Availability is relative to the current
  selection, because two providers' native surfaces cannot coexist and a native
  surface pins the transport.

Breaking: the model allowlist is removed.

- `listCuaModels()` returns pi-ai's whole catalog — 37 providers, ~1,150 models —
  instead of a curated subset, and each entry now carries `nativeSurfaces` and
  `vision` so callers can render what a model can do.
- `getCuaModel(ref)` resolves any model pi-ai carries, and synthesizes one for
  an id the registry has not caught up with, using the sibling that shares the
  longest id prefix and preferring the latest such sibling. Providers migrate
  transports mid-generation, so a new id follows its nearest, newest relative.
  Only an unqualified ref or a provider pi-ai does not carry is refused.
- `CUA_MODEL_ANNOTATIONS`, `CUA_PROVIDERS`, `isCuaProvider`, and the
  `CuaProvider` union are gone; `CuaProvider` is now a provider id string and
  `cuaProviders()` returns what pi-ai carries. `providerForModel` no longer
  throws.
- Two tables replace the allowlist, neither of which decides whether a model may
  run: `CUA_NATIVE_SURFACES` (which models have a provider-native computer or
  browser tool, with first-party sources) and `CUA_MODEL_QUIRKS` (request-shape
  limits, each carrying the documented limit or observed failure that justifies
  it). `cuaModelCapabilities` reads the quirk table and defaults to permissive;
  `cuaNativeSurfaces(model)` and `cuaModelQuirks(model)` are exported for menus
  and diagnostics.

Breaking: a model's transport is derived from the tools selected with it, rather
than stamped on the model.

- `compileCuaToolCatalog` derives the compiled model's `api` from the selected
  tools' provider bindings: a `CuaProviderBinding` may declare `requiresApi`,
  and the returned `catalog.model` carries that transport. Selecting tools whose
  bindings require different transports fails to compile with a named catalog
  error. This makes transport a function of `(model, selected tools)` instead of
  `(model)` alone.
- `getCuaModel("google:...")` no longer forces `google-cua-interactions`. A
  Google model resolved without Google's native browser toolset selected now
  keeps pi-ai's builtin `google-generative-ai` transport; selecting
  `cua.providers.google.toolsets.browser()` still compiles to
  `google-cua-interactions` as before.
- Add `OPENAI_CUA_COMPUTER_API` (`"openai-cua-computer"`). A model compiled with
  `cua.providers.openai.tools.computer()` selected carries this api, and the
  OpenAI provider wrapper dispatches to the CUA adapter on `model.api` alone.
  The one remaining request-shape check, `requiresCuaOpenAINamespaceAdapter`,
  covers only what cannot be derived from the model: a transcript carrying a
  deferred tool-search addition or a replayed function-call namespace, neither
  of which pi-ai's builtin transport round-trips.
- Remove `routeCuaApi`. Every provider now takes its transport from pi-ai's
  registry or from the selected tools' `requiresApi`, so model resolution
  returns pi-ai's data unmodified. Its last remaining branch patched grok-4.5's
  thinking-level map, price tiers, and compat flags onto pi-ai's registry entry;
  live runs on grok-4.5 at the default, `off`, and `xhigh` thinking levels
  behave identically without it. The only lost detail is a >200k-token price
  tier that pi's registry does not carry, which affects `usage.cost` reporting
  for long requests and nothing else.

Breaking: OpenAI models no longer carry a CUA-owned api id.

- OpenAI models resolve to pi-ai's builtin `"openai-responses"` api instead of
  the removed `openai-cua-responses`, and stream through pi's builtin Responses
  transport (`store: false`, automatic prompt-cache-key matching) by default.
  `OPENAI_CUA_RESPONSES_API` and the OpenAI adapter's `previous_response_id`
  threading are removed; `previous_response_id` and `store: true` no longer
  appear on any OpenAI request.
- OpenAI's native computer adapter now sends the same `prompt_cache_key`,
  `prompt_cache_retention`, `prompt_cache_options`, and session-affinity headers
  as the function-tool path. It previously relied on stored response state for
  context reuse and sent no cache key of its own.
- Remove the xAI Responses fork. It existed only to thread
  `previous_response_id` and to set `parallel_tool_calls: false`, which the tool
  catalog already emits for the provider. `xai-cua-responses` is gone and Grok
  streams through pi's builtin xAI provider; `XAI_CUA_RESPONSES_API`,
  `streamXaiResponses`, and `streamSimpleXaiResponses` are no longer exported.
- Google keeps its continuation protocol: it threads a provider-specific field
  with no builtin equivalent, and the shared helpers in `providers/common.ts`
  are unchanged for it.

Breaking: the Tzafon, Yutori, and Meta providers are removed.

- Remove the `tzafon` and `yutori` providers: their model annotations and
  overrides, `cua.providers.tzafon`, `cua.providers.yutori`,
  `TZAFON_API_KEY`/`YUTORI_API_KEY`, and the exported `TZAFON_RESPONSES_API`,
  `YUTORI_CHAT_COMPLETIONS_API`, `streamTzafonResponses`,
  `streamSimpleTzafonResponses`, `streamYutori`, and `streamSimpleYutori` stream
  functions. `createCuaModels()` no longer registers either provider, and refs
  like `tzafon:tzafon.northstar-cua-fast` or `yutori:n1.5-latest` now fail to
  resolve. Drops the `@tzafon/lightcone` dependency.
- Remove the `meta` provider. pi-ai ships no `meta` provider, so cua hand-wrote
  a model entry and pointed pi's own Responses transport at `api.meta.ai`.
  `META_API_KEY`, `META_RESPONSES_API`, `streamMetaResponses`, and
  `streamSimpleMetaResponses` go with it. Meta was the last user of the
  model-override mechanism, so `CUA_MODEL_OVERRIDES` and `cuaOverrideModels()`
  are gone too, and `getCuaModel` no longer has a "supported but not registered"
  fallback. Muse Spark remains available through pi's OpenRouter catalog as
  `openrouter:meta/muse-spark-1.1`, annotated with explicit capabilities because
  OpenRouter's provider-level defaults are conservative.
- `CuaProviderBinding` loses its `tzafon-native` and `yutori-native` variants,
  and `CuaIncomingToolPlan` loses `tzafonComputerName` and `yutoriNames`. The
  Yutori-only rule rejecting a partial n1 native action set is gone with them;
  every surviving native toolset can be selected in part.
- `CompileCuaToolCatalogOptions.viewport` is removed. It existed only to fill
  Tzafon's `display_width`/`display_height` declaration defaults, and no
  surviving declaration reads it.

## 0.10.0 - 2026-08-04

Breaking: upgrade `@earendil-works/pi-ai` to 0.83.0.

- Remove the local `claude-opus-5`, `gemini-3.6-flash`, and
  `gemini-3.5-flash-lite` model overrides: pi-ai 0.83.0's registry now carries
  all three with the same metadata. Overrides remain only for the CUA-only
  providers pi-ai does not ship (Meta, Tzafon, Yutori).
- Kimi K3 reasoning effort follows pi-ai's catalog metadata with no CUA
  override: `low`/`high`/`max` map through `thinkingLevelMap` (the rest clamp
  away), and requests carry `reasoning_effort` on Moonshot or OpenRouter's
  nested `reasoning.effort`.
- Disable Tzafon native non-screenshot action loops: its Responses API requires
  every `computer_call_output` to carry an image, while CUA returns screenshots
  only when explicitly requested. Unsupported native actions now fail before
  browser execution instead of entering a text-only loop that the API rejects.

## 0.9.0 - 2026-08-03

- Add Kimi K3 through OpenRouter as `openrouter:moonshotai/kimi-k3`,
  authenticated with `OPENROUTER_API_KEY`, while retaining direct Moonshot access
  through `moonshotai:kimi-k3`.
- Share Kimi K3's CUA capability metadata across both transports: nested browser
  schemas are accepted, the larger `browser_act` schema is rejected, and
  state-mutating function tools disable parallel calls.
- Resolve schema and tool-call compatibility from concrete model capabilities
  instead of provider-wide allowlists. Existing provider-family defaults are
  preserved, and provider-native tools remain restricted to their native
  transports.

## 0.8.0 - 2026-07-31

Breaking: agent tools are now one explicit, identity-keyed catalog. The mode,
implicit-tool, and runtime-spec APIs are removed.

- Add the frozen `cua` namespace with atomic browser/computer/Playwright tools,
  `browser`/`computer`/`mixed` convenience toolsets, mechanical batch tools,
  coordinate contracts, and provider-native tools/toolsets.
- Add `compileCuaToolCatalog()` with stable identities; exact requested-order
  preservation; schema/catalog fingerprints; exact and
  provider-normalized collision checks; model compatibility checks; inspectable
  declarations; dynamic-loading eligibility; generated header composition;
  ordered payload transforms; and incoming native-call plans.
- Catalog compilation is declaration-only and deterministic: it accepts CUA
  specs and sanitized caller `Tool` declarations plus a viewport, returns
  pi-ai `Tool` declarations (`catalog.toolDeclarations`) and provider plans,
  and never constructs executable tools or retains the requested inputs.
  `callerToolIdentity()` is the single canonical identity scheme for caller
  tools, shared with cua-agent and cua-cli. The package no longer depends on
  `@earendil-works/pi-agent-core`; materialization and implementation identity
  live in `@onkernel/cua-agent`.
- Remove `resolveCuaRuntimeSpec`, `CuaRuntimeSpec`, `CuaMode`, mode inference,
  legacy native-tool switches, implicit navigation tools, and provider-owned
  default prompt selection from the public API.
- Provider-native declarations now compose by selected identity with ordinary
  functions. Add fixed-version Anthropic computer/browser factories, OpenAI
  native computer composition, Tzafon viewport-aware declaration replacement,
  Google's current predefined browser toolset, and identity-scoped Yutori
  native selection. Every provider surface exposes its first-party source.
- Add deterministic provider composition: generated model preparation, tool
  serialization, provider fields, then caller payload hooks.
  Header requirements merge without overwriting unrelated caller headers.
- Add a Google Interactions API adapter plus current `computer_use` browser
  action names and `[0, 999]` coordinates. Exact-subset declarations exclude
  every unselected current action, and excluded incoming calls fail with a
  named catalog error. Support the documented `gemini-3.6-flash`,
  `gemini-3.5-flash`, and `gemini-3.5-flash-lite` models.
- Add `anthropic:claude-opus-5` with its 1M-token context window, 128k output
  limit, adaptive thinking levels, and July 2026 native-tool compatibility.
  Native `browser_20260701` transparently retries through an equivalent
  function-tool declaration when the active credential lacks beta access.
- Add the verified `openai:gpt-5.6-sol` model.
- Expose Google's predefined actions through `browser()` only. Remove legacy
  Google actions and the Meta/xAI/Moonshot coordinate toolsets; those
  custom-function providers use the standard CUA browser toolset.
- Validate large function schemas separately from ordinary nested schemas.
  Moonshot retains CUA browser primitives and `browser_wait_for`, but catalog
  compilation now rejects `browser_act`, whose larger schema its API refuses.
- Native tool execution metadata carries stop-on-first-failure policy without
  introducing provider branches in cua-agent.
- Declare `engines.node` `>=22.19.0`. This is not a new requirement: every
  `@earendil-works/pi-*` dependency already declares the same floor, so it was
  previously enforced only transitively and never stated on this package.

## 0.7.0 - 2026-07-17

- Added Moonshot Kimi K3 computer-use support: `moonshotai:kimi-k3`
  (`moonshot:` accepted as a ref alias), authenticated with
  `MOONSHOT_API_KEY`. Kimi streams through the OpenAI-compatible chat
  completions transport with ordinary function tools.
- New `moonshot` provider namespace following the standard conventions
  (`computerTools`, `coordinateSystem`, `buildMoonshotSystemPrompt`,
  `providerModule`, …). Kimi's coordinate contract is normalized 0–1
  width/height fractions, matching the model's native visual grounding;
  payload middleware disables parallel tool calls.
- Bumped `@earendil-works/pi-ai` to 0.80.10 (carries the Kimi K3 registry
  entry). Grok 4.5's registry api id is now `openai-responses`; CUA routing
  behavior is unchanged.

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
  `enable_zoom`) behind `anthropic-beta: computer-use-2026-07-01`, and
  `browser_20260701` (browser mode) behind
  `anthropic-beta: browser-use-2026-07-01`.
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

## Pre-collapse history: @onkernel/cua-agent

### Unreleased

- `browser_act` no longer spends a plan's whole deadline waiting for the effect of
  a step whose action failed. An unresolvable ref throws immediately, but the
  step's `expect` was still awaited afterwards, so a model that invented a ref
  burned a full global timeout per attempt instead of being told to snapshot
  first. A step whose action never dispatched now skips its own expectation and
  stops the plan. Uncertain *delivery* still waits, because a lost acknowledgement
  may mean the input landed and the expectation is how that is discovered.

Breaking: `CuaAgent` and `CuaAgentHarness` are removed. cua-agent hands back
plain pi objects; the caller constructs the agent.

- Add `attach({ browser, client })`, returning a handle that compiles
  (model, tools) pairs into plain pi objects: `model` carrying the transport its
  tools derive, `tools` / `agentTools` materialized against the handle's browser
  pool, `models` adding provider retry, required headers, the catalog's payload
  transforms and the tool-result image bound, `activate(harness)` for the
  behaviors that are pi event handlers rather than constructor options, and
  `apply(harness)` to swap a running harness onto a new pair. The handle owns
  what actually persists — the Kernel client and browser, the translator, the
  raw-CDP executor, ref and frame state — so a spec materializes once across
  repeat compiles.
- `getTools()`, `setTools()`, `setModel()`, and `setModelAndTools()` are gone
  with the classes. A change compiles a new pair and applies it, so the current
  selection belongs to the caller and there is no second copy of it to drift.
  `compile()` throws before anything reaches pi, and `apply()` restores the
  previous pair if pi rejects the new one, so the atomicity those methods
  provided is preserved. `apply()` sets the model only when the derived
  transport actually moved, so a tools-only change records no model change.
- `CuaToolManager` is now immutable: one compiled pair per instance, with
  `prepareTools`/`prepareModel`/`prepareModelAndTools`/`commit`/`getTools` and
  the async-local execution scope removed. Removing the execution scope also
  removes cache-preserving deferred tool addition: a tool that added tools mid
  execution used to have those names recorded on its result as
  `addedToolNames`, letting pi extend an OpenAI request without invalidating the
  prompt-cache prefix. Nothing produced them outside that mutation path. The
  transport still consumes `addedToolNames` on a transcript that carries them.
- The tool-result image bound, payload transforms, and required headers now
  follow whichever pair is active rather than the one a harness was built with.
  pi fixes `models` at construction while those are per-catalog, so one
  collection per handle is what makes a swap possible at all.
- A model ref absent from a supplied `Models` collection falls back to the
  registry, and an id the registry lacks is synthesized.
- The model streamed for a Google model depends on which tools it was compiled
  with: selecting Google's native browser toolset compiles to the CUA-owned
  Interactions API, while a Google model selected with only CDP browser tools
  streams through pi's builtin Google transport.
- `responseThreading` (`CuaAttachOptions`) no longer affects OpenAI models:
  OpenAI streams through pi-ai's builtin Responses transport and its automatic
  prompt caching regardless of this flag. The option still governs Google's
  `previous_response_id`-style continuation.
- Exempt OpenAI's native computer tool from the tool-result image replay limit.
  Its `computer_call_output` items must each carry a screenshot, and stateless
  replay no longer leaves them in provider-stored state.

Breaking: Tzafon and Yutori support is removed.

- Compiling a Tzafon or Yutori model ref now fails to resolve the model, and
  `cua.providers.tzafon` / `cua.providers.yutori` no longer exist.
- Remove `CuaExecutionResources.viewport`. It only fed the removed catalog
  viewport option; the same value is still on `resources.browser.viewport`.

### 0.10.0 - 2026-08-04

Breaking: upgrade `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`
to 0.83.0 and adopt pi's context-first harness API.

- `CuaAgentHarness` and `CuaAgentHarnessOptions` now take the tool context as
  their first type parameter — `CuaAgentHarness<TContext, TSkill,
  TPromptTemplate>` — mirroring pi's `AgentHarness` generic order. The
  supplied `toolContext` is forwarded to pi untouched, and every executable
  harness tool receives the exact object on each call.
- Executable harness tools are pi `AgentHarnessTool`s via the new
  `CuaHarnessTool<TContext>` union (a CUA spec or an `AgentHarnessTool`).
  `CuaAgent` stays on the ordinary pi `AgentTool` (`CuaAgentTool`); the two
  tool APIs are no longer conflated.
- Remove `CuaAgentHarnessOptions.env` and `CuaAgentHarness.env`. Execution
  environments now travel through the tool context (for example
  `toolContext: { env: new NodeExecutionEnv({ cwd }) }` for pi's
  read/bash/edit/write tools). No alias is preserved.
- Remove `CuaSystemPromptCallback`; `systemPrompt` is pi's
  `AgentHarnessSystemPrompt` through the harness options.
- Keep `streamFn` optional on `CuaAgentOptions` (CUA supplies its default
  stream) even though pi 0.83.0 makes `AgentOptions.streamFn` required.
- Published declarations target pi's TypeBox 1.3 as-is; a downstream compile
  test with `skipLibCheck: false` guards the packaged types.
- Preserve explicit Tzafon screenshot results in model context even when they
  fall outside `toolResultImageReplayLimit`, because its native continuation
  protocol requires those images. Other tool-result images remain bounded.

### 0.9.0 - 2026-08-03

- Add OpenRouter Kimi K3 support through `@onkernel/cua-ai` 0.9.0,
  including the browser-primitives-only example catalog used by the provider
  matrix.
- Resolve `CuaAgentHarness` string model references against its supplied
  `Models` collection during construction and `setModel()`, while preserving
  the curated CUA model gate and fallback support for CUA model overrides.
- Keep `CuaAgent` aligned with pi's low-level `Agent`: callers can pass a
  concrete OpenRouter model and inject `models.streamSimple` without adding a
  `Models` dependency to the agent API.

### 0.8.0 - 2026-07-31

Breaking: `CuaAgent` and `CuaAgentHarness` now require one exact `tools` list and
use composition instead of inheriting from pi's `Agent`/`AgentHarness`.

- Add `getTools()` and atomic `setTools()`. Model changes recompile and
  revalidate the full requested catalog. Empty catalogs are valid;
  no tools or system-prompt text are inferred or appended. Catalog changes from
  inside a tool require sequential execution, including model changes.
- Remove `mode`, `nativeTool`, `extraTools`, `playwright`, `setMode()` /
  `getMode()`, and implicit `computer_use_extra` behavior.
- Add one shared `CuaExecutionResources` pool per agent/harness. Catalog and
  model changes preserve the canonical translator, lazy raw-CDP browser
  executor, refs, tabs, screenshots, and Playwright capability.
- Define and export `CuaAgentTool` here (moved out of cua-ai, which now
  compiles declaration-only catalogs). cua-agent owns all `AgentTool`
  materialization — each CUA spec is materialized exactly once per shared
  execution-resource pool — and owns implementation identity for
  cache-preserving deferred-tool decisions: a reused `execute` function keeps
  its identity across wrappers, a new `execute` or freshly created spec object
  is a conservative replacement, and the same objects stay stable across model
  recompilation.
- Integrate pi 0.80.10 dynamic tool loading. Eligible additions made from inside
  a running tool emit `addedToolNames`; outside-tool additions and all
  provider-native changes are eager. Schema/executor replacements are treated
  as real changes, not name-only no-ops.
- Refactor atomic tools to operation-specific argument objects while preserving
  the existing `browser_act` schema. Export `formatBrowserActResult()` so direct
  application surfaces can render the same bounded plan feedback as agents.
- Add mechanical `computer_batch` and `browser_batch` execution. Computer writes
  coalesce across write-only runs and flush around reads; browser actions run
  sequentially against shared ref state. Failure details include the failed
  action index, completed reads, and skipped count.
- Return screenshots only for explicit screenshot or zoom actions. Ordinary
  writes return status text, semantic tools return structured feedback, and
  failed batches replace images from earlier explicit screenshot steps with
  textual markers.
- Native multi-action turns stop after the first failed tool call. Every
  remaining call in that assistant turn receives the configured error result
  instead of executing against stale browser state.
- Update shared examples to use the same browser-oriented provider catalogs as
  the CLI: explicit `browser_act` plans where the provider accepts the schema,
  browser primitives alone for Moonshot, and Anthropic native-browser selection
  with model fallback.
- Security: require `sharp` `^0.35.3` (was `^0.34.5`) to pick up the libvips
  fixes for GHSA-f88m-g3jw-g9cj (CVE-2026-33327, CVE-2026-33328, CVE-2026-35590,
  CVE-2026-35591). `sharp` decodes cloud-browser screenshots inside the
  translator's `zoom()`, so this is the one advisory in this release that
  touched attacker-influenced bytes. The APIs this package uses are unchanged by
  sharp 0.35, and no source changes were needed. Two packaging notes for
  installers: sharp 0.35 no longer ships an `install` lifecycle script, and it
  no longer falls back to building from source — installing with
  `--omit=optional`, or on a platform with no prebuilt `@img/sharp-*` binary,
  now fails at import instead of silently compiling. sharp 0.35 requires Node
  `>=20.9.0`, well below this package's floor.
- Declare `engines.node` `>=22.19.0`. This is not a new requirement: every
  `@earendil-works/pi-*` dependency already declares the same floor, so it was
  previously enforced only transitively and never stated on this package.

### 0.7.0 - 2026-07-17

- `CuaAgent` and `CuaAgentHarness` support Moonshot Kimi K3
  (`moonshotai:kimi-k3`) via `@onkernel/cua-ai` 0.7.0, resolving auth from
  `MOONSHOT_API_KEY`. Kimi's fractional coordinates are scaled to viewport
  pixels by the existing translator.
- Bumped `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` to
  0.80.10; the wrapped `Models` collections forward the new
  `checkAuth`/`getAvailable`/`login`/`logout` methods.

### 0.6.0 - 2026-07-10

Adds explicit request-recovery and context-management policies while keeping
provider retries and exact-empty recovery disabled by default.

- `retry` adds opt-in transient provider-request retries to `CuaAgent` and
  `CuaAgentHarness`, with configurable attempt and backoff limits. Failed
  partial streams are buffered and discarded before a clean retry is exposed.
- `toolResultImageReplayLimit` limits each model request to the newest four
  tool-result images by default. It operates on a request-time projection and
  leaves agent state and persisted sessions unchanged. Harness context hooks
  settle before this limit is applied at the `Models` boundary.
- `responseThreading` replaces the process-wide environment switch with a
  constructor option for OpenAI and Tzafon `previous_response_id` chaining.
- `emptyResponseRecovery` optionally follows a successful exact-empty response
  with a bounded, caller-supplied pi `followUp()` message. Omitting it preserves
  pi's normal completion behavior.
- Updated `@onkernel/cua-ai` to 0.6.0.

### 0.5.0 - 2026-07-09

Adds the browser action plane and runtime mode switching. Breaking: the
`computerUseExtra` option is removed — the `computer_use_extra` navigation
helper is always registered.

- New `BrowserExecutor`: drives the browser plane over CDP. Accessibility
  snapshots with element refs (`[e12]`), node states
  (checked/expanded/disabled/value/…), and cursor:pointer clickable hints
  for elements with no interactive ARIA role; iframe and OOPIF stitching
  with per-frame session-aware refs; StaticText dedupe and wrapper
  collapsing; an unchanged-snapshot short-circuit; lexical `find`, `fill`,
  CDP navigation and tab management; and a JavaScript dialog guard. Refs invalidate on real
  navigations (`Page.frameNavigated`), self-heal via (role, name, nth) when
  the page changes but the element is still unambiguous, and the ref table is
  bounded (per-target cap, generation sweeps). `exportRefState()` /
  `importRefState()` persist refs across processes against the same browser.
- `CuaAgent` and `CuaAgentHarness` accept `mode` (`"computer"` | `"browser"`
  | `"hybrid"`) and `nativeTool`, and support runtime plane switching via
  `setMode()` / `getMode()`. Mode switches preserve the requested activation
  state of surviving tools and keep the translator — CDP connection, tabs,
  and element refs — alive; the translator is only rebuilt when a model
  switch changes the provider's coordinate system or screenshot transform.
  Both switches roll back cleanly on failure.
- Post-action grounding captures and the navigation helper are mode-aware:
  browser mode grounds on the viewport and routes navigation through CDP
  (browser and hybrid modes both route `computer_use_extra` navigation over
  the browser plane so refs invalidate correctly).
- Updated `@onkernel/cua-ai` to 0.5.0.

### 0.4.0 - 2026-07-07

Breaking: follows pi-agent-core 0.80's `Models`-based harness.

- `CuaAgentHarness` accepts an optional `models` (a pi `Models` collection)
  and defaults to `cuaModels()` from `@onkernel/cua-ai`. The
  `getApiKeyAndHeaders` option is gone — pi-agent-core 0.80 resolves auth
  through provider auth on the collection; pass a custom `models` to override
  resolution (e.g. in tests).
- `CuaAgent`'s default stream path is `cuaModels().streamSimple` instead of
  pi-ai's removed global `streamSimple`. Custom `streamFn` options work
  unchanged.
- Updated `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` to
  0.80.3 and `@onkernel/cua-ai` to 0.4.0.

### 0.3.5 - 2026-06-24

- Update the `@onkernel/cua-ai` dependency to 0.3.2, adding computer-use
  support for the `gemini-3.5-flash` Google model.

### 0.3.4 - 2026-06-23

- Add an opt-in `playwright` option to `CuaAgent` and `CuaAgentHarness` that
  exposes a `playwright_execute` tool, running Playwright/TypeScript against
  the live browser session via the Kernel SDK. Results, stdout, and stderr
  come back as tool content; SDK-reported failures surface as content rather
  than throwing. Adds the `PlaywrightDetails` export.

### 0.3.3 - 2026-06-12

- The action translator now consumes the canonical `CuaAction` union with an
  exhaustive switch. Malformed action shapes fail loudly instead of silently
  coercing (previously e.g. a click at 0,0); the documented mouse-button
  coercion to `"left"` is unchanged.
- `prepareNextTurn` no longer rebuilds the turn context on every turn: it
  keeps stock pi behavior until a user hook returns an update or a mid-run
  model assignment requires a refresh.
- One translator instance per runtime is shared between the executor tools
  and the provider screenshot capability.
- The `CuaAgentHarness` README quickstart showcases session-backed turns and
  mid-session model switching; `computerUseExtra` is documented with its
  rationale.
- Update the `@onkernel/cua-ai` dependency to 0.3.0.

### 0.3.2 - 2026-06-11

- Update the `@onkernel/cua-ai` dependency to 0.2.2.

### 0.3.1 - 2026-06-11

- Update the `@onkernel/cua-ai` dependency to 0.2.1.

### 0.3.0 - 2026-06-10

- Replaces the vendored pi-agent-core snapshot with the released `@earendil-works/pi-agent-core@0.79.1` dependency. The full pi surface is still re-exported, but it now tracks the published package instead of a frozen fork.
- BREAKING: `harness.agent` is removed. It only existed in the vendored pre-release snapshot and never shipped in any pi-agent-core release; use `getModel()`, `getTools()`, and `getActiveTools()` instead.
- BREAKING: `steer()`, `followUp()`, `nextTurn()`, and `setStreamOptions()` on the harness now return promises and must be awaited.
- BREAKING: the harness `model_select` and `thinking_level_select` events are renamed `model_update` and `thinking_level_update`, and the `steeringMode`/`followUpMode` property accessors became `getSteeringMode()`/`setSteeringMode()`/`getFollowUpMode()`/`setFollowUpMode()` methods.
- BREAKING: `ExecutionEnv` is now `Result`-based. Custom env implementations return `Result` values instead of throwing.
- BREAKING: requires Node.js >= 22.19.0.
- `NodeExecutionEnv` now comes from `@earendil-works/pi-agent-core`'s `/node` subpath; importing it from `@onkernel/cua-agent` keeps working.
- Tool execution follows pi's throw-on-failure contract: failed browser actions throw an error labeled with the action instead of also encoding the failure into tool result content and details.
- Moves the yutori screenshot payload append into `@onkernel/cua-ai`'s payload middleware.
- Built ESM output uses explicit `.js` relative import specifiers so `dist` resolves under plain Node.js.

### 0.2.0 - 2026-05-13

- Adds `CuaAgentHarness`, a provider-aware harness API with session-backed turns, resource and prompt helpers, active tool selection, and model switching.
- Keeps CUA runtime defaults in sync when changing models so provider-specific tools, prompts, and payload middleware update together.
- Improves browser keyboard shortcut translation for Kernel computer actions.

### 0.1.0

- Class-first CUA runtime: `CuaAgent` and `CuaHarness` on top of pi-agent-core.
- Provider-neutral browser tool executors for canonical CUA tool names, backed by Kernel browser actions.
- Includes examples plus unit and live e2e coverage for common provider/model combinations.

## Pre-collapse history: @onkernel/cua-pi-extension

### Unreleased

- Flags name the domain rather than an acronym: `--cua-tools` is now
  `--browser-tools`, `--cua-coordinates` is `--browser-coordinates`, and the
  commands are `/browser` and `/browser-tools`.
- Browser configuration is one `--browser-options` JSON object forwarded verbatim
  to Kernel's browser-create call, replacing `--cua-profile-id`,
  `--cua-profile-save-changes`, `--cua-proxy-id`, and `--cua-browser-timeout`. A
  flag per create-call field grows every time the SDK does; JSON tracks it for
  free. The only default is `timeout_seconds: 600`. `--browser-session` still
  attaches an existing browser and cannot be combined with `--browser-options`.
  Note that `stealth` is no longer forced on — pass it in the JSON if you want it.

- `@onkernel/cua-cli` and the `cua` binary are removed. Everything the CLI built
  because it needed an agent front-end — sessions and resume, skills, the TUI,
  print and RPC modes, model selection — pi supplies, so the extension replaces
  it rather than reimplementing it. The `cua act` model-free executor path and
  the `--print -o jsonl` telemetry schema are gone with it.
- Add `@onkernel/cua-pi-extension`, an installable pi extension that contributes
  Kernel browser tools to pi's own agent session. The menu is eight entries, one
  per capability: `browser` and `computer` (primitives plus their batch form),
  `browser-act`, `playwright`, and the four provider-native surfaces —
  `anthropic-computer`, `anthropic-browser`, `openai-computer`, `google-browser`.
  Packaging variants are deliberately absent: `mixed`, the batch tools on their
  own, and the 37 individual tool names offered nothing the eight entries do not.
- A deactivated selection now reports itself on stderr in print and RPC modes,
  once per distinct reason. Previously the reason reached only the TUI status
  line, so a scripted run lost its tools silently, created no browser, and let
  the model answer from memory with exit 0.
- `/cua-tools` decides each entry's availability by compiling it on its own, and
  reports pairwise conflicts separately. It previously passed the current
  selection to the tool menu, whose verdicts are relative to that selection, so a
  selection that failed to compile marked every entry unavailable with its
  error — including entries that then activated fine.
- Provider-native surfaces work because the extension owns the stream for the
  providers it registers, swapping pi's registry model for the compiled catalog's
  model — which carries the transport the selected tools derive — and passing the
  incoming native-call plan. Without that, `requiresApi` never takes effect and
  native calls arrive unnormalized.
- A selection is validated by compiling it for the active model, so an
  incompatible tool deactivates with the catalog compiler's own reason instead of
  failing at request time. `/cua-tools` with no argument lists every selector for
  the current model with those reasons.
- One browser is provisioned lazily per session on first tool execution and
  deleted on shutdown if this session created it. Declaration compilation, header
  generation, and payload transforms never provision a browser.
