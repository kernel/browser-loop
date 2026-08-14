# `@onkernel/ptywright`

PTY-backed TUI testing for Node.js, powered by Ghostty's `libghostty-vt`.

`ptywright` is a small native Node.js library for testing terminal UIs and CLI flows without guessing at ANSI escape sequences by hand.

It gives you two complementary views of a terminal program:

- the full PTY transcript
- the rendered screen a human would actually see after VT parsing

It can run in two modes:

- `createTerminal(...)` for pure in-memory VT parsing
- `spawnSession(...)` for a real child process running in a PTY

## Why this exists

Terminal UIs are easy to regress and annoying to test.

Asserting on raw terminal output is brittle because:

- escape sequences are noisy
- line wrapping changes the transcript in non-obvious ways
- screen state matters more than byte-for-byte output
- some programs query the terminal and expect a reply

Screenshot testing helps in some cases, but it is heavier than necessary for most CLI and TUI regression tests.

`ptywright` takes a different approach:

1. run a real program in a PTY when you need end-to-end behavior
2. feed the output through Ghostty's VT engine
3. assert on the rendered screen, terminal metadata, and transcript
4. automatically write terminal reply bytes back to the child process

That makes tests much closer to "what a user would see" while still staying lightweight and programmable.

## Concepts

### PTY

A PTY is a pseudo-terminal. It is what shells, REPLs, and TUIs talk to when they think they are running in a real terminal window.

### VT parsing

Terminal programs do not just print text. They emit control sequences for cursor movement, colors, clearing the screen, setting the window title, reporting the working directory, querying terminal modes, and more.

`ptywright` uses `libghostty-vt` to parse those sequences and reconstruct terminal state.

### Transcript vs visible screen

These are different, and both are useful in tests:

- `transcript`: the full PTY output stream captured so far
- `visible`: the rendered terminal screen after VT parsing

When a test fails, the transcript helps debug "what happened", while the visible screen helps answer "what the user would have seen".

## What you get

- Real PTY sessions via `node-pty`
- In-memory VT parsing via Ghostty
- Snapshot metadata including cursor position, title, working directory, and scrollback counts
- Automatic handling of synchronous terminal query replies
- Promise-based wait helpers for visible text, transcript text, stability, and process exit
- Artifact writing for failed-test debugging
- No dependency on a specific test runner

## Install and build

This package currently lives inside this monorepo.

From the repo root:

```bash
npm run build --workspace @onkernel/ptywright
npm test --workspace @onkernel/ptywright
```

Because `ptywright` includes a native addon, the first native build also:

1. reads the pinned Ghostty revision from `packages/ptywright/GHOSTTY_UPSTREAM`
2. downloads that exact source archive
3. verifies its `sha256`
4. unpacks it into `packages/ptywright/.cache/ghostty/<commit>`
5. builds `libghostty-vt` locally

### Build requirements

- Node.js
- Python and a working `node-gyp` toolchain
- Zig `0.15.2`

You can provide Zig explicitly with:

```bash
PTYWRIGHT_ZIG=/path/to/zig npm run build --workspace @onkernel/ptywright
```

If `PTYWRIGHT_ZIG` is not set, the build tries:

1. a cached Zig binary under `.dev/tools`
2. `zig` on your `PATH`

## Quick start

### Pure VT parsing with `createTerminal`

Use this when you already have terminal bytes and only want to reconstruct screen state.

```ts
import { createTerminal } from "@onkernel/ptywright";

const terminal = createTerminal({ cols: 80, rows: 24 });

terminal.feed("hello\r\nworld");
terminal.feed("\x1b]2;demo title\x1b\\");
terminal.feed("\x1b]7;file://localhost/tmp/demo\x1b\\");

const snapshot = terminal.snapshot();

console.log(snapshot.visible);
console.log(snapshot.lines);
console.log(snapshot.title);
console.log(snapshot.pwd);

terminal.dispose();
```

### Real PTY session with `spawnSession`

Use this when you want to drive a real shell, REPL, or TUI.

```ts
import { KeyCtrlD, spawnSession } from "@onkernel/ptywright";

const session = spawnSession({
  command: "/bin/sh",
  args: ["-lc", "printf 'ready\\n'; cat"],
  cols: 80,
  rows: 12,
});

await session.waitForVisible("ready", { timeoutMs: 5_000 });

session.line("echo hello");
await session.waitForTranscript("hello", { timeoutMs: 5_000 });

const snapshot = session.snapshot();
console.log(snapshot.visible);
console.log(snapshot.transcript);

session.press(KeyCtrlD);
await session.waitForExit({ timeoutMs: 5_000 });
session.close();
```

## Choosing the right entry point

### `createTerminal(...)`

Choose this when you want:

- deterministic tests of VT behavior
- no child process management
- to feed bytes directly and inspect the rendered result

Typical use cases:

- parser and formatter tests
- replaying recorded terminal output
- testing title, pwd, or reply-byte behavior directly

### `spawnSession(...)`

Choose this when you want:

- an actual child process
- real keyboard input and terminal resizing
- end-to-end CLI or TUI regression tests

Typical use cases:

- shell flows
- prompts and full-screen apps
- testing terminal query replies
- black-box regression tests for a TUI

## API

### `createTerminal(options)`

Creates an in-memory terminal surface.

```ts
const terminal = createTerminal({
  cols: 80,
  rows: 24,
  scrollback: 1000,
});
```

#### Options

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `cols` | `number` | yes | Terminal width in cells |
| `rows` | `number` | yes | Terminal height in cells |
| `scrollback` | `number` | no | Maximum terminal scrollback tracked by Ghostty |

#### `terminal.feed(data)`

Feeds terminal data into the VT parser.

```ts
const { replyBytes } = terminal.feed("\x1b[?7$p");
```

- Accepts `string` or `Uint8Array`
- Returns `{ replyBytes?: Uint8Array }`
- `replyBytes` contains terminal-generated responses to queries such as mode reports

Most consumers should not need to use `replyBytes` directly. `PtySession` handles them automatically.

#### `terminal.resize(cols, rows)`

Updates the terminal dimensions.

#### `terminal.snapshot(options?)`

Returns a normalized view of terminal state:

```ts
const snapshot = terminal.snapshot({
  trim: true,
  unwrap: false,
});
```

##### Snapshot fields

| Field | Type | Description |
| --- | --- | --- |
| `visible` | `string` | Rendered visible screen |
| `lines` | `string[]` | `visible`, split into lines for convenience |
| `width` | `number` | Terminal width in cells |
| `height` | `number` | Terminal height in cells |
| `cursor` | `{ x, y, visible }` | Cursor position and visibility |
| `title` | `string \| undefined` | Terminal title if set |
| `pwd` | `string \| undefined` | Working directory URI if reported |
| `totalRows` | `number` | Total active screen rows including scrollback |
| `scrollbackRows` | `number` | Number of scrollback rows |

`trim` and `unwrap` are passed through to Ghostty's formatter to make snapshots easier to assert on.

#### `terminal.dispose()`

Releases native resources. Always call this when you create a `TerminalSurface` directly.

### `spawnSession(options)`

Spawns a child process in a PTY and wires it to an internal `TerminalSurface`.

```ts
const session = spawnSession({
  command: "python3",
  args: ["-i"],
  cwd: process.cwd(),
  env: { PYTHONUNBUFFERED: "1" },
  cols: 100,
  rows: 30,
  scrollback: 5000,
  name: "xterm-256color",
});
```

#### Options

| Option | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `command` | `string` | yes | - | Executable to spawn |
| `args` | `string[]` | no | `[]` | Process arguments |
| `cwd` | `string` | no | inherited | Working directory |
| `env` | `NodeJS.ProcessEnv` | no | inherited | Environment overrides |
| `cols` | `number` | no | `120` | PTY width |
| `rows` | `number` | no | `40` | PTY height |
| `scrollback` | `number` | no | `0` | Ghostty scrollback capacity |
| `name` | `string` | no | `"xterm-256color"` | PTY/`TERM` name |

`spawnSession` always sets `TERM` to `name` unless you override it in `env`.

### `PtySession`

#### Input helpers

##### `session.send(text)`

Writes raw text to the PTY.

##### `session.line(text)`

Writes text followed by `Enter`.

##### `session.press(key)`

Writes a raw key sequence. The exported `Key*` constants are those raw strings and stay pass-through.

```ts
import { KeyArrowDown, KeyEnter } from "@onkernel/ptywright";

session.press(KeyArrowDown);
session.press(KeyEnter);
```

##### `session.pressKey(key)`

Encodes a `SpecialKey` from the live terminal modes (for example DECCKM application cursor keys) and writes those bytes.

```ts
import { SpecialArrowUp } from "@onkernel/ptywright";

session.pressKey(SpecialArrowUp);
```

#### Lifecycle and snapshots

##### `session.resize(cols, rows)`

Resizes both the child PTY and the terminal surface.

##### `session.snapshot(options?)`

Returns a `SessionSnapshot`, which is a `TerminalSnapshot` plus:

| Field | Type | Description |
| --- | --- | --- |
| `transcript` | `string` | Complete PTY output captured so far |

##### `session.status()`

Returns process status:

```ts
{
  pid: 12345,
  running: true,
  exitCode: undefined,
  signal: undefined,
  startedAt: "...",
  exitedAt: undefined
}
```

#### Wait helpers

All wait helpers accept:

```ts
{
  timeoutMs?: number;
  signal?: AbortSignal;
}
```

##### `await session.waitForVisible(text, options?)`

Resolves when the rendered screen contains `text`.

##### `await session.waitForTranscript(text, options?)`

Resolves when the PTY transcript contains `text`.

##### `await session.waitFor(description, predicate, options?)`

General-purpose wait primitive:

```ts
await session.waitFor(
  "cursor to reach row 10",
  (snapshot) => snapshot.cursor.y === 10,
  { timeoutMs: 5_000 },
);
```

##### `await session.waitForStable(stableForMs, options?)`

Resolves once the visible screen has stopped changing for the given duration.

Useful when a TUI renders in bursts and you want to wait for it to settle.

##### `await session.waitForExit(options?)`

Resolves when the child process exits.

#### Artifacts

##### `await session.writeArtifacts(dir)`

Writes a debugging bundle to disk:

- `transcript.txt`
- `visible.txt`
- `metadata.json`

`metadata.json` includes:

- command and args
- width and height
- title and pwd
- scrollback metadata
- cursor position
- process status

This is useful for preserving test failures in CI.

#### Teardown

##### `session.close()`

Best-effort teardown:

- kills the child PTY
- disposes the underlying terminal
- stops future processing

Call this in `finally` blocks or test cleanup hooks.

### Key constants

The package exports common terminal key sequences as strings:

- `KeyEnter`
- `KeyCtrlC`
- `KeyCtrlD`
- `KeyTab`
- `KeyBacktab`
- `KeyEscape`
- `KeyBackspace`
- `KeyInsert`
- `KeyDelete`
- `KeyHome`
- `KeyEnd`
- `KeyPageUp`
- `KeyPageDown`
- `KeyArrowUp`
- `KeyArrowDown`
- `KeyArrowLeft`
- `KeyArrowRight`

Those `Key*` values are raw bytes for `press()` / `send()`. For mode-aware arrows and the other specials, use `SpecialArrowUp` and `session.pressKey(...)`.

You can also pass any raw sequence directly to `session.send(...)`.

## Examples

### Assert on the rendered screen instead of the transcript

```ts
import { spawnSession } from "@onkernel/ptywright";

const session = spawnSession({
  command: "/bin/sh",
  args: ["-lc", "printf '\\x1b[2J\\x1b[Hhello\\n'"],
});

const snapshot = await session.waitForVisible("hello", { timeoutMs: 5_000 });
console.log(snapshot.visible);
session.close();
```

### Inspect terminal replies directly

```ts
import { createTerminal } from "@onkernel/ptywright";

const terminal = createTerminal({ cols: 80, rows: 24 });
const result = terminal.feed("\x1b[?7$p");

if (result.replyBytes) {
  console.log(Buffer.from(result.replyBytes).toString("latin1"));
}

terminal.dispose();
```

### Wait for a full-screen app to settle

```ts
import { spawnSession } from "@onkernel/ptywright";

const session = spawnSession({
  command: "my-tui-app",
  cols: 120,
  rows: 40,
});

await session.waitForStable(250, { timeoutMs: 10_000 });

const snapshot = session.snapshot();
console.log(snapshot.lines);
session.close();
```

### Persist failure artifacts

```ts
import { spawnSession } from "@onkernel/ptywright";

const session = spawnSession({
  command: "my-cli",
  args: ["--interactive"],
});

try {
  await session.waitForVisible("Ready", { timeoutMs: 5_000 });
} catch (error) {
  await session.writeArtifacts("artifacts/ptywright-failure");
  throw error;
} finally {
  session.close();
}
```

## Practical notes

- `PtySession` already handles Ghostty reply bytes for you. If the child process sends a terminal query, `ptywright` writes the reply back to the PTY automatically.
- `scrollback` affects Ghostty's terminal history, not transcript retention. The transcript is accumulated separately.
- Wait failures are designed to be debuggable. Error messages include process status, cursor position, title, pwd, the last visible screen, and a tail of the transcript.
- `title` and `pwd` come from terminal escape sequences. If the program never emits them, those fields stay `undefined`.

## Current scope

This package is designed first for automated testing, not for building a production terminal emulator UI.

The current shape is intentionally small:

- screen snapshots
- transcript capture
- terminal replies
- metadata
- PTY control and wait helpers

If future regressions need lower-level inspection, cell-grid APIs can be added later without changing the testing model.
