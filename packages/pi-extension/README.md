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

### Selectors

| selector | tools |
| --- | --- |
| `browser` | the CDP browser toolset |
| `computer` | the canonical computer toolset |
| `mixed` | both, deduplicated |
| `browser-act` | `browser_act` alone, the verified-plan tool |
| `browser-batch`, `computer-batch` | one mechanical batch tool |
| `playwright` | `playwright_execute` |
| `anthropic-computer` | Anthropic's native computer tool |
| any individual tool name | that tool alone |

Anthropic's native computer tool is the only provider-native surface available
here. OpenAI's native computer and Google's predefined browser set need the
transport their compiled model derives, and pi streams its own registry model, so
that api never reaches the wire. Anthropic's native *browser* tool has a
function-tool fallback for a credential without beta access, and that fallback
reads stream options pi builds. Reaching any of them means this extension owning
the stream through a registered provider's `streamSimple`.

`--cua-coordinates` selects `pixels` (default) or `normalized-1000` for the
computer toolset's coordinate contract.

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
