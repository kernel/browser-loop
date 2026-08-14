# `@onkernel/cua-agent`

Kernel-browser execution for explicit [`@onkernel/cua-ai`](../ai) tool catalogs,
built on `@earendil-works/pi-agent-core`.

## Install

```bash
npm install @onkernel/cua-agent @onkernel/cua-ai @onkernel/sdk
```

Requires Node 22.19 or newer, `KERNEL_API_KEY`, and the selected model provider's
API key.

## `CuaAgent`

```ts
import Kernel from "@onkernel/sdk";
import { cua } from "@onkernel/cua-ai";
import { CuaAgent } from "@onkernel/cua-agent";

const client = new Kernel({ apiKey: process.env.KERNEL_API_KEY! });
const browser = await client.browsers.create({ stealth: true });

const agent = new CuaAgent({
  client,
  browser,
  tools: cua.toolsets.browser(),
  initialState: {
    model: "anthropic:claude-opus-5",
    systemPrompt: "Inspect and interact with the page using the requested tools.",
  },
});

try {
  await agent.prompt("Open example.com and report the heading.");
} finally {
  await client.browsers.deleteByID(browser.session_id);
}
```

## `CuaAgentHarness`

Use the harness for session-backed transcripts, skills, prompt templates,
compaction, steering, and follow-ups:

```ts
import {
  CuaAgentHarness,
  InMemorySessionRepo,
} from "@onkernel/cua-agent";
import { cua } from "@onkernel/cua-ai";

const repo = new InMemorySessionRepo();
const session = await repo.create();
const harness = new CuaAgentHarness({
  client,
  browser,
  session,
  model: "openai:gpt-5.6-sol",
  tools: cua.toolsets.browser(),
  systemPrompt: "Use the supplied browser tools.",
});

await harness.prompt("Find the pricing page.");
```

The package re-exports pi-agent-core session, skill, prompt-template, compaction,
and execution-environment primitives used with the harness.

### Tool context

Executable harness tools are pi `AgentHarnessTool`s: `execute` receives the
harness's tool context as its last argument. Supply it once as `toolContext`
and pi delivers the exact object (or the result of a zero-argument provider)
to every tool call:

```ts
import {
  CuaAgentHarness,
  NodeExecutionEnv,
  createBashTool,
  createReadTool,
  type ExecutionToolContext,
} from "@onkernel/cua-agent";

const harness = new CuaAgentHarness<ExecutionToolContext>({
  client,
  browser,
  session,
  model: "openai:gpt-5.6-sol",
  tools: [createReadTool(), createBashTool(), ...cua.toolsets.browser()],
  toolContext: { env: new NodeExecutionEnv({ cwd: process.cwd() }) },
  systemPrompt: "Use the supplied tools.",
});
```

CUA specs and plain pi `AgentTool`s are accepted too — they simply ignore the
context. The low-level `CuaAgent` stays context-free: its tools are ordinary
pi `AgentTool`s (`CuaAgentTool`).

## Choosing tools

```ts
import { cua } from "@onkernel/cua-ai";

const browser = cua.toolsets.browser();
const computer = cua.toolsets.computer();
const mixed = cua.toolsets.mixed();
// Use a normalized contract when the model emits screen-relative coordinates:
// the schema advertises 0–1000 and execution scales them to viewport pixels.
const normalized = cua.toolsets.computer({
  coordinates: cua.coordinates.normalized([0, 1000]),
});
const playwright = cua.tools.playwright();
```

Tool factories accept fixed caller-visible names (and toolsets accept a
namespace) without changing stable identity:

```ts
const tools = [
  cua.tools.browser.snapshot({ name: "page_snapshot" }),
  cua.tools.browser.click({ name: "page_click" }),
];
```

### Provider-native tools

Provider-native declarations compose with ordinary function tools:

```ts
const tools = [
  cua.providers.anthropic.tools.computer({
    version: "20260701",
    enableZoom: true,
  }),
  cua.tools.browser.snapshot(),
];
```

Other provider groups include OpenAI native computer and Google's current
predefined browser toolset. Every provider surface exposes linked first-party
documentation. xAI uses CUA browser primitives plus
`cua.tools.browser.act()` in the provider-matrix examples. Moonshot uses browser
primitives alone because its API rejects `browser_act`'s larger schema.
Compilation rejects incompatible tool/model combinations before a request.
Anthropic's native browser tool uses an equivalent function-tool transport when
the active credential cannot access `browser_20260701`.

## Dynamic catalogs

Both classes expose the same catalog controls:

```ts
agent.getTools();       // copy of the exact requested inputs
agent.setTools(next);   // atomic compile + replace
agent.setModel(nextModel);
```

The requested catalog is recompiled on every `setTools()` or `setModel()`.
Duplicate identities, caller-visible name collisions, provider-normalized name
collisions, and incompatible model/tool combinations fail before state changes.

Tools may call `setTools()` or `setModel()` while they execute, but only if they
declare `executionMode: "sequential"`; mutating the catalog from a tool that can
run in parallel is rejected. Eligible ordinary function-tool additions are
recorded for pi's deferred-loading protocol; additions outside a tool execution
are eager. Provider-native tools are always eager. Replacing an existing
identity's schema, executor, or coordinates is a real replacement.

One shared execution-resource pool survives all catalog/model changes, so
browser refs, tabs, connections, and translator state are not reset.

## Mechanical batches

Batch factories require an explicit non-empty allowlist:

```ts
const tools = [
  cua.tools.computer.batch({ actions: ["click", "keypress", "screenshot"] }),
  cua.tools.browser.batch({ actions: ["snapshot", "click", "wait_for", "text"] }),
];
```

Batch inputs are bounded primitive action arrays—not a workflow language.
Computer writes coalesce until a read boundary; browser actions run
sequentially over one shared raw-CDP executor. Results preserve read order.
Failure stops at the first failed action and reports its index plus skipped
count.

## Action feedback

Tools return only requested feedback:

- write actions return concise status text;
- read actions return their requested text or structured data;
- explicit screenshot and zoom actions return images;
- `browser_act` returns causal outcomes and a bounded successor diff;
- failed batches replace images from earlier explicit screenshot steps with
  textual markers.

`toolResultImageReplayLimit` controls how many recent tool-result images remain
in model context (`4` by default, or `false` to disable projection). OpenAI
native computer results are exempt because its protocol requires each
`computer_call_output` to carry a screenshot.

## Custom tools

Ordinary pi `AgentTool`s can appear anywhere in the exact list:

```ts
import { Type } from "@earendil-works/pi-ai";

const lookup = {
  name: "customer_lookup",
  label: "Customer lookup",
  description: "Look up a customer by id.",
  parameters: Type.Object({ id: Type.String() }),
  async execute(_id, { id }) {
    return { content: [{ type: "text", text: await lookupCustomer(id) }], details: {} };
  },
};

agent.setTools([lookup, ...cua.toolsets.browser()]);
```

Caller tools receive identity `caller.<name>` through cua-ai's canonical
`callerToolIdentity()` helper and participate in the same collision and
fingerprint rules. `CuaAgentTool` is defined and exported by this package:
cua-ai compiles declaration-only catalogs and never sees executors, while
cua-agent projects caller `AgentTool`s into fresh declarations, joins compiled
entries back by identity, materializes each CUA spec exactly once per shared
execution-resource pool, and owns implementation identity for replacement
detection (a reused `execute` function keeps its identity across wrappers; a
new `execute` or freshly created spec object is a conservative replacement).

## Events and state

`CuaAgent` delegates pi's prompt/continue/steer/follow-up/abort lifecycle and
subscriptions. `CuaAgentHarness` delegates harness events and session APIs.
`CuaAgent.state.tools` is the active materialized list; use `getTools()` for a
copy of the exact requested catalog.

## Development

```bash
npm run typecheck --workspace @onkernel/cua-agent
npm test --workspace @onkernel/cua-agent
npm run build --workspace @onkernel/cua-agent
```

See [`examples/`](examples) for direct-agent, harness, provider-matrix, and
Anthropic-native smoke tests.

## License

MIT.
