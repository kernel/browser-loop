# Changelog

## Unreleased

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
