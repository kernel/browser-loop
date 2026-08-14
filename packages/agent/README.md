# `@onkernel/cua-agent`

Kernel-browser execution for explicit [`@onkernel/cua-ai`](../ai) tool catalogs,
built on `@earendil-works/pi-agent-core`.

## Install

```bash
npm install @onkernel/cua-agent @onkernel/cua-ai @onkernel/sdk
```

Requires Node 22.19 or newer, `KERNEL_API_KEY`, and the selected model provider's
API key.

## `attach()`

`attach()` binds a Kernel browser to CUA's execution resources and returns a
handle. `compile()` turns a (model, tools) pair into plain pi objects; you
construct whatever pi agent you want with them. There is no CUA agent class.

```ts
import Kernel from "@onkernel/sdk";
import { cua } from "@onkernel/cua-ai";
import { Agent, attach } from "@onkernel/cua-agent";

const client = new Kernel({ apiKey: process.env.KERNEL_API_KEY! });
const browser = await client.browsers.create({ stealth: true });
const kb = attach({ client, browser });

const { model, agentTools, models } = kb.compile({
  model: "anthropic:claude-opus-5",
  tools: cua.toolsets.browser(),
});

const agent = new Agent({
  streamFn: (selected, context, options) => models.streamSimple(selected, context, options),
  initialState: {
    model,
    tools: [...agentTools],
    systemPrompt: "Inspect and interact with the page using the requested tools.",
  },
});

try {
  await agent.prompt("Open example.com and report the heading.");
} finally {
  await kb.dispose();
  await client.browsers.deleteByID(browser.session_id);
}
```

The compiled `model` carries the transport its tools derive: selecting a
provider-native browser or computer surface can change `model.api`, so the pair
has to reach pi together.

## With pi's `AgentHarness`

Use pi's harness for session-backed transcripts, skills, prompt templates,
compaction, steering, and follow-ups. `activate()` registers the behaviors CUA
owns that are pi event handlers rather than constructor options, and points the
handle's `models` at this catalog:

```ts
import { AgentHarness, attach, InMemorySessionRepo } from "@onkernel/cua-agent";
import { cua } from "@onkernel/cua-ai";

const session = await new InMemorySessionRepo().create();
const kb = attach({ client, browser });
const compiled = kb.compile({ model: "openai:gpt-5.6-sol", tools: cua.toolsets.browser() });

const harness = new AgentHarness({
  session,
  model: compiled.model,
  models: compiled.models,
  tools: [...compiled.tools],
  activeToolNames: compiled.tools.map((tool) => tool.name),
  systemPrompt: "Use the supplied browser tools.",
});
compiled.activate(harness);

await harness.prompt("Find the pricing page.");
```

To change the model or the tool list on a running harness, compile the new pair
and apply it:

```ts
await kb.compile({ model: "google:gemini-3.6-flash", tools: cua.providers.google.toolsets.browser() }).apply(harness);
```

`apply()` moves the model and tools together, sets the model only when the
derived transport actually moved, and restores the previous pair if pi rejects
the new one.

The package re-exports pi-agent-core session, skill, prompt-template, compaction,
and execution-environment primitives used with the harness.

### Tool context

Executable harness tools are pi `AgentHarnessTool`s: `execute` receives the
harness's tool context as its last argument. Supply it once as `toolContext`
and pi delivers the exact object (or the result of a zero-argument provider)
to every tool call:

```ts
import {
  AgentHarness,
  attach,
  NodeExecutionEnv,
  createBashTool,
  createReadTool,
  type ExecutionToolContext,
} from "@onkernel/cua-agent";

const compiled = kb.compile<ExecutionToolContext>({
  model: "openai:gpt-5.6-sol",
  tools: [createReadTool(), createBashTool(), ...cua.toolsets.browser()],
});
const harness = new AgentHarness<ExecutionToolContext>({
  session,
  model: compiled.model,
  models: compiled.models,
  tools: [...compiled.tools],
  activeToolNames: compiled.tools.map((tool) => tool.name),
  toolContext: { env: new NodeExecutionEnv({ cwd: process.cwd() }) },
  systemPrompt: "Use the supplied tools.",
});
compiled.activate(harness);
```

Compile for the same context the harness delivers, so a later swap stays
type-compatible. CUA specs and plain pi `AgentTool`s are accepted too — they
simply ignore the context. `compiled.agentTools` is the context-free view for
the low-level `Agent`.

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

Changing the model or the tool list compiles a new pair; nothing mutates in
place:

```ts
const next = kb.compile({ model: nextModel, tools: nextTools });
await next.apply(harness);
```

Duplicate identities, caller-visible name collisions, provider-normalized name
collisions, and incompatible model/tool combinations fail in `compile()`, before
anything reaches pi. `apply()` then moves the model and tools together and
restores the previous pair if pi rejects the new one.

The handle holds the current selection only in the sense that `models` serves
whichever pair was last activated; the *selection* itself belongs to the caller,
which is what removes the class of bug where a compiled pair and the live one
disagree.

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

kb.compile({ model, tools: [lookup, ...cua.toolsets.browser()] });
```

Caller tools receive identity `caller.<name>` through cua-ai's canonical
`callerToolIdentity()` helper and participate in the same collision and
fingerprint rules. `CuaAgentTool` is defined and exported by this package:
cua-ai compiles declaration-only catalogs and never sees executors, while
cua-agent projects caller `AgentTool`s into fresh declarations, joins compiled
entries back by identity, and materializes each CUA spec exactly once per shared
execution-resource pool, so repeat compiles hand pi a stable implementation.

## Events and state

The agent is pi's, so its lifecycle, events, and session APIs are pi's too.
What CUA adds on top is `activate()`: failed tool results are marked, a turn's
remaining calls are blocked after one fails, and an empty successful response
can be followed up. It returns a release.

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
