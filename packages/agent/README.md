# `@onkernel/cua-agent`

Kernel browser computer-use classes built on the `Agent` and `AgentHarness`
classes from [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core).
The full pi-agent-core surface is re-exported from this package, including
`NodeExecutionEnv` from its `/node` subpath.

This package keeps pi agent semantics intact and adds browser execution
plumbing for canonical CUA tools.

## Installation

```bash
npm install @onkernel/cua-agent @onkernel/cua-ai @onkernel/sdk
```

## Quick Start (`CuaAgent`)

```ts
import Kernel from "@onkernel/sdk";
import { CuaAgent } from "@onkernel/cua-agent";

const client = new Kernel({ apiKey: process.env.KERNEL_API_KEY! });
const browser = await client.browsers.create({ stealth: true });

const agent = new CuaAgent({
  browser,
  client,
  initialState: {
    model: "openai:gpt-5.5",
    systemPrompt: "You are a careful browser automation agent.",
  },
});

await agent.prompt("Open news.ycombinator.com and summarize the top story.");
```

## Quick Start (`CuaAgentHarness`)

`prompt()` returns the turn's final assistant message, and every turn is
persisted to the session — later prompts see the full transcript. Runtime
config like the model can change between turns (or even mid-turn, applying at
the next provider request):

```ts
import { CuaAgentHarness, InMemorySessionRepo, NodeExecutionEnv } from "@onkernel/cua-agent";
import type { AssistantMessage } from "@onkernel/cua-ai";

const sessionRepo = new InMemorySessionRepo();
const session = await sessionRepo.create({ id: "research" });

const harness = new CuaAgentHarness({
  browser,
  client,
  env: new NodeExecutionEnv({ cwd: process.cwd() }),
  model: "openai:gpt-5.5",
  session,
});

const textOf = (message: AssistantMessage) =>
  message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();

// Turn 1: a session-backed prompt.
const first = await harness.prompt("Open example.com and describe what you see.");
console.log(textOf(first));

// Swap providers mid-session; CUA tools and the default prompt refresh to match.
await harness.setModel("anthropic:claude-opus-4-7");

// Turn 2 continues the same transcript on the new model.
const second = await harness.prompt("Open the most relevant link from what you found.");
console.log(textOf(second));
```

While a turn is running, `steer()` injects course corrections, `followUp()`
queues the next instruction, and `subscribe()` streams the underlying agent
events. `compact()` and session branching are available for long-running
transcripts — see the pi-agent-core docs for the full harness lifecycle.

Use `CuaAgent` when you want direct pi `Agent` control: raw message state,
lifecycle events, custom streaming, and explicit prompt/continue/queue control.
Reach for the harness shape when you want an app layer around the loop:
session-backed turns, resource and prompt entry points, provider/auth hooks,
active tool selection, compaction/tree workflows, and higher-level queue events.
`CuaAgentHarness` extends pi `AgentHarness`, installs CUA defaults, and refreshes
provider-specific runtime state when `setModel()` changes models.

## Core Concepts

### Class-First API

- `CuaAgent extends Agent`
- `CuaAgentHarness extends AgentHarness`

Both classes mirror pi constructor shapes and behavior, with minimal additions:
- `browser` (Kernel browser response)
- `client` (Kernel SDK client)
- CUA model refs (`"provider:model"`) accepted where pi expects a concrete model
- `extraTools` to add your own pi tools alongside the built-in browser tools
- `playwright: true` to let the model run Playwright/TypeScript against the
  live browser session
- `toolResultImageReplayLimit` to control how many recent tool-result images
  are included in each model request
- `responseThreading` to choose whether OpenAI and Tzafon continue from
  provider-stored response state or receive the full request context each time

### Context management

Both constructors accept the same request-context options:

```ts
const agent = new CuaAgent({
  // ...browser, client, and initialState
  toolResultImageReplayLimit: 4,
  responseThreading: true,
});
```

`toolResultImageReplayLimit` defaults to `4`. A non-negative integer keeps that
many of the newest image blocks from tool results in each model request. `0`
removes all tool-result images from the request, while `false` disables this
filter and includes every tool-result image. Text, metadata, and message order
are preserved; a changed tool result gets one
`[stale tool-result images omitted]` marker where its first removed image was.
The limit applies across built-in tools, custom tools, and multi-image results.

This is a request-time view of the transcript, not a history mutation.
`CuaAgent.state.messages`, harness session entries, and
`session.buildContext()` retain the original images.

#### How this uses pi context primitives

pi provides several context-management layers with different lifetimes:

- `Agent.transformContext` changes the messages passed to one model request.
  `CuaAgent` uses this hook for the image limit. If you provide your own
  `transformContext`, it runs first and the image limit is applied to its
  result.
- `AgentHarness` exposes the same request-time stage through its `context`
  hook. pi selects their final result first, then `CuaAgentHarness` applies
  the image limit at the `Models` boundary before the provider call.
  User handlers therefore compose with the built-in limit instead of replacing
  it. Set `toolResultImageReplayLimit: false` if a handler should own image
  filtering completely.
- A harness `Session` can use `entryTransforms` and `entryProjectors` while
  building model context from stored session entries. These run before the
  request-time `context` hooks; the image limit runs afterward. None of these
  projections rewrite stored entries.
- `harness.compact()` is the persistent, model-generated option for reducing a
  long transcript. It writes a summary entry that future session contexts use.
  It is broader than the image limit and is not called automatically by this
  package.

`responseThreading` defaults to `true`. For OpenAI and Tzafon Responses APIs,
that means each request can continue from `previous_response_id`; the provider
keeps earlier response state and CUA sends only messages added since that
response. Because the provider retains that state, removing an older image from
the current request view does not remove it from an existing provider thread.

Set `responseThreading: false` when every request should be built entirely from
the current pi context instead. In that mode no `previous_response_id` is sent,
and `toolResultImageReplayLimit` determines which tool-result images are
included in the full request. Other providers do not use this option.

If auth callbacks are omitted, both classes default to CUA env var conventions:
- OpenAI: `OPENAI_API_KEY`
- Anthropic: `ANTHROPIC_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
- Gemini: `GOOGLE_API_KEY` or `GEMINI_API_KEY`
- Tzafon: `TZAFON_API_KEY`
- Yutori: `YUTORI_API_KEY`

### Tool Defaults

By default, the classes install provider-selected CUA computer tool executors
from `@onkernel/cua-ai`. Each provider decides which tool names the model sees;
the matching executor adapter translates returned tool calls into canonical CUA
actions that run against the Kernel browser.

Use `extraTools` to add your own pi tools alongside the provider's
computer-use tools. This is useful when the model needs to call
application-specific code, such as looking up a record, writing a database row,
or handing off to another service while it also controls the browser.

Not every provider's native computer-use vocabulary includes browser
navigation — some models can click and type but have no direct way to open a
URL or go back. The classes therefore always add `computer_use_extra`, a
provider-neutral escape hatch exposing `goto`, `back`, `forward`, and `url`
so navigation works uniformly regardless of which model is driving.

Some steps are awkward as raw pointer/keyboard actions: precise DOM reads,
form fills, data extraction, or waiting on a specific selector.
`playwright: true` adds `playwright_execute`, which runs Playwright/TypeScript
directly against the live browser session. `page`, `context`, and `browser`
are in scope and the code may `return` a JSON-serializable value. Each call
runs in a fresh JS context (locals don't persist across calls) but the
browser session does carry over. No screenshot is returned automatically;
request one on a follow-up turn when the model needs to see the page.
Playwright-level failures come back as tool content (so the model can adapt)
rather than thrown errors. Verified e2e
against Anthropic, Tzafon, and Yutori CUA models; OpenAI and Google are
unit-tested.

### Model Switching

`CuaAgent` follows pi `Agent` semantics: assign `agent.state.model` to a
concrete model or CUA model ref. CUA-owned tools and the default system prompt
refresh with the new provider runtime.

`CuaAgentHarness` follows pi `AgentHarness` semantics: call
`await harness.setModel(model)`. The harness updates its model through pi's
snapshot machinery and refreshes CUA-owned tools and default prompt state for
the next provider request.

### Tool Composition

Use `createCuaComputerTools()` to compose your own tool list from provider
execution adapters:

```ts
import { resolveCuaRuntimeSpec } from "@onkernel/cua-ai";
import { createCuaComputerTools } from "@onkernel/cua-agent";

const runtime = resolveCuaRuntimeSpec("openai:gpt-5.5");
const tools = [
  ...createCuaComputerTools({
    browser,
    client,
    toolExecutors: runtime.toolExecutors,
  }),
  myCustomTool,
];
```

For full event semantics, steering, follow-up queues, and tool execution
details, see the [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
package.
