# @onkernel/cua-pi-extension

An installable [pi](https://pi.dev) extension that adds explicit, function-shaped
Kernel browser tools to pi's existing agent session. It does not start `cua`,
create a second model loop, or add implicit screenshots or prompt instructions.

## Install

```sh
pi install ./packages/pi-extension
# or after publishing
pi install npm:@onkernel/cua-pi-extension
```

The first browser tool call requires `KERNEL_API_KEY`. `KERNEL_BASE_URL` is
honored. The extension never writes either value to session entries or output.

## Use

No selector means no CUA tool is active and no browser is provisioned.

```sh
pi -p --provider openai --model gpt-5.6-sol \
  --cua-tools browser,browser-act "Open example.com and report its heading"

pi --mode rpc --no-session --provider openai --model gpt-5.6-sol \
  --cua-tools browser
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
  `computer-batch`, and `playwright` add one corresponding tool. Individual
  canonical names are also selectors.

Flags: `--cua-coordinates pixels|normalized-1000`,
`--cua-browser-session ID`, `--cua-profile-id ID`, `--cua-proxy-id ID`,
`--cua-browser-timeout SECONDS`, and `--cua-profile-save-changes`.
An attached session cannot be combined with profile or proxy flags. The
extension deletes only browsers it created at normal pi session shutdown.

## Limits

This v1 supports CUA-authored **function tools** only. It intentionally does
not expose provider-native OpenAI, Anthropic, Google, Tzafon, or Yutori CUA
calls: pi extension hooks cannot atomically replace the active provider stream
or normalize native response items. Browser state can survive when attached,
but element refs are process-local; take a fresh snapshot after reload, resume,
or fork.
