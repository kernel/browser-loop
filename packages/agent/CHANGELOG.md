# Changelog

## 0.5.0 - 2026-07-09

Breaking: adds the browser action plane and runtime mode switching; removes
the `javascriptExec` and `computerUseExtra` options.

- New `BrowserExecutor`: drives the browser plane over CDP. Accessibility
  snapshots with element refs (`[e12]`) and node states
  (checked/expanded/disabled/value/…), iframe and OOPIF stitching with
  per-frame session-aware refs, StaticText dedupe and wrapper collapsing, an
  unchanged-snapshot short-circuit, lexical `find`, `fill`, CDP navigation
  and tab management, and a JavaScript dialog guard. Refs invalidate on real
  navigations (`Page.frameNavigated`), self-heal via (role, name, nth) when
  the page changes but the element is still unambiguous, and the ref table is
  bounded (per-target cap, generation sweeps). `exportRefState()` /
  `importRefState()` persist refs across processes against the same browser.
- `CuaAgent` and `CuaAgentHarness` accept `mode` (`"computer"` | `"browser"`
  | `"hybrid"`) and `nativeTool`, and support runtime plane switching via
  `setMode()` / `getMode()`; mode switches preserve the requested activation
  state of surviving tools, dispose the previous translator's CDP
  connection, and roll back cleanly on failure (as does `setModel()`).
- Post-action grounding captures and the navigation helper are mode-aware:
  browser mode grounds on the viewport and routes navigation through CDP
  (browser and hybrid modes both route `computer_use_extra` navigation over
  the browser plane so refs invalidate correctly).
- New `cursorHints` option marks cursor:pointer elements as clickable hints
  in browser-mode snapshots (default off).
- Breaking: `computerUseExtra` is removed — the `computer_use_extra`
  navigation helper is always registered (deduped by name against caller
  executors). `javascriptExec` is removed — see `@onkernel/cua-ai` 0.5.0.
- Breaking: `BrowserExecutor` is constructed from a CDP WebSocket URL and
  owns its connection; `createBrowserExecutor` remains the injection seam on
  the translator options.
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
