# Changelog

## Unreleased

Breaking: `CuaAgent` and `CuaAgentHarness` now require one exact `tools` list and
use composition instead of inheriting from pi's `Agent`/`AgentHarness`.

- Add `getTools()` and atomic `setTools()`. Model changes recompile and
  revalidate the full requested catalog. Empty catalogs are valid;
  no tools or system-prompt text are inferred or appended.
- Remove `mode`, `nativeTool`, `extraTools`, `playwright`, `setMode()` /
  `getMode()`, and implicit `computer_use_extra` behavior.
- Add one shared `CuaExecutionResources` pool per agent/harness. Catalog and
  model changes preserve the canonical translator, lazy raw-CDP browser
  executor, refs, tabs, screenshots, and Playwright capability.
- Integrate pi 0.80.10 dynamic tool loading. Eligible additions made from inside
  a running tool emit `addedToolNames`; outside-tool additions and all
  provider-native changes are eager. Schema/executor replacements are treated
  as real changes, not name-only no-ops.
- Refactor atomic tools to operation-specific argument objects while preserving
  the existing `browser_act` schema.
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
  the CLI, including explicit `browser_act` plans for structured CUA-browser
  catalogs plus Anthropic native-browser selection and model fallback.

## 0.7.0 - 2026-07-17

- `CuaAgent` and `CuaAgentHarness` support Moonshot Kimi K3
  (`moonshotai:kimi-k3`) via `@onkernel/cua-ai` 0.7.0, resolving auth from
  `MOONSHOT_API_KEY`. Kimi's fractional coordinates are scaled to viewport
  pixels by the existing translator.
- Bumped `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` to
  0.80.10; the wrapped `Models` collections forward the new
  `checkAuth`/`getAvailable`/`login`/`logout` methods.

## 0.6.0 - 2026-07-10

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

## 0.5.0 - 2026-07-09

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

## 0.4.0 - 2026-07-07

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

## 0.3.5 - 2026-06-24

- Update the `@onkernel/cua-ai` dependency to 0.3.2, adding computer-use
  support for the `gemini-3.5-flash` Google model.

## 0.3.4 - 2026-06-23

- Add an opt-in `playwright` option to `CuaAgent` and `CuaAgentHarness` that
  exposes a `playwright_execute` tool, running Playwright/TypeScript against
  the live browser session via the Kernel SDK. Results, stdout, and stderr
  come back as tool content; SDK-reported failures surface as content rather
  than throwing. Adds the `PlaywrightDetails` export.

## 0.3.3 - 2026-06-12

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

## 0.3.2 - 2026-06-11

- Update the `@onkernel/cua-ai` dependency to 0.2.2.

## 0.3.1 - 2026-06-11

- Update the `@onkernel/cua-ai` dependency to 0.2.1.

## 0.3.0 - 2026-06-10

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

## 0.2.0 - 2026-05-13

- Adds `CuaAgentHarness`, a provider-aware harness API with session-backed turns, resource and prompt helpers, active tool selection, and model switching.
- Keeps CUA runtime defaults in sync when changing models so provider-specific tools, prompts, and payload middleware update together.
- Improves browser keyboard shortcut translation for Kernel computer actions.

## 0.1.0

- Class-first CUA runtime: `CuaAgent` and `CuaHarness` on top of pi-agent-core.
- Provider-neutral browser tool executors for canonical CUA tool names, backed by Kernel browser actions.
- Includes examples plus unit and live e2e coverage for common provider/model combinations.
