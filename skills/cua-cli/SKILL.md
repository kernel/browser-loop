---
name: cua-cli
description: Drive a Kernel cloud browser from the shell using the `cua` CLI. Use this skill when you need to open URLs, click elements, type into fields, inspect pages, fill forms, take screenshots, or chain multi-step browser tasks across shell calls. Supports named sessions for stateful workflows.
---

# cua-cli

`cua` is a single-binary CLI that drives a real Chrome session running in Kernel. It's designed for agentic use: each subcommand returns a stable result on stdout and a deterministic exit code documented below, so you can chain calls together and parse the output.

## One-shot subcommands

Each call below provisions a fresh Kernel browser by default, runs the action, and tears the browser down. Use `-s <name>` (see "Named sessions" below) to keep state across calls.

### Model-free subcommands

These run directly against the browser (CDP or OS input) — no LLM involved, no model API key needed, only `KERNEL_API_KEY`.

| Subcommand | What it does | Stdout | Exit code |
| --- | --- | --- | --- |
| `cua open <url\|back\|forward>` | Navigate via CDP; `back`/`forward` walk history. | `ok` | 0 ok, 2 error |
| `cua url` | Print the active tab's URL. | the URL | 0 ok, 2 error |
| `cua snapshot [--filter interactive]` | Print the page's accessibility tree with element refs like `[e12]`. `--filter interactive` keeps only interactive elements. | the tree (multi-line) | 0 ok, 2 error |
| `cua act '<json>'` | Execute one direct `browser_act` plan. JSON is the tool input without the `type` discriminator; ref steps use refs from `snapshot`/`find`. | bounded `browser_act` outcome, expectation evidence, and successor diff | 0 worked, 1 didnt/unknown, 2 invalid/error |
| `cua find "<query>"` | Lexically score elements against the query, best first. | one match per line: `role "name" [eN]` (the quoted name is omitted when the element has none; role falls back to `node`) | 0 ok, 1 not_found, 2 error |
| `cua text` | Print the page's visible text (`innerText`). | the text (multi-line) | 0 ok, 2 error |
| `cua fill <ref\|"query"> "<value>"` | Set a form field's value. With a ref (`e12` from `snapshot`/`find`) it targets that exact element. With a query it finds the unique best-matching form field (textbox, searchbox, combobox, checkbox, radio, listbox, spinbutton); exit 1 with the tied matches listed if the query is ambiguous — tighten it and retry. For checkbox/radio pass `true\|false\|checked\|unchecked\|on\|off` (query form also accepts `1\|0`). `fill` leaves the field focused, so a following `cua press Return` submits the form. | `ok filled <role> "<name>"` (query) or `ok filled e12` (ref) | 0 ok, 1 not_found, 2 error |
| `cua press <key> [<key>...]` | Send one key chord (e.g. `cua press ctrl l`, `cua press Return`). | `ok pressed` | 0 ok, 2 error |
| `cua click <x> <y>` | OS-level click at viewport coordinates. Exactly two integer arguments. | `ok clicked (x, y)` | 0 ok, 2 error |
| `cua click <ref>` | CDP click on an element ref from `snapshot`/`find`, e.g. `cua click e12`. Any other single `click` argument routes to the model-mediated `click` below. | `ok clicked e12` | 0 ok, 1 not_found (stale ref — re-snapshot), 2 error |
| `cua tabs` | List open tabs. | one line per tab: `tab_id XXXX: "title" (url)` | 0 ok, 2 error |
| `cua screenshot [--out <file\|->]` | Save a PNG (default `screenshot.png`). `--out -` writes the bytes to stdout. | the saved path; with `--out -`, stdout is exactly the PNG bytes (safe to pipe) | 0 ok, 2 error |

**Element refs span invocations within a named session.** Refs printed by `snapshot`/`find` (`[e12]`) are persisted per `-s` session, so `cua -s x snapshot` then `cua -s x click e12` works. Refs self-heal across in-page DOM changes when the element is still unambiguous, but any navigation — including reloading the same URL — invalidates them; the command then exits 1 with a stale-ref message — re-run `snapshot` and use a fresh ref. Without `-s` there is no shared browser, so refs from a previous invocation are meaningless.

### Verified `browser_act` plans (model-free)

> **Use `cua act` when the result matters, not merely the input dispatch.** It
> executes dependent ref-based steps and checks semantic postconditions against
> structured browser observations, without an LLM.

The one shell argument is the `browser_act` input as JSON, **without** the
outer `"type": "browser_act"` discriminator. Each individual step still needs
its own `type`. The complete top-level input is:

```ts
type BrowserActInput = {
  steps: Step[];                    // required; 1–20 entries
  expect?: Expectation;             // final plan postcondition
  timeout_ms?: number;              // whole plan; 1–30000, default 30000
  poll_ms?: number;                 // expectation polling; 10–1000, default 50
  successor?: {
    filter?: "all" | "interactive";
    depth?: number;
  };
  tab_id?: string;                  // defaults to the active tab
};
```

Supported step objects:

| `type` | Required fields | Optional action fields |
| --- | --- | --- |
| `click` | `ref` | `button: "left"\|"right"\|"middle"`, `num_clicks: 1..3`, `modifiers: string[]` |
| `hover` | `ref` | — |
| `fill` | `ref`, `value: string\|number\|boolean` | — |
| `type` | `text` | — |
| `key` | `text` | `repeat: number` |
| `scroll_to` | `ref` | — |
| `wait` | — | `ms: 0..30000` |

Every step also accepts `expect?: Expectation` and `timeout_ms?: 1..30000`.
A step timeout covers both its input execution and postcondition verification
and is capped by the plan deadline. If a step cannot establish its expectation,
later steps are skipped. Navigation is a control-flow boundary, so put a
navigation-producing action last and obtain fresh refs afterward.

An expectation is one leaf below or a non-empty `{"all": [leaf, ...]}` /
`{"any": [leaf, ...]}` group. Groups contain leaves, not nested groups.

| Leaf | JSON shape and matching behavior |
| --- | --- |
| Accessible text | `{"type":"text","text":"Done","exists":true}` — case-insensitive, whitespace-normalized substring; `exists` defaults to `true` |
| Role/name | `{"type":"role_name","role":"button","name":"Submit","exists":false}` — `role` or `name` is required; matching is exact and the name is case-sensitive |
| Ref state | `{"type":"ref","ref":"e7","value":"ready"}` — provide at least one of `value`, `checked` (`boolean` or `"mixed"`), `selected`, or `expanded` |
| URL/title | `{"type":"url","changed":true}` — `type` is `url` or `title`; provide at least one of `equals`, case-sensitive `contains`, or `changed` |

`changed` compares against the observation captured before the step (or before
the whole plan for top-level `expect`). Evidence counts as causal only when the
condition was not matched before input and is matched afterward. A condition
that was already true is reported as `preexisting`, not proof that the action
worked.

A robust verified submit/navigation pattern is:

```bash
cua -s checkout snapshot --filter interactive
cua -s checkout act '{
  "steps": [{
    "type": "click",
    "ref": "e42",
    "expect": {
      "any": [
        {"type": "url", "changed": true},
        {"type": "role_name", "role": "button", "name": "Submit", "exists": false}
      ]
    },
    "timeout_ms": 30000
  }],
  "expect": {
    "any": [
      {"type": "url", "changed": true},
      {"type": "role_name", "role": "button", "name": "Submit", "exists": false}
    ]
  },
  "timeout_ms": 30000,
  "poll_ms": 100,
  "successor": {"filter": "all", "depth": 12}
}'
```

The step expectation gates later steps; the top-level expectation determines
the final plan result. `successor` controls the bounded accessibility-tree
feedback and diff but is feedback, not proof—the expectations provide proof.
Stdout begins with `browser_act: worked|didnt|unknown`; exit code `0` means
`worked`, `1` means `didnt` or `unknown`, and `2` means invalid JSON/input or an
execution error.

For irreversible actions, require a postcondition that demonstrates the
transition. If the result is `unknown` or times out, inspect with `snapshot`,
`text`, or `url` before retrying; the input may have settled even when its
verification did not.

### Model-mediated subcommands

These resolve a natural-language description with an LLM, so they need the model provider's API key (e.g. `OPENAI_API_KEY` for the default model).

| Subcommand | What it does | Stdout | Exit code |
| --- | --- | --- | --- |
| `cua click "<element-description>"` | Find the element matching the visible, natural-language description and click it. | `ok clicked (x, y)` or `not_found <reason>` | 0 ok, 1 not_found, 2 error |
| `cua type "<field-description>" "<text>"` | Focus the field matching the visible, natural-language description and type text. | `ok typed` or `not_found <reason>` | 0 ok, 1 not_found, 2 error |
| `cua observe ["question"]` | Describe the page; optionally answer a question. | the description | 0 ok, 2 error |
| `cua do "<instruction>"` | Open-ended; let the agent plan and act. Bound by `--max-steps` (default 3). | the assistant's final text | 0 ok, 2 error |

Useful flags:

- `-m <model>` — pick the LLM for model-mediated subcommands (default `gpt-5.6-sol`).
  Recommended refs are `openai:gpt-5.6-sol`, `anthropic:claude-opus-5`,
  `google:gemini-3.6-flash`, `meta:muse-spark-1.1`, `xai:grok-4.5`,
  `moonshotai:kimi-k3`, `tzafon:tzafon.northstar-cua-fast`, and
  `yutori:n1.5-latest`.
- `cua models` — list supported `-m` values and their providers; filter with
  `cua models -p openai|anthropic|google|meta|xai|moonshotai|tzafon|yutori`.
  `gemini` aliases `google`, and `moonshot` aliases `moonshotai`. Model refs
  print as `provider:model`; `-m` accepts either the full ref or a bare model id
  that matches exactly one entry.
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

### Model tool policy

The CLI selects its interaction tools from the model: structured CUA browser
primitives plus `browser_act` verified plans for OpenAI, Meta, xAI, Moonshot,
and older Anthropic models; native browser tools for current Anthropic and
Google models; Tzafon's native computer tool; and Yutori's documented native
set plus an explicit screenshot tool. It also appends workspace coding tools in
`--print`, TUI, and model-mediated action runs.

There is no `--mode`, `--native-tool`, or `--playwright` flag. Those catalogs
remain explicit SDK choices rather than CLI defaults. The CLI also does not
attach screenshots automatically to the first prompt or after writes. Ask the
model to capture a screenshot when the task specifically requires visual
feedback. Use direct `cua act '<json>'` when the caller already has refs and
needs dependent actions with semantic verification; use `cua do` or free-form
mode when a model should construct the plan.

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

### Interactive slash commands

Only available in the TUI (`cua` with no `--print`); `/` opens autocomplete.

| Command | Behavior |
| --- | --- |
| `/model` | Open a searchable model picker |
| `/model <provider:model>` | Switch directly, no UI. An unknown ref errors, then opens the picker prefilled |
| `/tools` | Open a menu to enable/disable this session's model-callable tools |
| `/thinking <off\|minimal\|low\|medium\|high\|xhigh>` | Set reasoning level |
| `/compact` | Summarize older turns |
| `/skill:<name> [args]` | Invoke a loaded skill |

Both pickers are keyboard-only and refuse to open while a turn is running.

**`/model` picker** — type to fuzzy-search provider/ref/model/name, `↑`/`↓` to
move (wraps), `enter` to select, `esc` or `ctrl+c` to cancel. Active model is
first and marked `✓`. Selecting runs the same tool revalidation as
`/model <ref>`.

**`/tools` picker** — lists exactly the tools the CLI composed for the active
model (interaction tools + coding tools) so you can disable a subset for
testing. It can only remove from that list, never add unsupported tools.

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move cursor |
| `enter` | Toggle highlighted tool |
| `space` | Toggle highlighted tool (only while the search box is empty) |
| `ctrl+a` / `ctrl+x` | Enable / disable everything listed (respects search) |
| `ctrl+r` | Reset to model defaults |
| `ctrl+s` | Apply |
| `esc` | Cancel (discards staged edits) |
| `ctrl+c` | Clear an active search, else cancel |

Edits are staged — nothing applies until `ctrl+s`, and cancel leaves live state
untouched. A selection rejected by catalog validation reports the error and
changes nothing. Selections are session-only and are reset to the new model's
defaults by `/model`. Yutori n1's native set toggles as one group; disabling
everything is allowed and yields a text-only agent.

## Don't forget

- Prefer the model-free subcommands when they can do the job — they're faster, cheaper, and deterministic. Reach for `click "<description>"` / `type` / `do` only when you need semantic matching or planning.
- Subcommands that take an element or field description (`click "<desc>"`, `type`) match SEMANTICALLY, not by selector. Use natural-language descriptions of what the user would see on screen. `fill` matches lexically against accessible role/name — use the words from `snapshot`/`find` output.
- Browser viewport defaults to 1920x1080.
- Keyboard navigation (`Page_Down`, `Home`, arrow keys via `cua press`) is more reliable than mouse-wheel scrolling.
- For multi-step state, you almost always want `-s <name>`. Without it, the second subcommand can't see anything the first one did.
