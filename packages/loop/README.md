# `@onkernel/loop`

Kernel browser computer-use for pi: tool declarations, per-model catalog
compilation, Kernel-browser execution, the `attach()` binding for
`@earendil-works/pi-agent-core`, and a pi extension.

Two entry points:

| import | what it is |
| --- | --- |
| `@onkernel/loop` | The framework-neutral core: canonical actions, the tool namespace, catalog compilation, the tool menu, and Kernel-browser execution. Core declarations (`LoopToolDeclaration`) and executables (`LoopExecutableTool`) import nothing from pi — schemas come from `typebox` directly — and a unit test enforces the boundary. |
| `@onkernel/loop/pi` | The pi binding: `attach()`, model resolution, transport derivation, provider adapters, and provider retry. |

Installing the package into pi (`pi install npm:@onkernel/loop`) registers the
extension described under [pi extension](#pi-extension).

## Install

```bash
npm install @onkernel/loop @onkernel/sdk @earendil-works/pi-agent-core
```

Requires Node 22.19 or newer, `KERNEL_API_KEY` for browser execution, and the
selected model provider's API key.

## `attach()`

`attach()` binds a Kernel browser to the package's execution resources and
returns a handle. `compile()` turns a (model, tools) pair into plain pi objects;
you construct whatever pi agent you want with them. There is no agent class here.

```ts
import Kernel from "@onkernel/sdk";
import { Agent } from "@earendil-works/pi-agent-core";
import { loop } from "@onkernel/loop";
import { attach } from "@onkernel/loop/pi";

const client = new Kernel({ apiKey: process.env.KERNEL_API_KEY! });
const browser = await client.browsers.create({ stealth: true });
const kb = attach({ client, browser });

const { model, agentTools, models } = kb.compile({
  model: "anthropic:claude-opus-5",
  tools: loop.toolsets.browser(),
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

### With pi's `AgentHarness`

Use pi's harness for session-backed transcripts, skills, prompt templates,
compaction, steering, and follow-ups. `activate()` registers the behaviors this
package owns that are pi event handlers rather than constructor options, and
points the handle's `models` at this catalog:

```ts
import { AgentHarness, InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import { loop } from "@onkernel/loop";
import { attach } from "@onkernel/loop/pi";

const session = await new InMemorySessionRepo().create();
const kb = attach({ client, browser });
const compiled = kb.compile({ model: "openai:gpt-5.6-sol", tools: loop.toolsets.browser() });

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
await kb.compile({ model: "google:gemini-3.6-flash", tools: loop.providers.google.toolsets.browser() }).apply(harness);
```

`apply()` moves the model and tools together, sets the model only when the
derived transport actually moved, and restores the previous pair if pi rejects
the new one. Changing the model or the tool list compiles a new pair; nothing
mutates in place, and one shared execution-resource pool survives every change,
so browser refs, tabs, connections, and translator state are not reset.

`@onkernel/loop/pi` does not re-export pi: install `@earendil-works/pi-agent-core`
and import its session, skill, prompt-template, compaction, and
execution-environment primitives directly, as these examples do.

### Tool context

Executable harness tools are pi `AgentHarnessTool`s: `execute` receives the
harness's tool context as its last argument. Supply it once as `toolContext`
and pi delivers the exact object (or the result of a zero-argument provider)
to every tool call:

```ts
import { AgentHarness, createBashTool, createReadTool, type ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { loop } from "@onkernel/loop";
import { attach } from "@onkernel/loop/pi";

const compiled = kb.compile<ExecutionToolContext>({
  model: "openai:gpt-5.6-sol",
  tools: [createReadTool(), createBashTool(), ...loop.toolsets.browser()],
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
type-compatible. Loop specs and plain pi `AgentTool`s are accepted too — they
simply ignore the context. `compiled.agentTools` is the context-free view for
the low-level `Agent`.

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
`computer_call_output` to carry a screenshot, so every native computer action
returns one.

`emptyResponseRecovery: { followUp, maxAttempts }` queues a follow-up when a
turn ends with a successful tool call but no assistant text — Google's native
browser surface does that occasionally. It is off by default.

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

kb.compile({ model, tools: [lookup, ...loop.toolsets.browser()] });
```

Caller tools receive identity `caller.<name>` through the canonical
`callerToolIdentity()` helper and participate in the same collision and
fingerprint rules. The catalog compiler is declaration-only, so the tool manager
projects caller `AgentTool`s into fresh declarations, joins compiled entries back
by identity, and materializes each spec exactly once per shared
execution-resource pool — repeat compiles hand pi a stable implementation.

## Model catalog

Model references are always provider-qualified:

```ts
import {
  getLoopModel,
  listLoopModels,
  parseLoopModelRef,
} from "@onkernel/loop/pi";

const model = getLoopModel("openai:gpt-5.6-sol");
console.log(parseLoopModelRef("anthropic:claude-opus-5"));
console.table(listLoopModels("google"));
```

`gemini:` aliases `google:` and `moonshot:` aliases `moonshotai:`. The package
does not export a default model. See [models and native surfaces](docs/supported-models.md)
for which models have provider-native tools and which have known request limits.

## Explicit tools

All Loop-owned tools are available from one frozen namespace:

```ts
import { loop } from "@onkernel/loop";

const tools = [
  loop.tools.browser.snapshot(),
  loop.tools.browser.click(),
  loop.tools.computer.screenshot(),
];
```

Nothing is inferred from the model and no fallback tools are appended.

### Atomic browser tools

```ts
loop.tools.browser.snapshot();
loop.tools.browser.text();
loop.tools.browser.find();
loop.tools.browser.click();
loop.tools.browser.hover();
loop.tools.browser.drag();
loop.tools.browser.fill();
loop.tools.browser.scrollTo();
loop.tools.browser.scroll();
loop.tools.browser.type();
loop.tools.browser.key();
loop.tools.browser.navigate();
loop.tools.browser.listTabs();
loop.tools.browser.newTab();
loop.tools.browser.screenshot();
loop.tools.browser.evaluate();
loop.tools.browser.waitFor();
loop.tools.browser.act();
```

`browser_act` retains the established browser-action schema. Atomic tools expose
operation-specific arguments directly—there is no outer action wrapper.

### Atomic computer tools

```ts
loop.tools.computer.click();
loop.tools.computer.doubleClick();
loop.tools.computer.mouseDown();
loop.tools.computer.mouseUp();
loop.tools.computer.type();
loop.tools.computer.keypress();
loop.tools.computer.scroll();
loop.tools.computer.move();
loop.tools.computer.drag();
loop.tools.computer.wait();
loop.tools.computer.screenshot();
loop.tools.computer.zoom();
loop.tools.computer.goto();
loop.tools.computer.back();
loop.tools.computer.forward();
loop.tools.computer.url();
loop.tools.computer.cursorPosition();
```

Computer coordinates default to pixels. Callers can request an explicit
normalized contract:

```ts
loop.toolsets.computer({
  coordinates: loop.coordinates.normalized([0, 1000]),
});
```

### Toolsets, names, and batches

```ts
loop.toolsets.browser();
loop.toolsets.computer();
loop.toolsets.mixed();
loop.toolsets.browser({ namespace: "page" });

loop.tools.browser.snapshot({ name: "page_snapshot" });
loop.tools.computer.click({ name: "os_click" });

loop.tools.computer.batch({ actions: ["click", "keypress", "screenshot"] });
loop.tools.browser.batch({ actions: ["snapshot", "click", "wait_for", "text"] });

loop.tools.playwright();
```

A toolset carries that surface's primitives, not every tool it has: `browser_act`,
`computer_zoom`, and the batch forms are selected explicitly.

Batches are mechanical primitive lists. They have no branching, saved values,
references, or workflow DSL.

## Provider-native composition

Provider-native tools are selected explicitly and may coexist with ordinary
function tools.

```ts
const tools = [
  loop.providers.anthropic.tools.computer({
    version: "20260701",
    enableZoom: true,
  }),
  loop.tools.browser.snapshot(),
];
```

Available groups:

```ts
loop.providers.openai.tools.computer();

loop.providers.anthropic.source;
loop.providers.anthropic.tools.computer({ version: "20260701" });
loop.providers.anthropic.tools.browser({ version: "20260701" });

loop.providers.google.source;
loop.providers.google.toolsets.browser({ exclude: ["right_click"] });

// Meta, xAI, and Moonshot use the ordinary Loop browser tools.
loop.toolsets.browser();
```

The Google browser set exposes the current predefined action names and uses
normalized coordinates in `[0, 999]`. Its native `computer_use` declaration
excludes every unselected browser action. If Google emits an excluded name
anyway, the adapter returns a named exact-catalog error instead of forwarding
an undeclared tool call.

Moonshot accepts the ordinary browser toolset, including `browser_wait_for`,
but rejects `browser_act`'s substantially larger function schema. Catalog
compilation rejects that specific combination before a provider request.

A provider enables its native surface per model, not for its whole catalog, so
selecting one for a model without it fails during catalog compilation rather
than on the wire. [Models and native surfaces](docs/supported-models.md) lists
which models carry which surface.

Provider-native caller-visible names are fixed by protocol. Version/tool/model
mismatches fail during catalog compilation. If an Anthropic credential cannot
access `browser_20260701`, Loop retries with an equivalent `browser` function
tool and remembers that choice for the credential and process. Every
`loop.providers.*` tool surface exposes its first-party `source` (or versioned
`sources`), and every returned provider spec carries the applicable URL.

## Catalog compilation

`compileLoopToolCatalog()` is the identity and validation boundary every
consumer shares — `attach()`, the pi extension, and callers compiling a catalog
themselves:

```ts
const catalog = compileLoopToolCatalog({
  model: "anthropic:claude-opus-5",
  requestedTools: tools, // Loop specs and plain declarations ({ name, description, parameters })
});

catalog.entries;          // identities, fingerprints, declarations, coordinates
catalog.toolDeclarations; // LoopToolDeclarations, structurally pi-ai Tools, for Context.tools
catalog.headers.merge(callerHeaders);
await catalog.payload.apply(payload, catalog.model);
catalog.incoming;
```

Compilation is declaration-only and deterministic: identical declaration and
model inputs produce identical catalogs, and compilation never constructs
executable tools or retains the requested input objects. Execution is
a separate concern: `attach()` materializes specs against a Kernel browser and
owns implementation identity.

A Loop-owned identity remains stable when its name is customized. Caller tools
receive `caller.<name>` identities through the canonical `callerToolIdentity()`
helper shared with every consumer. Compilation rejects:

- duplicate identities;
- exact or provider-normalized caller-visible name collisions;
- unsafe names;
- incompatible model/provider-native combinations;
- conflicting payload-transform write claims;
- partial provider-native selections that violate a provider contract.

The catalog fingerprint includes model, order, identity, name, schema, and
coordinates. The tool manager composes these declaration fingerprints with its
own implementation identity, so a schema or executor replacement cannot
masquerade as a no-op.

Generated payload processing has deterministic order:

1. model preparation;
2. tool declaration serialization;
3. provider request fields;
4. caller `onPayload` (applied by `attach()`).

Generated header requirements merge with caller headers. Comma-list headers are
unioned and deduplicated; exact-value conflicts throw.

## Dynamic loading metadata

Ordinary function tools are marked eligible only where pi 0.83.0 supports
deferred loading. Provider-native tools are eager-only. The catalog itself does
not guess when tools were added; a caller that adds tools mid-turn records the
addition through pi's active-tool change entries.

## Provider behavior

Transport is derived, not stamped on the model ahead of time: a selected
tool's provider binding may declare `requiresApi`, and `compileLoopToolCatalog`
returns a `catalog.model` carrying that api. Selecting tools whose bindings
require different transports fails to compile.

- **OpenAI**: a model selected with only ordinary/Loop browser tools streams
  through pi's builtin Responses transport and its automatic prompt caching.
  Selecting `loop.providers.openai.tools.computer()` derives the Loop-owned
  `openai-computer-use` api instead, which a Loop adapter handles; that same
  adapter also covers tool-search namespace round-trips regardless of api,
  since pi's builtin transport does not replay them.
- **Anthropic**: exact native declarations, beta-header composition, and
  adaptive model preparation. No api fork — every Anthropic model streams
  through pi's builtin transport.
- **Google**: a model selected without Google's native browser toolset streams
  through pi's builtin transport. Selecting
  `loop.providers.google.toolsets.browser()` derives the Loop-owned
  `google-interactions` api, which serializes one `computer_use`
  declaration plus explicit exclusions through the Interactions API adapter.
- **Meta/xAI/Moonshot**: ordinary function tools with serial tool calls when the
  selected catalog mutates browser state.

## API keys

```ts
import {
  loopApiKeyEnvVarsForProvider,
  getLoopEnvApiKeyForModel,
  requireLoopEnvApiKeyForModel,
} from "@onkernel/loop/pi";
```

Conventional variables are `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GOOGLE_API_KEY`/`GEMINI_API_KEY`, `XAI_API_KEY`, and
`MOONSHOT_API_KEY`.

## pi extension

Installing this package into pi adds the same tools to pi's own agent session. pi
owns the agent loop, session, and UI; the extension contributes the tools, the
browser they run against, and the provider wiring provider-native surfaces need.
It does not start a second model loop, and it adds no implicit screenshots or
prompt instructions.

```sh
pi install npm:@onkernel/loop

pi -p --provider openai --model gpt-5.6-sol \
  --browser-tools browser,browser-act "Open example.com and report its heading"
```

`KERNEL_API_KEY` is required when a tool first executes, not at startup.
`KERNEL_BASE_URL` is honored. Neither is written to session entries or output.

### The menu

Eight entries, one per capability. Availability is per model, and `/browser-tools`
tells you which apply to the one you selected.

| entry | tools | works on |
| --- | --- | --- |
| `browser` | CDP browser primitives plus the one-call `browser_batch` form | every provider |
| `computer` | canonical computer primitives plus `computer_batch` | every provider |
| `browser-act` | `browser_act`, the verified-plan tool | every provider except Moonshot, which rejects its schema size |
| `playwright` | `playwright_execute` | every provider |
| `anthropic-computer` | Anthropic's native computer tool | Anthropic models with that native surface |
| `anthropic-browser` | Anthropic's native browser tool | Anthropic models with that native surface |
| `openai-computer` | OpenAI's native computer tool | OpenAI models with that native surface |
| `google-browser` | Google's predefined browser action set | Google models with that native surface |

`--browser-coordinates` selects `pixels` (default) or `normalized-1000` for the
`computer` entry's coordinate contract.

### Commands

- `/browser` — current selectors, active tools, and browser status.
- `/browser-tools` — with no argument, list every selector for the current model,
  marking the selected ones and showing the compiler's own reason for any that
  this model cannot take. With an argument, replace the selection. `none` clears
  it.

A selection is checked by compiling it, so a model that cannot take a tool
deactivates it with a reason rather than failing at request time. Switching
models re-checks, and restores a previously forced-off selection when the new
model can take it. In TUI mode the reason appears in the status line; print and
RPC have no status line, so it is written to stderr once per distinct reason.

### Browser

| flag | effect |
| --- | --- |
| `--browser-session` | attach an existing session; never deleted on exit |
| `--browser-options` | JSON forwarded verbatim to Kernel's browser-create call |

```sh
pi -p --browser-tools browser \
  --browser-options '{"stealth":true,"profile":{"id":"p1","save_changes":true},"proxy_id":"px1"}' \
  "open example.com"
```

One JSON object rather than a flag per field, so it tracks the Kernel SDK without
this extension growing an option every time the SDK does. The only default is
`timeout_seconds: 600` — the failure it prevents is a browser vanishing mid-task.
`--browser-session` attaches an existing browser, so it cannot be combined with
`--browser-options`.

One browser is provisioned lazily per session, on first tool execution.
Compiling declarations, generating headers, and transforming a payload never
provision one. An owned browser is deleted on session shutdown.

## Development

```bash
npm run typecheck --workspace @onkernel/loop
npm run build --workspace @onkernel/loop
npm test --workspace @onkernel/loop
```

Build before testing: the pi print/RPC test loads the extension the way pi does,
through this package's own entry points.

See [`examples/`](examples) for direct catalog/model usage, direct-agent and
harness smoke tests, provider matrices, and the Anthropic-native compositions.

## License

MIT.
