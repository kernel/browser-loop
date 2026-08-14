# Changelog

## Unreleased

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

## 0.10.0 - 2026-08-04

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

## 0.9.0 - 2026-08-03

- Add OpenRouter Kimi K3 support through `@onkernel/cua-ai` 0.9.0,
  including the browser-primitives-only example catalog used by the provider
  matrix.
- Resolve `CuaAgentHarness` string model references against its supplied
  `Models` collection during construction and `setModel()`, while preserving
  the curated CUA model gate and fallback support for CUA model overrides.
- Keep `CuaAgent` aligned with pi's low-level `Agent`: callers can pass a
  concrete OpenRouter model and inject `models.streamSimple` without adding a
  `Models` dependency to the agent API.

## 0.8.0 - 2026-07-31

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
