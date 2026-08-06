# @onkernel/cua-pi-extension

An installable [pi](https://pi.dev) extension that adds explicit Kernel browser
tools to pi's existing agent session. It supports CUA function tools and
Anthropic's native computer tool. It does not start `cua`, create a second model
loop, or add implicit screenshots or prompt instructions.

## Install

```sh
pi install ./packages/pi-extension
# or after publishing
pi install npm:@onkernel/cua-pi-extension
```

Function tools require `KERNEL_API_KEY` when first called. Anthropic native
computer use provisions the browser before the first provider request so its
declared display dimensions match the session viewport. `KERNEL_BASE_URL` is
honored. The extension never writes either value to session entries or output.

## Use

No selector means no CUA tool is active and no browser is provisioned.

```sh
pi -p --provider openai --model gpt-5.6-sol \
  --cua-tools browser,browser-act "Open example.com and report its heading"

pi --mode rpc --no-session --provider openai --model gpt-5.6-sol \
  --cua-tools browser

pi -p --provider anthropic --model claude-fable-5 \
  --cua-tools anthropic-computer \
  "Open example.com and report its heading"
```

Use `/cua` to inspect the selected tools and browser ownership. Use
`/cua-tools browser,browser-act` to replace the session-local selection.
The command persists only selectors and browser metadata in pi's active branch.

## Selectors

- `browser`: `browser_snapshot`, `browser_text`, `browser_find`,
  `browser_click`, `browser_hover`, `browser_drag`, `browser_fill`,
  `browser_scroll_to`, `browser_scroll`, `browser_type`, `browser_key`,
  `browser_navigate`, `browser_list_tabs`, `browser_new_tab`,
  `browser_screenshot`, `browser_evaluate`, `browser_wait_for`.
- `computer`: `computer_click`, `computer_double_click`,
  `computer_mouse_down`, `computer_mouse_up`, `computer_type`,
  `computer_keypress`, `computer_scroll`, `computer_move`, `computer_drag`,
  `computer_wait`, `computer_screenshot`, `computer_goto`, `computer_back`,
  `computer_forward`, `computer_url`, `computer_cursor_position`.
- `mixed`: computer followed by browser. `browser-act`, `browser-batch`,
  `computer-batch`, and `playwright` add one corresponding function tool.
  Individual canonical function-tool names are also selectors.
- `anthropic-computer`: Anthropic's native `computer_20251124` tool, including
  Claude Fable 5, Sonnet 5, Opus 5, and supported later revisions.

Flags: `--cua-coordinates pixels|normalized-1000`,
`--cua-browser-session ID`, `--cua-profile-id ID`, `--cua-proxy-id ID`,
`--cua-browser-timeout SECONDS`, and `--cua-profile-save-changes`.
An attached session cannot be combined with profile or proxy flags. The
extension deletes only browsers it created at normal pi session shutdown.

## Limits

This version supports CUA function tools and Anthropic's documented native
computer-use protocol. The extension registers CUA's Anthropic provider wrapper
under the standard `anthropic` provider id; ordinary Anthropic requests continue
to delegate to pi's built-in transport.

Provider-native Anthropic browser use, OpenAI, Google, Tzafon, and Yutori calls
remain unsupported.
Browser state can survive when attached, but element refs are process-local;
take a fresh snapshot after reload, resume, or fork.
