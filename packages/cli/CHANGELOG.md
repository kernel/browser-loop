# Changelog

## 0.8.0 - 2026-08-03

- Queue messages submitted during an active turn for steering at the next agent
  step. Pressing `esc` interrupts the active work and immediately starts a new
  turn with any steering messages that were still queued.

## 0.7.0 - 2026-08-03

- Add `openrouter:moonshotai/kimi-k3` model selection and
  `cua models -p openrouter`, authenticated with `OPENROUTER_API_KEY`.
- Use the same browser-primitives-only interaction catalog for Kimi K3 through
  Moonshot and OpenRouter; neither transport receives the unsupported
  `browser_act` schema.
- Resolve model references through the harness's `Models` collection so CLI
  model selection, authentication, and streaming use the same concrete pi-ai
  model.
- Update `@onkernel/cua-ai` and `@onkernel/cua-agent` to 0.9.0.

## 0.6.0 - 2026-07-31

Breaking: the CLI now assembles one explicit model-specific tool list.

- Remove `--mode`, `--native-tool`, `--playwright`, and the interactive `/mode`
  command.
- Select browser-oriented provider defaults explicitly in
  `packages/cli/src/harness.ts`: CUA browser primitives plus the verified
  `browser_act` plan tool for OpenAI, Meta, xAI, and older Anthropic models;
  browser primitives alone for Moonshot, whose API rejects `browser_act`'s
  schema; native browser tools for current Anthropic, Google, and Yutori
  models; and Tzafon's browser-scoped native computer tool. Then append pi
  coding tools into the same list.
- Change the default model to the verified `openai:gpt-5.6-sol`.
- Stop attaching screenshots automatically to first prompts. Models request an
  explicit browser/computer screenshot tool when visual feedback is needed.
- Keep an explicit CLI-owned coding-tool list across `/model` changes instead
  of inspecting the compiled interaction catalog.
- Make the CLI own its complete system prompt (skills and context); the agent no
  longer supplies provider defaults.
- Persist only the selected model in named-session runtime metadata. Legacy mode
  and native-tool fields are no longer read or written.
- Add model-free `cua act '<json>'` for direct `browser_act` execution with the
  same schema and bounded semantic feedback agents receive. It exits 0 only for
  a causally `worked` plan, 1 for `didnt`/`unknown`, and 2 for invalid input or
  execution errors.
- Keep action subcommands, print mode, JSONL output, named sessions, transcript
  resume, skills, and TUI model switching on the same explicit harness assembly
  path.
- Add an interactive, searchable `/model` picker, modelled on pi's own model
  selector: same frame, fuzzy search, centred 10-row scroll window,
  `[provider]` badges, `✓` on the active model, wrapping navigation, and
  single-press `esc`/`ctrl+c` cancel. `/model <provider:model>` still switches
  directly without opening any UI; an unresolvable ref now reports the error and
  then opens the picker prefilled with what was typed. Unlike pi's selector, the
  picker never writes global settings and does no background catalog refresh
  (cua's catalog is static).
- Add `/tools`, an interactive session-local menu for enabling/disabling the
  model-callable tools the CLI composed for the active model. It can only
  restrict that caller-owned list, never add tools the model does not support.
  Edits are staged and applied with `ctrl+s` (`enter` toggles, `space` toggles
  while the search box is empty, `ctrl+a` all, `ctrl+x` none, `ctrl+r` model
  defaults, `esc` cancel); cancelling leaves
  live state untouched, and a selection rejected by catalog validation reports
  the error without mutating the session. Provider-native sets that cannot be
  partially suppressed (Yutori n1) toggle as one group, and disabling everything
  is allowed.
- Reset the tool selection to the new model's defaults on `/model`, with a
  notice. Tool identities are provider-specific, so carrying a selection across
  a model change would silently substitute tools.
- Refuse to open either picker while a turn is running, because recompiling the
  tool catalog while a request is streaming is unsafe. (The agent's
  execution-scope guard only rejects mutation attempted from inside a tool's
  `execute`, so this TUI-side refusal is the protection for this case.)
- Serialize `/tools` applies and `/model` switches through one queue, so a
  queued `setTools()` can never land between a switch's `setModel()` and its
  final `setTools()` and fail the compile against the wrong provider.
- Fix `ctrl+c` and `ctrl+d` quitting the TUI while a selector is open: the
  global input listener now yields all input to an open picker.
- Register cua's `cua.tools.*` keybindings instead of constructing an unused
  `KeybindingsManager`, so bulk-action keys resolve and their hints render.
- Security: inherits the `sharp` `^0.35.3` upgrade through
  `@onkernel/cua-agent` 0.8.0 (GHSA-f88m-g3jw-g9cj). See that package's
  changelog for the installer-visible packaging notes.

### Known unfixed advisories

Installing this release still reports two vulnerable packages (three advisory
IDs). `npm audit` counts them as 1 high + 1 moderate, and both are reachable
only through `@earendil-works/pi-coding-agent` 0.80.10, which publishes its own
`npm-shrinkwrap.json` and therefore pins its subtree verbatim:

- **`brace-expansion` 5.0.6** (high) via that subtree's `minimatch` 10.2.5.
  This single package is flagged by two separate advisories:
  GHSA-mh99-v99m-4gvg (`<=5.0.7`, CVSS 7.5, unbounded expansion length causing
  an out-of-memory process crash) and GHSA-3jxr-9vmj-r5cp (`>=3.0.0 <5.0.7`,
  CVSS 5.3, exponential-time expansion of consecutive non-expanding `{}`
  groups). Both are denial of service on pathological glob patterns; the impact
  is a hung or OOM-killed local `cua` process, with no effect on the cloud
  browser or on other users.
- **`protobufjs` 7.6.4** (moderate, GHSA-j3f2-48v5-ccww) via `@google/genai`.
  Unreachable here: it is loaded only by `@google/genai`'s opt-in local
  tokenizer entry point, which this CLI never imports, and the advisory needs
  untrusted `.proto` source text, which the CLI never parses.

Neither is suppressed or filtered out of `npm audit`. npm `overrides` were
tried and verified to be silently ignored across a dependency's published
shrinkwrap (the pins stay at 5.0.6/7.6.4 and the audit count does not move), so
adding them would be dead configuration and false assurance.

`protobufjs` is fixed in `pi-coding-agent` 0.82.0+ (which pins 7.6.5); that
upgrade is deferred to a follow-up release because it is a two-minor bump of
the agent framework carrying a customer-visible provider behavior change
(pi-ai 0.82 revises Kimi K3's `compat` to `supportsReasoningEffort: true` and
`thinkingFormat` `"deepseek"` -> `"openai"`, altering the request payload sent
to Moonshot), which cannot be validated offline and is not worth bundling into
a security patch for an advisory that is unreachable from this CLI.

`brace-expansion` cannot be fully resolved from this repository at all. The
newest published `pi-coding-agent`, 0.83.0, pins 5.0.7, which clears
GHSA-3jxr-9vmj-r5cp but *not* GHSA-mh99-v99m-4gvg, whose range is `<=5.0.7`.
Clearing the remaining high requires an upstream shrinkwrap refresh to
`minimatch` 10.2.6, which is the first release to depend on
`brace-expansion` `^5.0.8`.
