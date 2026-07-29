# Changelog

## Unreleased

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
