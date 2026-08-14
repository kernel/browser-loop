# `@onkernel/cua-cli`

The CLI / TUI binary for the [`cua`](../../README.md) monorepo. Wires
[`@onkernel/cua-agent`](../agent)'s `CuaAgentHarness` to
[`pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui) for an
interactive front-end and to
[`pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)'s
coding tools for workspace access.

## Install

```bash
# global install (puts `cua` on your PATH):
npm install -g @onkernel/cua-cli
cua --help

# or run a one-off without installing:
npx @onkernel/cua-cli --help
```

Requires Node >= 22.19.0.

## Usage

```bash
# Interactive TUI:
cua

# Single-shot prompt:
cua --print "open https://example.com and tell me the heading"

# Constrained one-shot subcommands (deterministic exit codes):
cua open https://example.com
cua snapshot --filter interactive
cua act '{"steps":[{"type":"click","ref":"e12","expect":{"type":"text","text":"Done"}}]}'
cua click "Sign in button"
cua type "email field" "alice@example.com"
cua press ctrl l                              # Ctrl+L (focus address bar)
cua url
cua observe "what page is loaded?"
cua screenshot --out shot.png
cua do "buy a pair of socks on amazon" --max-steps 20

# List and pick supported models:
cua models
cua models -p openai
cua --print --model openai:gpt-5.6-sol "..."
cua --print --model anthropic:claude-opus-5 "..."
cua --print --model google:gemini-3.6-flash "..."
cua --print --model openrouter:meta/muse-spark-1.1 "..."
cua --print --model xai:grok-4.5 "..."
cua --print --model moonshotai:kimi-k3 "..."

# Named sessions (browser stays alive across calls):
cua session start login                       # provisions Kernel browser
cua -s login open https://github.com/login
cua -s login type "email field" "$EMAIL"
cua -s login click "Sign in"
cua session stop login

cua session list                              # NAME / KERNEL_ID / AGE / LIVE_URL
cua session show login                        # full JSON metadata

# Resume a prior session transcript into a fresh browser:
cua --continue
cua --resume                                  # picker
cua --session abc12345                        # by id prefix
```

## Interactive commands

Inside the TUI, `/` opens the command autocomplete. The supported commands are:

| Command | Behavior |
| --- | --- |
| `/model` | Open an interactive, searchable model picker. |
| `/model <provider:model>` | Switch directly, without opening the picker. An unresolvable ref reports the error and then opens the picker prefilled with what you typed. |
| `/tools` | Open the model's tool menu and change this session's selection. |
| `/thinking <level>` | Set the reasoning level for future turns. |
| `/compact` | Summarize older turns to free context budget. |
| `/skill:<name> [args]` | Invoke a loaded skill. |

### `/model` picker

Type to fuzzy-search across the provider, ref, model id, and display name.
`↑`/`↓` move (wrapping at both ends), `enter` selects, `esc` or `ctrl+c`
cancels. The active model is listed first and marked with `✓`. Selecting a model
runs the same switch as `/model <ref>`, including the tool revalidation
described below. Nothing is written to disk except a named session's recorded
model (`-s`).

The picker lists every CUA-capable model; it does not check whether the
provider's API key is set. Run `cua models` for the same catalog on stdout.

### `/tools` picker

`/tools` lists everything CUA can offer the active model — every browser and
computer tool, `playwright_execute`, the provider-native surfaces the model has,
and the CLI's own coding tools — with the current session's selection marked.
You can add tools the CLI did not compose, not just remove ones it did.

A tool the model cannot take is shown as unavailable and cannot be selected,
with the reason on the detail line. Availability is decided by compiling the
resulting catalog, so it matches exactly what the session will accept, and it is
re-evaluated as you stage: selecting a provider-native surface pins the
transport, which can make other rows unavailable.

`cua tools` prints the same menu to stdout for a model, without the TUI.

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move the cursor |
| `enter` | Toggle the highlighted tool |
| `space` | Toggle the highlighted tool (only while the search box is empty, so queries stay typeable) |
| `ctrl+a` / `ctrl+x` | Enable / disable everything listed (respects an active search) |
| `ctrl+r` | Reset to the model's defaults |
| `ctrl+s` | Apply the selection |
| `esc` | Cancel |
| `ctrl+c` | Clear an active search, or cancel when the search box is empty |

Edits are staged: nothing is applied until `ctrl+s`, and cancelling leaves the
live tool list untouched. Applying calls the harness's `setTools()`, which
compiles and validates the whole catalog before mutating anything — so a
rejected selection reports the error and leaves the session unchanged.

Disabling every tool is allowed and yields a text-only agent.

Selections are session-only and never persisted. `/model` rebuilds the tool list
from the new model's defaults and reports `tool selection reset to the new
model's defaults`; tool identities are provider-specific, so a previous
selection is not carried across a model change.

Both pickers are unavailable while a turn is running: recompiling the tool
catalog while a request is streaming is unsafe, so the TUI refuses to open them.
(The agent's own execution-scope guard only covers mutation attempted from
*inside* a tool's `execute`, so this TUI-side check is the protection here.)

## Models

Run `cua models` to list every supported `-m` / `--model` value and the
provider it routes to. Filter by provider with `cua models -p openai`,
`cua models -p anthropic`, `cua models -p google` (alias: `gemini`),
`cua models -p meta`, `cua models -p xai`, `cua models -p moonshotai`
(alias: `moonshot`), or `cua models -p openrouter`.

`-m` / `--model` accepts a provider-qualified `provider:model` ref (e.g.
`openai:gpt-5.6-sol`) or a bare model id when it matches exactly one catalog
entry. The default is `openai:gpt-5.6-sol`.

## Configuration

Configuration is by environment variable. There is no config file.

| Env                  | Used for                                       |
| -------------------- | ---------------------------------------------- |
| `KERNEL_API_KEY`     | Kernel API key (required)                      |
| `OPENAI_API_KEY`     | OpenAI API key (required when `-m openai:…`)   |
| `ANTHROPIC_API_KEY`  | Anthropic API key (required when `-m anthropic:…`) |
| `GOOGLE_API_KEY`     | Google API key (required when `-m google:…`)   |
| `GEMINI_API_KEY`     | alias of `GOOGLE_API_KEY`                      |
| `XAI_API_KEY`        | xAI API key (required when `-m xai:…`)          |
| `MOONSHOT_API_KEY`   | Moonshot AI API key (required when `-m moonshotai:…`) |
| `OPENROUTER_API_KEY` | OpenRouter API key (required when `-m openrouter:…`) |
| `KERNEL_BASE_URL`    | override Kernel base URL                       |
| `OPENAI_BASE_URL`    | override OpenAI base URL                       |
| `ANTHROPIC_BASE_URL` | override Anthropic base URL                    |
| `GOOGLE_BASE_URL`    | override Google base URL                       |
| `META_BASE_URL`      | override Meta Model API base URL               |
| `XAI_BASE_URL`       | override xAI API base URL                       |
| `MOONSHOTAI_BASE_URL` | override Moonshot AI base URL                  |
| `XDG_DATA_HOME`      | sessions dir base (defaults to `~/.local/share`) |
| `CUA_IMAGE_PROTOCOL` | force inline image protocol (`kitty`/`iterm2`/`none`/`auto`) |

Use `--thinking <level>` (`off | minimal | low | medium | high | xhigh | max`,
default `low`) for providers that support reasoning effort.

The CLI chooses one explicit interaction catalog and appends pi's coding tools:
CUA browser primitives plus the verified `browser_act` plan tool for OpenAI,
Meta, xAI, and older Anthropic models; browser primitives alone for Moonshot,
whose API rejects `browser_act`'s larger schema; Anthropic's native browser tool
when supported; and Google's native browser action set. If the active Anthropic
credential cannot access `browser_20260701`, the same selected browser tool uses
its equivalent function transport. Library callers can select any catalog
directly; see [`@onkernel/cua-agent`](../agent).

## Output formats

`--print` defaults to streaming text. Pass `-o jsonl` for one
structured event per line (good for scripting):

```bash
cua --print -o jsonl "open https://example.com" \
  | jq -c 'select(.type=="tool_call" or .type=="assistant_text_done")'
```

Add `--jsonl-include-deltas` for assistant-token deltas and
`--jsonl-include-images` for base64 screenshots in `tool_result` events.

The first event of every `--print -o jsonl` run is
`session_created` with a `schema_version` field. The current schema
version is `2`. The `model` field carries a provider-qualified ref
(e.g. `openai:gpt-5.6-sol`); use `parseCuaModelRef` from `@onkernel/cua-ai`
if you only need the bare model id.

Every assistant message also emits an `assistant_usage` event (including
tool-only turns with no text): `turn`, `model`, `api`, `input`, `output`,
`cache_read`, `cache_write`, `reasoning`, `total_tokens`, and
`cache_hit_ratio`. OpenAI's billed prompt tokens are `input + cache_read +
cache_write` (the provider already subtracts cached and cache-write tokens
out of `input`), so `cache_hit_ratio` is `cache_read` over that total,
reported as `0` when the total is `0`.

## Sessions and transcripts

`--print`, the interactive TUI, and any `-s <name>` invocation persist
a JSONL transcript to
`$XDG_DATA_HOME/cua/sessions/<cwd-hash>/<id>.jsonl` by default
(typically `~/.local/share/cua/sessions/...`). Pass `--no-session` to
keep a run in-memory only, or `--session-dir <path>` to override the
location.

For named sessions, the exact transcript path is in
`cua session show <name>` under `transcript_path`. See the
[Session transcripts section in the top-level README](../../README.md#session-transcripts)
for the JSONL schema and `jq` analysis examples.

## Skills and context

`cua` resolves skills and context files through pi's resource loader
(the same loader pi's own TUI uses), so the discovery set matches pi.
Skills load from:

- `~/.agents/skills/` (user-global, the cross-agent
  [`~/.agents/skills/`](https://agentskills.io) standard)
- `<cwd>/.agents/skills/` (project-local)
- the pi agent dir (`~/.pi/agent/`)
- pi-installed packages (`pi install …` records the package in pi's
  settings and clones it under the agent dir; its bundled skills load
  here too)

Plus any explicit `--skill <path>` flags. Disable with `--no-skills`
(`-ns`).

Each skill's `name`, `description`, and file `location` are added to
the system prompt; the model uses the `read` tool to load a skill's
full body when its description matches the task. Use `/skill:<name>`
in a prompt to force-load a skill body inline.

Context files (`AGENTS.md` / `CLAUDE.md`) discovered by the resource
loader are appended to the system prompt and listed in the TUI's
`[Context]` section. `--no-skills` disables skill discovery only;
context files still load, since they describe the project rather than
add agent capabilities.

pi *extensions* are not executed by `cua`: extensions bind into pi's
`AgentSession`, and `cua` drives the lower-level `AgentHarness`
directly. Installed-package skills and context still load.

## Image protocol

Force the inline-screenshot protocol with `--image-protocol` or
`CUA_IMAGE_PROTOCOL`:

- `kitty`  — Kitty graphics protocol (also covers Ghostty / WezTerm).
- `iterm2` — iTerm2 inline images.
- `none`   — disable inline images; show a compact text card instead.
- `auto`   — auto-detect based on `TERM_PROGRAM` / `TMUX` / etc. (default).

The TUI prints the resolved capability as the second header line so
you can see at a glance whether inline images will render.

## License

MIT.
