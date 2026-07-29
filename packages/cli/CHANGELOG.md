# Changelog

## Unreleased

Breaking: the CLI now assembles one explicit model-specific tool list.

- Remove `--mode`, `--native-tool`, `--playwright`, and the interactive `/mode`
  command.
- Select browser-oriented provider defaults explicitly in
  `packages/cli/src/harness.ts`: CUA browser primitives plus the verified
  `browser_act` plan tool for OpenAI, Meta, xAI, Moonshot, and older Anthropic
  models; native browser tools for current Anthropic, Google, and Yutori
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
