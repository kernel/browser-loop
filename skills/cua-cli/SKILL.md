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
| `cua find "<query>"` | Lexically score elements against the query, best first. | one match per line: `role "name" [eN]` (the quoted name is omitted when the element has none; role falls back to `node`) | 0 ok, 1 not_found, 2 error |
| `cua text` | Print the page's visible text (`innerText`). | the text (multi-line) | 0 ok, 2 error |
| `cua fill <ref\|"query"> "<value>"` | Set a form field's value. With a ref (`e12` from `snapshot`/`find`) it targets that exact element. With a query it finds the unique best-matching form field (textbox, searchbox, combobox, checkbox, radio, listbox, spinbutton); exit 1 with the tied matches listed if the query is ambiguous — tighten it and retry. For checkbox/radio pass `true\|false\|checked\|unchecked\|on\|off` (query form also accepts `1\|0`). `fill` leaves the field focused, so a following `cua press Return` submits the form. | `ok filled <role> "<name>"` (query) or `ok filled e12` (ref) | 0 ok, 1 not_found, 2 error |
| `cua press <key> [<key>...]` | Send one key chord (e.g. `cua press ctrl l`, `cua press Return`). | `ok pressed` | 0 ok, 2 error |
| `cua click <x> <y>` | OS-level click at viewport coordinates. Exactly two integer arguments. | `ok clicked (x, y)` | 0 ok, 2 error |
| `cua click <ref>` | CDP click on an element ref from `snapshot`/`find`, e.g. `cua click e12`. Any other single `click` argument routes to the model-mediated `click` below. | `ok clicked e12` | 0 ok, 1 not_found (stale ref — re-snapshot), 2 error |
| `cua tabs` | List open tabs. | one line per tab: `tab_id XXXX: "title" (url)` | 0 ok, 2 error |
| `cua screenshot [--out <file\|->]` | Save a PNG (default `screenshot.png`). `--out -` writes the bytes to stdout. | the saved path; with `--out -`, stdout is exactly the PNG bytes (safe to pipe) | 0 ok, 2 error |

**Element refs span invocations within a named session.** Refs printed by `snapshot`/`find` (`[e12]`) are persisted per `-s` session, so `cua -s x snapshot` then `cua -s x click e12` works. Refs self-heal across in-page DOM changes when the element is still unambiguous, but any navigation — including reloading the same URL — invalidates them; the command then exits 1 with a stale-ref message — re-run `snapshot` and use a fresh ref. Without `-s` there is no shared browser, so refs from a previous invocation are meaningless.

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
  Other good picks: `claude-opus-5`, `gemini-3-flash-preview`, `n1.5-latest`.
- `cua models` — list supported `-m` values and their providers; filter
  with `cua models -p openai|anthropic|google|yutori|tzafon` (`gemini` is
  accepted as an alias for `google`). Model refs print as `provider:model`
  (e.g. `google:gemini-3-flash-preview`); `-m` accepts either the full ref or
  a bare model id that matches exactly one entry.
- `--max-steps <n>` — bound the agent loop on `cua do` (default 3).
- `--filter interactive` — restrict `cua snapshot` to interactive elements.
- `--proxy <proxy-id-or-name>` — route the browser through a Kernel proxy.
  The proxy must already exist (create one via the Kernel API/CLI first);
  unlike `--profile`, an unknown name is an error, never auto-created. For
  named sessions pass it to `session start`; later `-s` calls attach to the
  same browser and inherit it.
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
cua -s login click e12                       # click a ref from the snapshot/find output
cua -s login fill e7 "$EMAIL"                # fill a ref directly
cua -s login text                            # read the page's visible text
cua -s login tabs                            # list open tabs
```

Inspect sessions:

```bash
cua session list                          # tab-formatted: NAME, KERNEL_ID, AGE, LIVE_URL
cua session show login                    # full JSON metadata
```

`cua session show <name>` and `cua session stop <name>` exit 1 when the named
session does not exist (`no named session "<name>"`); other session failures
exit 2.

Pass `--profile` when starting the named session; later `cua -s login ...`
calls attach to that same browser, so they do not need the profile flag.

Liveness: Kernel browsers can time out from inactivity even between your calls. If `cua -s <name> ...` fails with `error: named session "<name>" is no longer alive on Kernel ...` (printed to stderr, exit 2), run `cua session stop <name> && cua --profile github session start <name>` to provision a fresh one with the same persisted profile.

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
`do`, `--print`, or a TUI attach).

Each line is a pi `SessionManager` record with a top-level `type` of `session`, `message`, or `custom`. Conversation entries have `type: "message"` with the role nested at `.message.role` (`user`, `assistant`, or `toolResult`). There's also a `type: "custom"` entry with `customType: "cua-browser"` written once per session whose `data` carries `sessionId` / `liveUrl` (and `profileId` when a profile is loaded).

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
