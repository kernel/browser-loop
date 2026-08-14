# Changelog

## Unreleased

- Add `@onkernel/cua-pi-extension`, an installable pi extension that contributes
  Kernel browser tools to pi's own agent session. Selectors cover the CDP browser
  toolset, the canonical computer toolset, the batch and Playwright tools, and
  every provider-native surface: Anthropic's computer and browser tools, OpenAI's
  native computer tool, and Google's predefined browser action set.
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
