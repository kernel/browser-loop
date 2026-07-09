---
name: cua-cli
description: Drive a Kernel cloud browser from the shell using the `cua` CLI. Use this skill when you need to open URLs, click elements, type into fields, inspect pages, fill forms, take screenshots, or chain multi-step browser tasks across shell calls. Supports named sessions for stateful workflows.
---

# cua-cli

`cua` is a single-binary CLI that drives a real Chrome session running in Kernel. It's designed for agentic use: each subcommand returns a stable result on stdout and a deterministic exit code (0 ok, 1 not_found, 2 error), so you can chain calls together and parse the output.

## One-shot subcommands

Each call below provisions a fresh Kernel browser by default, runs the action, and tears the browser down. Use `-s <name>` (see "Named sessions" below) to keep state across calls.

### Model-free subcommands

These run directly against the browser (CDP or OS input) — no LLM involved, no model API key needed, only `KERNEL_API_KEY`.

| Subcommand | What it does | Stdout | Exit code |
| --- | --- | --- | --- |
| `cua open <url\|back\|forward>` | Navigate via CDP; `back`/`forward` walk history. | `ok` | 0 ok, 2 error |
| `cua url` | Print the active tab's URL. | the URL | 0 ok, 2 error |
| `cua snapshot [--filter interactive]` | Print the page's accessibility tree with element refs like `[e12]`. `--filter interactive` keeps only interactive elements. | the tree (multi-line) | 0 ok, 2 error |
| `cua find "<query>"` | Lexically score elements against the query, best first. | one match per line: `role "name" [eN]` | 0 ok, 1 not_found, 2 error |
| `cua text` | Print the page's visible text (`innerText`). | the text (multi-line) | 0 ok, 2 error |
| `cua fill "<query>" "<value>"` | Find the unique best-matching form field (textbox, searchbox, combobox, checkbox, radio, listbox, spinbutton) and set its value. Exit 1 with the tied matches listed if the query is ambiguous — tighten it and retry. | `ok filled <role> "<name>"` | 0 ok, 1 not_found, 2 error |
| `cua press <key> [<key>...]` | Send one key chord (e.g. `cua press ctrl l`, `cua press Return`). | `ok pressed` | 0 ok, 2 error |
| `cua click <x> <y>` | OS-level click at viewport coordinates. Exactly two integer arguments — anything else routes to the model-mediated `click` below. | `ok clicked (x, y)` | 0 ok, 2 error |
| `cua tabs` | List open tabs. | one line per tab: `tab_id XXXX: "title" (url)` | 0 ok, 2 error |
| `cua screenshot [--out <file\|->]` | Save a PNG (default `screenshot.png`). `--out -` writes the bytes to stdout. | the path or `(stdout)` | 0 ok, 2 error |

**Element refs are not valid across `cua` invocations.** Refs printed by `snapshot`/`find` (`[e12]`) live only for the process that minted them — there is no `fill <ref>` form. Use `fill "<query>"`, `click "<description>"`, or `click <x> <y>` instead; the refs are still useful as unique line handles when reading output.

### Model-mediated subcommands

These resolve a natural-language description with an LLM, so they need the model provider's API key (e.g. `OPENAI_API_KEY` for the default model).

| Subcommand | What it does | Stdout | Exit code |
| --- | --- | --- | --- |
| `cua click "<element-description>"` | Find the element matching the visible, natural-language description and click it. | `ok clicked (x, y)` or `not_found <reason>` | 0 ok, 1 not_found, 2 error |
| `cua type "<field-description>" "<text>"` | Focus the field matching the visible, natural-language description and type text. | `ok typed` or `not_found <reason>` | 0 ok, 1 not_found, 2 error |
| `cua observe ["question"]` | Describe the page; optionally answer a question. | the description | 0 ok, 2 error |
| `cua do "<instruction>"` | Open-ended; let the agent plan and act. Bound by `--max-steps` (default 3). | the assistant's final text | 0 ok, 2 error |

Useful flags:

- `-m <model>` — pick the LLM for model-mediated subcommands (default `gpt-5.5`).
  Other good picks: `claude-opus-4-7`, `gemini-3-flash-preview`, `n1.5-latest`.
- `cua models` — list supported `-m` values and their providers; filter
  with `cua models -p openai|anthropic|gemini|yutori`.
- `--max-steps <n>` — bound the agent loop on `cua do` (default 3).
- `--filter interactive` — restrict `cua snapshot` to interactive elements.
- `--profile <profile-id-or-name>` — load a Kernel browser profile for cookies /
  storage. Existing ids or names are reused; a non-id name is created if it
  does not exist. Use this whenever logged-in state or other persisted browser
  state matters across fresh browser sessions. Changes save back by default;
  pass `--profile-no-save-changes` for a read-only run.
- `-v` — verbose progress on stderr (provisioning, tool calls, transcript path).

## Named sessions for multi-call workflows

Without `-s`, each subcommand provisions a brand-new browser. To keep
state (cookies, scroll position, current URL) across calls, allocate a
named session first:

```bash
cua --profile github session start login  # creates a Kernel browser, prints `name=login`
cua -s login open https://github.com/login
cua -s login fill "email field" "$EMAIL"          # model-free
cua -s login fill "password field" "$PASSWORD"    # model-free
cua -s login click "Sign in"                      # model-mediated
cua -s login url                          # prints the post-login URL
cua session stop login                    # tears down the Kernel browser
```

Inspecting a page mid-flow, entirely model-free:

```bash
cua -s login snapshot --filter interactive   # what can I interact with?
cua -s login find "sign in button"           # score elements against a query
cua -s login text                            # read the page's visible text
cua -s login tabs                            # list open tabs
```

Inspect sessions:

```bash
cua session list                          # tab-formatted: NAME, KERNEL_ID, AGE, LIVE_URL
cua session show login                    # full JSON metadata
```

Pass `--profile` when starting the named session; later `cua -s login ...`
calls attach to that same browser, so they do not need the profile flag.

Liveness: Kernel browsers can time out from inactivity even between your calls. If `cua -s <name> ...` returns `error session "<name>" is no longer alive on Kernel ...`, run `cua session stop <name> && cua --profile github session start <name>` to provision a fresh one with the same persisted profile.

## Session transcripts

Every `cua --print`, interactive TUI, and model-mediated `cua -s <name>`
invocation appends to a JSONL transcript. Model-free subcommands do not touch
transcripts — there is no model conversation to record. Treat the on-disk
directory name as internal; find the exact path instead of trying to
reconstruct it:

```bash
cua -v --print "..."                       # stderr includes: [cua] session=<path>
cua session show login | jq -r .transcript_path
```

The default root is `$XDG_DATA_HOME/cua/sessions` or
`~/.local/share/cua/sessions`. For named sessions, `transcript_path` appears
after the first model-mediated `-s` call (`click "<desc>"`, `type`, `observe`,
`do`, `--print`, or a TUI attach) records a transcript.

Each line is a JSON object with one of these `role` values: `user`, `assistant`, `toolResult`. There's also a custom `cua-browser` entry written once per session with `kernel_session_id` / `live_url` / `profile_id`.

Use `cua --print -o jsonl "..."` only when you need live stdout events while a
run is happening. That stream is a compact event feed (`tool_call`,
`tool_result`, `assistant_text_done`, etc.), not the persisted pi
`SessionManager` transcript schema above.

## Free-form mode

Two ways to give the agent free rein:

```bash
cua --print "open hn and tell me the top story"            # one-shot, streams text to stdout
cua --print -o jsonl "..."                                 # one-shot, streams JSONL events
cua "..."                                                  # interactive TUI (requires a real terminal)
```

`--print` exits when the agent finishes; the interactive TUI keeps
running until you Ctrl+C.

## Don't forget

- Prefer the model-free subcommands when they can do the job — they're faster, cheaper, and deterministic. Reach for `click "<description>"` / `type` / `do` only when you need semantic matching or planning.
- Subcommands that take an element or field description (`click "<desc>"`, `type`) match SEMANTICALLY, not by selector. Use natural-language descriptions of what the user would see on screen. `fill` matches lexically against accessible role/name — use the words from `snapshot`/`find` output.
- Browser viewport defaults to 1920x1080.
- Keyboard navigation (`Page_Down`, `Home`, arrow keys via `cua press`) is more reliable than mouse-wheel scrolling.
- For multi-step state, you almost always want `-s <name>`. Without it, the second subcommand can't see anything the first one did.
