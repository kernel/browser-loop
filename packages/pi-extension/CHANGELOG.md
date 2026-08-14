# Changelog

## Unreleased

- Add `@onkernel/cua-pi-extension`, an installable pi extension that contributes
  Kernel browser tools to pi's own agent session. Selectors cover the CDP browser
  toolset, the canonical computer toolset, the batch and Playwright tools, and
  Anthropic's native computer tool. Other provider-native surfaces need the
  transport their compiled model derives, which pi does not stream, so they are
  deliberately absent rather than present and silently inert.
- A selection is validated by compiling it for the active model, so an
  incompatible tool deactivates with the catalog compiler's own reason instead of
  failing at request time. `/cua-tools` with no argument lists every selector for
  the current model with those reasons.
- One browser is provisioned lazily per session on first tool execution and
  deleted on shutdown if this session created it. Declaration compilation, header
  generation, and payload transforms never provision a browser.
