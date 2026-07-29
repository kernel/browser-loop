# cua

A computer-use CLI for agents (and TUI for humans) built on [pi-agent](https://github.com/earendil-works/pi/tree/main/packages/agent). 

```bash
cua "go to news.ycombinator.com and tell me the top 3 story titles"
```

`cua` provisions a [Kernel cloud browser](https://kernel.sh/), turns the model's computer-use tool calls into real mouse/keyboard/scroll/screenshot actions, and streams the result back to your terminal.

---

## Why this exists

Frontier models expose computer use through different protocols: native
computer/browser declarations, predefined browser action sets, ordinary
function tools, different coordinate systems, and different screenshot/result
contracts. `@onkernel/cua-ai` represents those differences as an explicit,
identity-keyed tool catalog. Callers choose the exact tools; provider transforms
compose only the declarations and request fields required by those identities.

All of them expect you to:

1. Run a real browser somewhere (locally is annoying, on a server is hard).
2. Translate every action into an actual SDK call against that browser.
3. Capture appropriate feedback from each action so the model can verify whether it had the intended effect.
4. Keep doing this in a loop until the task is done.

`cua` does all of this for you. The repo is structured as several focused npm packages so the per-provider plumbing is also reusable outside of this binary (e.g. by agents of your own spun up via [`kernel/cli`](https://github.com/kernel/cli) templates).

---

## Workspace

```
packages/
├── ai/      # @onkernel/cua-ai    - computer-use model catalog + tool schemas + provider adapters
├── agent/   # @onkernel/cua-agent - agent APIs for running tools against a Kernel browser
└── cli/     # @onkernel/cua-cli   - the `cua` binary; built on cua-agent + cua-ai
```

**Building your own agent? Start here:** [`packages/agent`](packages/agent)
(`@onkernel/cua-agent`) — `CuaAgent`/`CuaAgentHarness` run the full
computer-use loop against a Kernel browser. It sits on
[`packages/ai`](packages/ai) (`@onkernel/cua-ai`), the model layer with the
curated computer-use model catalog, canonical tool schemas, and per-provider
adapters on top of pi-ai; reach for cua-ai directly only when you bring your
own execution.

```mermaid
flowchart LR
  ai[("@onkernel/cua-ai")]
  agent[("@onkernel/cua-agent")]
  cli[("@onkernel/cua-cli")]
  pi[("pi-agent-core / pi-ai / pi-tui / pi-coding-agent")]
  sdk[("@onkernel/sdk")]
  ai --> agent
  agent --> cli
  ai --> cli
  pi --> agent
  pi --> cli
  sdk --> agent
  sdk --> cli
```

| Package                                 | What it ships                                                                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [`@onkernel/cua-ai`](packages/ai)       | Computer-use model catalog, tool factories/toolsets, compatibility checks, and provider adapters.                         |
| [`@onkernel/cua-agent`](packages/agent) | Agent and harness APIs that run selected computer-use tools against a Kernel browser.                                    |
| [`@onkernel/cua-cli`](packages/cli)     | The `cua` binary: argv parsing, sessions, skills, JSONL output, pi-tui front-end.                                                        |

---

## Quickstart

```bash
git clone https://github.com/kernel/cua
cd cua
npm install

# run the CLI directly from source (no global install required):
npx tsx packages/cli/src/cli.ts --help

# if you want `cua` on $PATH from any directory, add a shell function to
# your rc that pins the repo location while preserving the caller's cwd
# (so `--out`, transcript bucketing, and `.agents/skills` discovery use
# the directory you invoked from), e.g. in ~/.bashrc:
#   CUA_REPO=/absolute/path/to/cua
#   cua() { "$CUA_REPO/node_modules/.bin/tsx" "$CUA_REPO/packages/cli/src/cli.ts" "$@"; }

# set API keys via env vars
export OPENAI_API_KEY=sk-...                 # for gpt-5.6-sol
export ANTHROPIC_API_KEY=sk-ant-...          # for claude-opus-5
export GOOGLE_API_KEY=...                    # for gemini-3.6-flash
export META_API_KEY=...                      # for muse-spark-1.1
export XAI_API_KEY=xai-...                   # for grok-4.5
export MOONSHOT_API_KEY=sk-...               # for kimi-k3
export YUTORI_API_KEY=yt_...                 # for n1.5-latest
export KERNEL_API_KEY=sk_...                 # always required

# single-shot
cua -p "Open https://news.ycombinator.com and tell me the top story"

# list supported model ids
cua models

# Claude
cua -p --model claude-opus-5 "Same prompt"

# Gemini 3 Flash (built-in computer use)
cua -p --model gemini-3.6-flash "Same prompt"

# Meta Muse Spark
cua -p --model meta:muse-spark-1.1 "Same prompt"

# xAI Grok 4.5
cua -p --model xai:grok-4.5 "Same prompt"

# Moonshot Kimi K3
cua -p --model moonshotai:kimi-k3 "Same prompt"

# Yutori Navigator
cua -p --model n1.5-latest "Same prompt"

# interactive TUI (default mode)
cua
cua "summarize https://news.ycombinator.com"

# agent-friendly subcommands (one-shot, see "Agent-friendly subcommands" below
# for the full surface and named-session workflow)
cua open https://github.com/login
cua click "Sign in"
cua url
cua screenshot --out shot.png

# resume the most recent session for this cwd (fresh browser, prior context)
cua -c "now click on the second result"

# JSONL events for scripting
cua -p -o jsonl "open example.com and tell me the heading"
```

---

## How it works

1. **Model layer** — `@onkernel/cua-ai` owns the curated model catalog,
   stable tool identities, explicit tool factories/toolsets, compatibility
   checks, and provider declarations/headers/payload transforms.
2. **Execution layer** — `@onkernel/cua-agent` composes around
   `pi-agent-core`'s `Agent`/`AgentHarness`. It materializes the caller's exact
   catalog over one shared resource pool and executes canonical actions through
   Kernel's computer API or a raw-CDP browser executor.
3. **CLI** — `@onkernel/cua-cli` assembles a `CuaAgentHarness` from
   command-line flags, env-var-based API keys, a `JsonlSessionRepo` for
   transcripts, and pi skills; renders the result either as plain text
   (`--print`), JSONL events (`-o jsonl`), or an interactive pi-tui
   front-end.
4. **Browser** — a fresh Kernel cloud browser session per run (or per
   resume) with optional named profile load/save. The model requests screenshots
   explicitly when it needs visual feedback.

See [`docs/architecture.md`](docs/architecture.md) for the full
end-to-end flow.

---

## CLI reference

See [`packages/cli/README.md`](packages/cli/README.md) for the
full CLI reference, env-var configuration, and model selection.

Highlights:

- `-p`/`--print` for single-shot mode; `-o jsonl` for structured output.
- `cua models` to list supported `-m`/`--model` values and their providers.
- `-m`/`--model <id>` to choose one of those supported models.
- `-s`/`--session-name <name>` to reuse a `cua session start`-allocated
  Kernel browser across calls.
- `-c`/`--continue`, `-r`/`--resume`, `--session <ref>` for transcript
  resume.
- `--skill <path>` / `/skill:<name>` for Agent Skills (defaults:
  `~/.agents/skills/`, `<cwd>/.agents/skills/`).
- `--image-protocol` / `CUA_IMAGE_PROTOCOL` to force inline screenshot
  rendering (`kitty` / `iterm2` / `none` / `auto`; Ghostty / WezTerm
  are auto-detected as `kitty`).

---

## Agent-friendly subcommands

Each subcommand below is one-shot: it provisions a Kernel browser, runs
the action, prints a compact result on stdout, and exits with a
deterministic code. Designed for shell agents to chain.

| Subcommand                          | Result on stdout                                | Exit codes                  |
| ----------------------------------- | ----------------------------------------------- | --------------------------- |
| `cua open <url>`                    | `ok`                                            | 0 ok, 2 error               |
| `cua act '<json>'`                  | bounded semantic plan result                    | 0 worked, 1 unmet, 2 error  |
| `cua click "<description>"`         | `ok clicked (x, y)` or `not_found <reason>`     | 0, 1 not_found, 2 error     |
| `cua type "<target>" "<text>"`      | `ok typed` or `not_found <reason>`              | 0, 1 not_found, 2 error     |
| `cua press <key> [<key>...]`        | `ok pressed`                                    | 0 ok, 2 error               |
| `cua observe ["<question>"]`        | the description / answer                        | 0 ok, 2 error               |
| `cua url`                           | the current URL                                 | 0 ok, 2 error               |
| `cua screenshot --out <file\|->`    | the path (or `(stdout)` when `--out -`)         | 0 ok, 2 error               |
| `cua do "<instruction>"`            | the assistant's final text                      | 0 ok, 2 error               |

By default each call provisions a fresh browser, so the second call
can't see anything the first call did. For multi-step workflows, use a
named session.

### Named sessions

```bash
cua session start login                          # provisions a Kernel browser, prints `name=login`
cua -s login open https://github.com/login
cua -s login type "email field"    "$EMAIL"
cua -s login type "password field" "$PASSWORD"
cua -s login click "Sign in"
cua -s login url                                 # stdout: the post-login URL
cua session stop login                           # tears down the Kernel browser
```

Inspect:

```bash
cua session list           # tab-formatted: NAME, KERNEL_ID, AGE, LIVE_URL
cua session show login     # full JSON: kernel_session_id, live_url, transcript_path, ...
```

`-s <name>` works for all invocation styles (action subcommands, `--print`, the
interactive TUI). Liveness is checked before each attach: if the Kernel
browser timed out, the call fails with a clear "session no longer
alive" error suggesting `cua session stop <name> && cua session start
<name>`.

Named-session metadata lives in `$XDG_DATA_HOME/cua/named-sessions/<name>.json`
(default `~/.local/share/cua/named-sessions/`).

---

## Session transcripts

Every `--print`, interactive TUI, and `-s <name>` invocation persists a
JSONL transcript by default — useful for analyzing or self-improving
agent behavior.

**Where**: `$XDG_DATA_HOME/cua/sessions/<cwd-hash>/<id>.jsonl` (default
`~/.local/share/cua/sessions/`). For named sessions, the exact path is
in the `transcript_path` field of `cua session show <name>`.

**Format**: one JSON object per line. Roles: `user`, `assistant`,
`toolResult` (from pi-coding-agent's `SessionManager`). There's also a
custom `cua-browser` entry written once per session with
`kernel_session_id` / `live_url` / `profile_id`.

**Opting out**: `--no-session` keeps the run in-memory only. One-shot
action subcommands (without `-s`) also skip the transcript, since
they're already self-contained.

**Analyzing**: anything that reads JSONL works. A few `jq` starters:

```bash
TRANSCRIPT=~/.local/share/cua/sessions/<cwd>/<id>.jsonl

# Every tool call the agent made, in order
jq -c 'select(.role == "assistant") | .content[]?
       | select(.type == "tool_use") | {name, input}' \
   "$TRANSCRIPT"

# Largest tool-result screenshot (handy when chasing context-window blowups)
jq -c 'select(.role == "toolResult") | .content[]?
       | select(.type == "image") | {len: (.data | length)}' \
   "$TRANSCRIPT" | sort -t: -k2 -n | tail -1

# Final assistant text (the answer)
jq -r 'select(.role == "assistant") | .content[]?
       | select(.type == "text") | .text' "$TRANSCRIPT" | tail -1
```

`--print -o jsonl` is a separate live-event stream (one event per line
on stdout, different schema). Both are useful for analysis but they're
NOT the same thing: the `-o jsonl` stream describes turns / tool calls
/ deltas as they happen; the transcript JSONL is the persisted message
history pi-coding-agent's `SessionManager` writes.

---

## Skills

`cua` follows the cross-agent [`~/.agents/skills/`](https://agentskills.io)
emerging standard. Skills loaded from any of these locations are
auto-discovered (first wins on name collision):

1. Explicit `--skill <path>` flags (file or directory; repeatable).
2. `~/.agents/skills/` (user-global).
3. `<cwd>/.agents/skills/` (project-local).

Each skill's `name`, `description`, and file `location` are added to
the system prompt. The model is instructed to use the `read` tool to
load a skill's full body when its description matches the task — only
descriptions and locations live in the prompt by default, so the prompt
stays small no matter how many skills you have.

To force-load a skill body inline on a single turn, prefix the prompt
with `/skill:<name>` (works in both `--print` and the interactive TUI):

```bash
cua -p "/skill:my-workflow open https://..."
```

Disable discovery entirely with `--no-skills` / `-ns`.

This repo ships a `skills/cua-cli/SKILL.md` aimed at OTHER agents
(Claude Code, Cursor, pi-coding-agent, etc.) that want to drive `cua`
as a CLI subcommand. To install it globally:

```bash
mkdir -p ~/.agents/skills
ln -s "$(pwd)/skills/cua-cli" ~/.agents/skills/cua-cli
```

---

## Project layout

```
skills/
└── cua-cli/SKILL.md # skill aimed at OTHER agents driving cua via shell
packages/
├── ai/              # @onkernel/cua-ai — model layer (see packages/ai/README.md)
├── agent/           # @onkernel/cua-agent — Kernel-browser execution layer (see packages/agent/README.md)
└── cli/             # @onkernel/cua-cli — the `cua` binary (see packages/cli/README.md)
```

---

## Roadmap

- Auto-respawn dead Kernel sessions when `-s <name>` is used (today we
  refuse with a clear error and ask the user to re-`session start`).
- `--local` Docker-backed browser as an alternative to Kernel cloud.
- Anthropic `hold_key` / `zoom` action support.
- pi-tui SelectList-based picker for `-r` instead of plain readline.

---

## License

MIT
