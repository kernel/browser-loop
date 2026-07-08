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
cua --print --model openai:gpt-5.5 "..."
cua --print --model anthropic:claude-opus-4-7 "..."
cua --print --model google:gemini-3-flash-preview "..."
cua --print --model yutori:n1.5-latest "..."

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

## Models

Run `cua models` to list every supported `-m` / `--model` value and the
provider it routes to. Filter by provider with `cua models -p openai`,
`cua models -p anthropic`, `cua models -p google` (alias: `gemini`), or
`cua models -p yutori`.

`-m` / `--model` accepts a provider-qualified `provider:model` ref (e.g.
`openai:gpt-5.5`) or a bare model id when it matches exactly one catalog
entry. The default is `openai:gpt-5.5`.

## Configuration

Configuration is by environment variable. There is no config file.

| Env                  | Used for                                       |
| -------------------- | ---------------------------------------------- |
| `KERNEL_API_KEY`     | Kernel API key (required)                      |
| `OPENAI_API_KEY`     | OpenAI API key (required when `-m openai:…`)   |
| `ANTHROPIC_API_KEY`  | Anthropic API key (required when `-m anthropic:…`) |
| `GOOGLE_API_KEY`     | Google API key (required when `-m google:…`)   |
| `GEMINI_API_KEY`     | alias of `GOOGLE_API_KEY`                      |
| `TZAFON_API_KEY`     | Tzafon API key (required when `-m tzafon:…`)   |
| `YUTORI_API_KEY`     | Yutori API key (required when `-m yutori:…`)   |
| `KERNEL_BASE_URL`    | override Kernel base URL                       |
| `OPENAI_BASE_URL`    | override OpenAI base URL                       |
| `ANTHROPIC_BASE_URL` | override Anthropic base URL                    |
| `GOOGLE_BASE_URL`    | override Google base URL                       |
| `TZAFON_BASE_URL`    | override Tzafon base URL                       |
| `YUTORI_BASE_URL`    | override Yutori base URL                       |
| `XDG_DATA_HOME`      | sessions dir base (defaults to `~/.local/share`) |
| `CUA_IMAGE_PROTOCOL` | force inline image protocol (`kitty`/`iterm2`/`none`/`auto`) |

Use `--thinking <level>` (`off | minimal | low | medium | high | xhigh`,
default `low`) for providers that support reasoning effort.

## Playwright escape hatch

Pass `--playwright` to expose the `playwright_execute` tool, letting the
model run Playwright/TypeScript directly against the live browser session
for steps that are awkward as raw pointer/keyboard actions (precise DOM
reads, form fills, data extraction, waiting on selectors). `page`,
`context`, and `browser` are in scope; the code may `return` a
JSON-serializable value. Off by default. Toggle mid-session with
`/playwright on` or `/playwright off`. Verified e2e with Anthropic,
Tzafon, and Yutori CUA models.

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
version is `1`. The `model` field carries a provider-qualified ref
(e.g. `openai:gpt-5.5`); use `parseCuaModelRef` from `@onkernel/cua-ai`
if you only need the bare model id.

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
