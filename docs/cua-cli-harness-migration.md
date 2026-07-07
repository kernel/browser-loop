# cua-cli → CuaAgentHarness migration plan

Status: completed.

`@onkernel/cua-cli` predates the public SDK packages. It hand-assembles a
pi 0.67 (`@mariozechner/*`) `Agent` from the deprecated provider packages
(`cua-translator`, `cua-openai`, `cua-anthropic`, `cua-gemini`, `cua-tzafon`,
`cua-yutori`), keeps its own model table, session format, skill loader, and a
600-line TOML config system. This plan replaces that with `CuaAgentHarness`
from `@onkernel/cua-agent` and pi 0.79 (`@earendil-works/*`), then deletes the
deprecated packages from the workspace.

Goals, in priority order:

1. Invent as little as possible — reuse pi for everything it offers (session
   storage, skills, compaction, TUI primitives), even at the cost of features.
2. Simplify everywhere.
3. cua-cli depends on `@onkernel/cua-agent` (plus `@onkernel/cua-ai` for the
   model catalog) — never on `cua-<provider>` or `cua-translator`.
4. `packages/agent` and `packages/ai` are frozen for this migration: no edits.
5. Clean composition, no leaky abstractions.
6. Well tested; radical test-suite changes are acceptable.

## Verified facts the plan relies on

- `@onkernel/cua-agent` re-exports **all** of pi-agent-core 0.79: the CLI gets
  `JsonlSessionRepo`, `Session`, `loadSkills`, `loadPromptTemplates`,
  `formatSkillsForSystemPrompt`, `compact()`/`shouldCompact`/
  `estimateContextTokens`, `NodeExecutionEnv`, and harness event types through
  that one dependency.
- `AgentHarnessEvent = AgentEvent | AgentHarnessOwnEvent` — one
  `harness.subscribe()` carries streaming text deltas, tool execution events,
  and harness lifecycle events (model/thinking/tools updates, compaction,
  queue updates).
- The harness rebuilds context from its `Session` every turn. Resume is
  "reopen the jsonl session and construct the harness" — no transcript
  seeding code.
- Harness compaction is **manual** (`harness.compact()`), using pi's
  `DEFAULT_COMPACTION_SETTINGS`. There is no auto-compaction in the run loop.
- The harness does **not** inject skills into the system prompt; apps compose
  it. The CLI's `systemPrompt` callback composes
  `resolveCuaRuntimeSpec(model).defaultSystemPrompt` (from `@onkernel/cua-ai`,
  stays correct across `setModel`) + `formatSkillsForSystemPrompt(resources.skills)`.
- pi-coding-agent 0.79's `InteractiveMode`/`AgentSession` wrap pi's `Agent`
  class, not `AgentHarness` — its app shell cannot host the harness. The
  interactive UI is rebuilt on pi-tui primitives instead. pi-tui 0.79 provides
  `Markdown`, `Image` (kitty/iTerm2), `Editor` (autocomplete), `SelectList`,
  overlays, keybindings, `ProcessTerminal`.
- The harness streams through a pi `Models` collection: a test fixture can
  build a `createCuaModels()` collection with a scripted provider and pass it
  to `buildCuaHarness({ models })`, and the real harness routes model calls
  through it. This replaces the `InteractiveDriver` test seam.
- `@onkernel/cua-ai` owns the model catalog: `listCuaModels`,
  `parseCuaModelRef`, `getCuaModel`, `CuaModelRef` (`provider:model`), and the
  documented API-key env-var conventions (`getCuaEnvApiKey`).
- `KernelBrowser` (cua-agent) is just the SDK's
  `BrowserCreateResponse | BrowserRetrieveResponse`; browser provisioning is
  plain `@onkernel/sdk` (`client.browsers.create/retrieve/deleteByID`,
  `client.browsers.computer.captureScreenshot`). `cua-translator`'s
  `browserSession` wrapper is unnecessary.
- In the action subcommands, `screenshot` is already model-free; the turn cap
  is implemented by counting `turn_end` events and aborting — the same pattern
  works on harness events.
- Canonical CUA tool schemas (cua-ai) make the per-provider tool-arg sniffing
  in `action/result.ts` (anthropic `computer` vs gemini `click_at` shapes)
  obsolete: `tool_call` events carry canonical `CuaAction` args.

## Target architecture

Dependencies after the migration:

| package | why |
|---|---|
| `@onkernel/cua-agent` | `CuaAgentHarness` + all pi-agent-core re-exports |
| `@onkernel/cua-ai` | model catalog + API-key env helpers (catalog is not re-exported by cua-agent, and packages/agent is frozen) |
| `@onkernel/sdk` | Kernel client: browser lifecycle, screenshots |
| `@earendil-works/pi-tui` `0.79.x` | TUI components |
| `@earendil-works/pi-coding-agent` `0.79.x` | `createCodingTools(cwd)` only (bash/read/edit/write/grep/find/ls as harness `extraTools`) |
| `@onkernel/ptywright` (dev) | PTY-based TUI regression tests |

Removed: all `@mariozechner/*`, `@onkernel/cua-translator`,
`@onkernel/cua-{openai,anthropic,gemini,tzafon,yutori}`, `smol-toml`.

Module map (current → target):

| current | target |
|---|---|
| `agent.ts` (provider wiring, 384 ln) | deleted → `harness.ts`: one ~80-line assembly function building `CuaAgentHarness` from `{browser, client, env, session, model, skills, extraTools}`. Prod and test fixtures share it. |
| `models.ts` (own catalog, 211 ln) | deleted → `cua models` printer over `listCuaModels()`. `-m` accepts `provider:model` refs; bare ids accepted when they match exactly one catalog entry. CLI default: `openai:gpt-5.5`. |
| `config.ts` (TOML profiles, 600 ln) | deleted → env vars only: cua-ai key conventions + `KERNEL_API_KEY`. `<PROVIDER>_BASE_URL` env overrides spread onto the model object (a few lines). `--thinking <level>` flag (default `low`) replaces `reasoning_effort`. `cua config` subcommand removed. |
| `sessions.ts` + seeding/persistence glue | deleted → `JsonlSessionRepo`. `--continue` / `--resume` / `--session <ref>` resolve via `repo.list({cwd})` + `open`. Browser metadata via `session.appendCustomEntry("cua-browser", …)`. |
| `skills.ts` | deleted → pi `loadSkills(env, [~/.agents/skills, <cwd>/.agents/skills, ...--skill paths])` → harness `resources`. `/skill:<name>` → `harness.skill(name)`. |
| `agent-prompt.ts` | shrunk: first prompt of a fresh session attaches a screenshot via `client.browsers.computer.captureScreenshot` + `harness.prompt(text, { images })` (~15 ln). |
| `named-sessions.ts` | kept; metadata file format and path (`$XDG_DATA_HOME/cua/named-sessions/<name>.json`) unchanged; `browserSession.open` → SDK calls. |
| `action/*` | semantics preserved (see contracts below); driven by harness events; coordinate extraction reads canonical `CuaAction` args; `screenshot` stays a direct SDK call. |
| `output/jsonl.ts` | schema preserved; events sourced from `harness.subscribe`. |
| `tui/*` (~1,120 ln) | rebuilt on pi-tui 0.79 + harness events. `Markdown` for assistant text, `Image` for the screenshot widget, `Editor` autocomplete for slash commands (`/model`, `/thinking`, `/compact`, `/skill:<name>`). Thin custom status line + telemetry footer remain. `driver.ts` deleted. |
| `cli.ts` | kept as dispatch; slimmer (no config matrix, SDK provisioning, repo-based session policy). |

## Behavioral contracts to preserve

- Action subcommand exit codes: `0` ok, `1` not_found, `2` error/usage; compact
  single-line stdout (`formatCompact` behavior); errors to stderr.
- `--print -o jsonl` event schema (`session_created`, `browser_created`,
  `tool_call`, `tool_result`, `turn_done`, `assistant_text_done`,
  `run_complete`, `error`, plus opt-in deltas/images). Field sourcing changes;
  shape stays. Note schema version in the README.
- Named-session metadata files and `cua session start|stop|list|show` output.
- Session flags: `-c`, `-r`, `--session <path|prefix|latest>`, `--session-dir`,
  `--no-session`, `-s <name>` transcript continuation.
- `--skill` / `-ns` / `--no-skills`; `--image-protocol` / `CUA_IMAGE_PROTOCOL`.
- Browser flags: `--profile`, `--profile-no-save-changes`, `--browser-timeout`.

## Deliberate feature sacrifices

- TOML config, profiles, and per-model tuning blocks (`reasoning_effort`,
  `tool_preamble`, `compact_threshold`) — replaced by env vars, `--thinking`,
  cua-ai default prompts, and harness compaction defaults.
- Provider-side auto-compaction (OpenAI `context_management` injection,
  Anthropic context management) — replaced by manual `/compact` in the TUI.
  Optional follow-up: ~15-line auto-trigger using pi's `shouldCompact` +
  `estimateContextTokens` on turn end.
- Old session-file compatibility. The jsonl format changes; old transcripts
  are not migrated. The new sessions root must not crash on legacy files —
  verify `JsonlSessionRepo.list` tolerates them, otherwise use a `v2/`
  subdirectory under `$XDG_DATA_HOME/cua/sessions`.
- Startup "Context files" display: today `AGENTS.md` etc. are displayed but
  never reach the model — cut. (Wiring them properly is a possible follow-up.)

## Test strategy

- **Scripted provider fixture**: a test-only pi provider placed in a
  `createCuaModels()` collection, whose `streamSimple` replays declarative
  steps (text deltas, canonical CUA tool calls, errors, await-abort) — port
  of the current `ScriptedDriver` JSON step DSL, moved below the harness.
- **Fake Kernel client**: plain object stubbing
  `browsers.computer.{batch,captureScreenshot,readClipboard}` etc. (pattern
  already proven in `packages/agent/test`).
- Fixtures assemble a **real `CuaAgentHarness`** through the same `harness.ts`
  used by prod — tests exercise argparsing → harness → tools → rendering.
- ptywright remains the TUI regression harness; port the existing fixtures
  (streaming render, multiline input, ctrl+c abort/recover, error rendering).
- New coverage that does not exist today: `--print` text output, jsonl schema
  snapshot, action subcommand exit codes/stdout, session resume,
  named-session lifecycle.
- Standardize on vitest (drops the build-before-test requirement of
  `node --test dist/...`) and **add cua-cli tests to CI** — they run nowhere
  today.
- Cut with their features: config-cascade tests, provider arg-shape parsing
  tests.

## PR sequence

Strictly ordered; each PR merges before the next starts.

### PR 1 — engine: harness assembly + non-interactive surface

- Add `harness.ts` (assembly), SDK-based browser provisioning, jsonl-repo
  sessions, pi skills loading, env-var auth, `cua models` on the cua-ai
  catalog.
- Port `--print`, all action subcommands, and the jsonl sink to the harness.
- Add the scripted-provider + fake-Kernel test infra, vitest config, and CI
  wiring for cua-cli tests.
- Interactive mode **stays on the old stack** in this PR; `cli.ts` dispatches
  interactive → old wiring, everything else → new wiring. Old and new dep
  trees coexist temporarily (different npm scopes; no conflict). Reviewers:
  this transitional state is intentional.
- Verify here: pi-coding-agent 0.79 `createCodingTools` output is assignable
  to harness `extraTools`; first-prompt screenshot via
  `harness.prompt(text, { images })`; legacy session files don't break
  `JsonlSessionRepo.list`.
- Acceptance: monorepo build green; new vitest suites green in CI; action
  exit-code/stdout and jsonl contracts covered by tests; no edits under
  `packages/agent` or `packages/ai`.

### PR 2 — interactive TUI on harness + pi-tui 0.79

- Rebuild the interactive app on `harness.subscribe()`: message list
  (Markdown), screenshot widget (pi-tui `Image`), status line, telemetry
  footer, editor with autocomplete-backed slash commands (`/model` via
  `setModel` with CUA refs, `/thinking`, `/compact`, `/skill:<name>`).
- Keep `--debug-tui` and image-protocol override on pi-tui 0.79 APIs.
- Replace `tui/testing/*` with fixtures that assemble the real harness over
  the scripted provider; port the four ptywright scenarios; delete
  `driver.ts`.
- Acceptance: interactive path no longer imports `agent.ts`/old config;
  ptywright suite green in CI.

### PR 3 — purge legacy code from cua-cli

- Delete `agent.ts`, old `models.ts`, `config.ts`, old `sessions.ts`,
  `skills.ts`, `agent-prompt.ts` remnants; drop `@mariozechner/*`,
  `@onkernel/cua-translator`, all `@onkernel/cua-<provider>`, `smol-toml`
  from `package.json`.
- Update `--help`, README (env-var auth, model refs, removed `cua config`),
  and the package description.
- Acceptance: `npm ls` for cua-cli shows none of the removed packages;
  full build + tests green.

### PR 4 — remove deprecated packages from the workspace

- Delete `packages/cua-{translator,openai,anthropic,gemini,tzafon,yutori}`;
  update root `package.json` workspaces, root tsconfig references, CI, README
  workspace table + mermaid diagram, and any references under `docs/` and
  `skills/`.
- Acceptance: clean `npm install` + build + tests from a fresh checkout.

## Manual follow-ups after the migration

- Decide on auto-compaction trigger and proper context-file injection.
- Release a new `@onkernel/cua-cli` version per `docs/npm-releases.md`.
