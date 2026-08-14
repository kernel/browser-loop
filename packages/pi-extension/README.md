# `@onkernel/cua-pi-extension`

An installable [pi](https://pi.dev) extension that adds Kernel browser tools to
pi's existing agent session. pi owns the agent loop, session, and UI; this
extension contributes the tools, the browser they run against, and the provider
wiring that provider-native surfaces need.

It does not start a second model loop, and it adds no implicit screenshots or
prompt instructions.

## Install

```sh
pi install ./packages/pi-extension
# or, once published
pi install npm:@onkernel/cua-pi-extension
```

`KERNEL_API_KEY` is required when a tool first executes, not at startup.
`KERNEL_BASE_URL` is honored. Neither is written to session entries or output.

## Use

No selector means no Kernel tool is active and no browser is provisioned.

```sh
pi -p --provider openai --model gpt-5.6-sol \
  --cua-tools browser,browser-act "Open example.com and report its heading"

pi --mode rpc --no-session --provider openai --model gpt-5.6-sol --cua-tools browser

pi -p --provider anthropic --model claude-opus-5 --cua-tools anthropic-computer \
  "Open example.com and report its heading"
```

### The menu

Eight entries, one per capability. Availability is per model, and `/cua-tools`
tells you which apply to the one you selected.

| entry | tools | works on |
| --- | --- | --- |
| `browser` | CDP browser primitives plus the one-call `browser_batch` form | every provider |
| `computer` | canonical computer primitives plus `computer_batch` | every provider |
| `browser-act` | `browser_act`, the verified-plan tool | every provider except Moonshot, which rejects its schema size |
| `playwright` | `playwright_execute` | every provider |
| `anthropic-computer` | Anthropic's native computer tool | Anthropic only |
| `anthropic-browser` | Anthropic's native browser tool | Anthropic only |
| `openai-computer` | OpenAI's native computer tool | OpenAI only |
| `google-browser` | Google's predefined browser action set | Google only |

`anthropic-browser` and `anthropic-computer` cannot be selected together:
Anthropic rejects the pair because the browser tool addresses a viewport
coordinate frame and the computer tool a display frame. The catalog compiler
refuses it before the request goes out, and `/cua-tools` reports it as a conflict
rather than as unavailability.

`--cua-coordinates` selects `pixels` (default) or `normalized-1000` for the
`computer` entry's coordinate contract.

### Commands

- `/cua` — current selectors, active tools, and browser status.
- `/cua-tools` — with no argument, list every selector for the current model,
  marking the selected ones and showing the compiler's own reason for any that
  this model cannot take. With an argument, replace the selection. `none` clears
  it.

A selection is checked by compiling it, so a model that cannot take a tool
deactivates it with a reason rather than failing at request time. Switching
models re-checks, and restores a previously forced-off selection when the new
model can take it.

In TUI mode the reason appears in the status line. In print and RPC modes there
is no status line, so the reason is written to **stderr** — once per distinct
reason. Without that, a deactivated selection is invisible: the tools are gone,
no browser is created, and the model answers from memory with exit 0.

### Browser

| flag | effect |
| --- | --- |
| `--cua-browser-session` | attach an existing session; never deleted on exit |
| `--cua-profile-id`, `--cua-profile-save-changes` | load and optionally persist a profile |
| `--cua-proxy-id` | route through a Kernel proxy |
| `--cua-browser-timeout` | owned-browser timeout in seconds (default 300) |

One browser is provisioned lazily per session, on first tool execution.
Compiling declarations, generating headers, and transforming a payload never
provision one. An owned browser is deleted on session shutdown.

## Development

```bash
npm run typecheck --workspace @onkernel/cua-pi-extension
npm test --workspace @onkernel/cua-pi-extension
```

The test suite includes an end-to-end run that spawns real `pi` in print and RPC
modes against a fake provider and Kernel server.

## License

MIT
