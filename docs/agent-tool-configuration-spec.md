# Agent Tool Configuration

**Status:** Implemented

**Scope:** `@onkernel/cua-agent` and the tool-building surface in `@onkernel/cua-ai`  
**Compatibility:** Not a goal; these packages are alpha and may make breaking API changes.

## Summary

`CuaAgent` and `CuaAgentHarness` should have one explicit source of truth for the tools exposed to a model: a required `tools` array. `tools: []` is valid for a text-only agent.

The array may contain:

- CUA-authored tools, such as browser snapshots, browser action plans, browser waits, batches, and `playwright_execute`
- provider-defined native browser or computer tools and predefined toolsets
- ordinary caller-provided `AgentTool` objects

Provider namespaces expose only surfaces justified by linked first-party documentation. CUA-authored capabilities remain separate under `cua.tools` and `cua.toolsets`. A caller can combine either category with custom application tools while seeing exactly what the model receives.

The former `extraTools`, `mode`, `nativeTool`, and `playwright` constructor options are removed. `activeToolNames`, `setActiveTools()`, `setMode()`, `getMode()`, `computer_use_extra`, and CUA-generated default system prompts are also removed. No global or derived mode replaces them.

Each CUA tool specification must contain enough information to build, expose, execute, and describe that tool independently. Convenience toolsets may return arrays of tool specifications, but they must not establish hidden runtime state or add undeclared tools.

## Motivation

The current constructor spreads tool configuration across four arguments:

```ts
new CuaAgent({
  extraTools,
  mode,
  nativeTool,
  playwright,
  // ...
});
```

A caller cannot determine the final model-facing tool list by reading those fields independently:

- `mode` selects a provider-dependent default action set and changes tool names.
- `nativeTool` replaces canonical tools and constrains the provider and mode.
- `playwright` adds another tool.
- `extraTools` appends caller tools.
- `computer_use_extra` is added implicitly.
- `CuaAgentHarness.activeToolNames` creates a second installed-versus-active configuration layer.

The same configuration also controls unrelated runtime policy: coordinate interpretation, post-action screenshots, system instructions, provider eligibility, and payload rewriting. This makes new interaction methods difficult to add and makes the actual model-facing surface difficult to predict.

The public distinction should instead be simple:

- A **tool** is a callable capability directly exposed to the model.
- An **action** is an operation requested within a tool call.
- A **toolset** is an ordinary array of tools chosen by the caller.

For example, Anthropic's native `browser` is one tool with multiple actions. `browser_act` is one tool containing a sequence of step actions. `browser_snapshot` is a single-purpose tool whose input does not need an action discriminator.

`CuaAction` may remain an internal normalized execution representation, but agent constructors should not expose it as their tool-selection API.

This terminology must also be used consistently in the architecture document, package READMEs, API documentation, and user-facing examples. Users should not need to understand the internal action IR to configure model-facing tools.

## Goals

1. Make the exact model-facing tool catalog obvious at the constructor call site.
2. Support minimal and empty configurations without hidden additions.
3. Distinguish first-party provider surfaces from CUA-authored capabilities.
4. Allow provider-native, CUA-authored, Playwright, and caller tools to compose in one list.
5. Let every tool own the runtime policy required to execute it correctly.
6. Support cache-aware mid-conversation tool additions, removals, and replacements.
7. Validate tool/model and tool/tool incompatibilities directly and early.
8. Permit experimentation with new tools without adding constructor flags or global modes.

## Non-goals

- Preserving the current constructor API
- Preserving current mode-dependent tool aliases
- Automatically selecting a supposedly optimal toolset for a model
- Exposing the internal canonical action IR as constructor configuration
- Automatically adding prerequisite, navigation, screenshot, or fallback tools
- Silently replacing incompatible tools when the model changes
- Preserving CUA's current default system prompts

## Public namespace

Tool factories and toolsets should be exported through one discoverable namespace rather than as a collection of global functions.

CUA-authored capabilities live under `cua.tools` and `cua.toolsets`:

```ts
cua.tools.browser.snapshot()
cua.tools.browser.act()
cua.tools.browser.waitFor()
cua.tools.browser.batch(...)
cua.tools.computer.batch(...)
cua.tools.playwright()

cua.toolsets.browser()
cua.toolsets.computer()
cua.toolsets.mixed()
```

Provider-defined surfaces live under provider namespaces and carry their first-party source:

```ts
cua.providers.anthropic.source
cua.providers.anthropic.tools.browser(...)
cua.providers.anthropic.tools.computer(...)

cua.providers.google.source
cua.providers.google.toolsets.browser()
```

The distinction is deliberate:

- `cua.providers.<provider>` contains only documented native declarations or predefined toolsets. Each namespace exposes its first-party `source` or versioned `sources`, and every returned spec carries the applicable URL.
- `cua.tools` contains additional tools CUA designed, such as snapshots, semantic waits, browser action plans, browser batches, and Playwright execution.
- `cua.toolsets` contains CUA-curated combinations of CUA-authored tools.

The exact property names may be refined, but the final exports must remain namespaced, autocomplete-friendly, and free of a large flat list of package-level tool factory functions.

## Constructor API

Both constructors accept one required top-level `tools` array:

```ts
const agent = new CuaAgent({
  browser,
  client,
  initialState: { model: "anthropic:claude-opus-5" },
  tools: [
    cua.tools.browser.snapshot(),
    cua.tools.browser.act(),
    customerLookupTool,
  ],
});
```

```ts
const harness = new CuaAgentHarness({
  browser,
  client,
  session,
  model: "openai:gpt-5.6-sol",
  tools: [
    cua.tools.playwright(),
  ],
});
```

Conceptually:

```ts
// Defined and exported by @onkernel/cua-agent.
type CuaAgentTool = CuaToolSpec | AgentTool;

interface CuaAgentOptions {
  // Existing non-tool options omitted.
  tools: CuaAgentTool[];
}

interface CuaAgentHarnessOptions {
  // Existing non-tool options omitted.
  tools: CuaAgentTool[];
}
```

A `CuaToolSpec` is declarative because `@onkernel/cua-agent` must materialize it against the Kernel browser, SDK client, selected model, and provider transport. An `AgentTool` is already executable and can be installed directly; cua-agent projects it into a fresh declaration-only object before cua-ai compiles the catalog, so cua-ai never sees executors.

There is one current tool list, not separate installed and active lists. `setTools()` changes that list for subsequent provider requests.

## Exact configurations

### Native Anthropic browser plus an unrelated custom tool

```ts
tools: [
  cua.providers.anthropic.tools.browser({
    version: "20260701",
    javascript: true,
  }),
  customerLookupTool,
]
```

The model receives exactly the native browser tool and `customer_lookup`. CUA must not add canonical browser tools, navigation helpers, screenshots, batches, or Playwright.

### Playwright only

```ts
tools: [
  cua.tools.playwright(),
]
```

The model receives exactly `playwright_execute`.

### Browser action plans only

```ts
tools: [
  cua.tools.browser.act(),
]
```

The model receives exactly `browser_act`. CUA may warn that ref-based steps require refs from another source, but it must not silently add a snapshot tool.

A practical minimal ref-based plan configuration is explicit:

```ts
tools: [
  cua.tools.browser.snapshot(),
  cua.tools.browser.act(),
]
```

### A caller-composed browser catalog

```ts
tools: [
  cua.tools.browser.snapshot(),
  cua.tools.browser.find(),
  cua.tools.browser.text(),
  cua.tools.browser.act(),
  cua.tools.browser.waitFor(),
  cua.tools.browser.navigate(),
]
```

### Native and CUA-authored tools together

```ts
tools: [
  cua.providers.anthropic.tools.computer({ version: "20260701" }),
  cua.tools.browser.snapshot(),
  cua.tools.browser.act(),
]
```

This combination is valid only if the provider transport accepts the native declaration alongside ordinary function tools. Validation belongs to the selected tool specifications and provider request composer, not to a global mode check.

### Text-only agent

```ts
tools: []
```

No tool is added implicitly.

## Convenience toolsets

Convenience helpers provide ordinary arrays:

```ts
tools: cua.providers.google.toolsets.browser()
```

```ts
tools: cua.toolsets.browser()
```

```ts
tools: cua.toolsets.mixed()
```

Callers can inspect and compose them:

```ts
tools: [
  ...cua.toolsets.browser(),
  customerLookupTool,
]
```

A toolset has no runtime meaning after expansion. It does not set or imply a mode. The runtime receives only the resulting tool specifications.

Every toolset must document and test its exact members. Tools such as
`browser_act` remain outside the reusable base toolset so applications opt into
them explicitly:

```ts
tools: [
  ...cua.toolsets.browser(),
  cua.tools.browser.act(),
]
```

The CLI uses this explicit composition for its structured CUA-browser catalogs.

Provider toolsets must expose the first-party source they mirror and must not silently include CUA-authored additions.

## No global or derived mode

The runtime must not derive `computer`, `browser`, or `hybrid` state from the selected tools. Those labels are too coarse to govern execution safely.

Instead, each `CuaToolSpec` supplies the policy needed for that tool to do its work:

- stable tool identity and preferred model-facing name
- description and schema or native declaration
- declarative local-execution policy (action conversion, coordinate contract)
- provider and model compatibility checks
- request headers and payload transformation, when required
- incoming native-call normalization, when required
- coordinate contract and conversion, when applicable
- explicit result formatting
- conflicts with other tool specifications

Examples:

- A computer click tool owns its provider coordinate conversion and OS-level input execution.
- A browser click tool owns viewport/ref targeting and CDP execution.
- A native Anthropic browser tool owns its beta header, native declaration, input mapping, and first-failure rules.
- `playwright_execute` owns its execution context and does not imply screenshot or computer tools.
- `browser_act` owns semantic polling, plan deadlines, and stable successor collection.

Screenshots are returned only when the model explicitly calls a screenshot or zoom action. Write actions do not capture an image automatically; semantic tools such as `browser_act` return their own structured successor feedback.

Tools may share internal resources such as one CDP connection, ref lifecycle, or Kernel client. Resource sharing must be explicit runtime infrastructure and must not create a hidden mode or alter the caller's tool list.

## Tool names and collisions

A tool specification has a stable identity and a preferred model-facing name. The compiled catalog resolves its final model-facing name.

Composition sees the complete requested list and must detect name collisions before the first request. It must never silently shadow a tool.

The implemented naming policy is:

1. Keep preferred declared names when unique.
2. Reject collisions by default with an error naming both tool identities.
3. Permit an explicit alias or namespace option when the underlying provider allows renaming.
4. Reject aliases for native tools whose server-defined name is fixed.
5. Never rename an existing tool as a side effect of adding another tool mid-conversation.

A toolset factory should not need hidden global state. The central composer sees all expanded tool specs and applies the collision policy. A toolset may expose explicit naming or namespace options, but automatic context-sensitive aliasing must not make the resulting catalog unpredictable.

Catalog tests cover provider-native tools composed with CUA browser and caller tools, and verify first-party sources for every provider surface.

## Tools and actions

Public documentation should use these terms consistently.

### Tool

A callable entry in the provider request's tool catalog.

Examples:

- `browser_act`
- `browser_snapshot`
- `computer_batch`
- `browser_batch`
- `playwright_execute`
- Anthropic's native `browser`
- a caller's `customer_lookup`

### Action

An operation selected through a tool's arguments.

Current action-bearing tools include:

- provider-native computer and browser tools, which use an `action` discriminator
- `computer_batch`, which accepts an ordered `actions` array
- `browser_batch`, which would accept ordered browser-plane actions
- `browser_act`, whose `steps` are dependent browser actions with optional semantic expectations

Some single-purpose tools do not need an explicit action argument. Internally converting their call into a `CuaAction` does not make the public callable surface an action.

## Batch tools

Batch tools need first-class treatment in this design rather than inheriting an unexplained default action set.

### Computer batch

`computer_batch` is a CUA-authored tool over computer-plane actions. Its factory should let the caller control the allowed action schema:

```ts
cua.tools.computer.batch({
  actions: ["click", "type", "keypress", "screenshot"],
})
```

A CUA toolset may choose and document a default batch configuration, but constructing the batch tool directly must make its allowed actions visible. The batch must not gain actions merely because unrelated individual tools are present.

### Browser batch

CUA offers a browser-plane equivalent that does not dispatch OS computer-use input:

```ts
cua.tools.browser.batch({
  actions: ["snapshot", "click", "fill", "wait_for", "text"],
})
```

The browser batch executes browser/CDP operations sequentially over one shared ref table and returns ordered read results. It short-circuits on the first failed or unsatisfied boundary and reports the failed index and skipped count. Images appear only for explicit screenshot steps.

### Browser batch versus browser act

`browser_batch` and `browser_act` must not become two vague names for the same feature:

- `browser_batch` is a mechanical ordered container for explicitly selected browser actions and read results.
- `browser_act` is a dependent plan with per-step and final semantic expectations, causal outcomes, deadlines, stop reasons, and stable successor feedback.

The implemented batch is intentionally not a restricted action-plan tool. Ref-producing reads update the shared ref table before later actions, but the input has no interpolation, saved-value, branch, or workflow syntax. `browser_act` remains the semantic planning surface.

### Native action restrictions

A server-defined native tool may not permit action restriction. Its factory must reject unsupported configuration rather than pretend to narrow the provider schema.

## Tool composition

Tool specifications are composed before a provider request.

Composition must:

1. Materialize each requested tool against the browser and client.
2. Resolve or reject model-facing name collisions.
3. Validate every tool against the selected model and provider.
4. Compose compatible headers and payload transforms.
5. Reject conflicting transforms with an error naming the conflicting tools.
6. Establish explicit resource sharing without adding tools.
7. Install exactly the requested tools.

Payload transforms must operate on explicit tool identities, not infer ownership from names such as `click`. This is required for native-tool adapters that classify or replace tools by name.

## Mid-conversation tool changes and provider caches

Both agent classes must support changing the exact tool list between model requests:

```ts
await harness.setTools([
  ...harness.getTools(),
  cua.tools.browser.act(),
]);
```

A tool may also arrange for tools to be added during its own execution so they are available to the immediately following model request.

The implementation should build on pi's dynamic tool-loading semantics:

- Detect purely additive changes.
- Record newly available tool names at the tool-result position.
- Use Anthropic deferred tool definitions and tool references when the selected model supports them.
- Use OpenAI tool-search calls and outputs when the selected model supports them.
- Fall back to sending the complete current tool list for other models.
- Permit removals and replacements through the fallback path.

Purely additive changes must preserve the stable provider prompt/schema prefix when the provider supports native deferred loading. Existing tools must not be renamed or reordered merely because another tool was added.

Tool descriptions should carry the instructions needed by lazily added tools. CUA should not modify the system prompt when the tool list changes, because doing so can invalidate the provider cache even when deferred tool schemas are supported.

`setTools()` must be coherent with CUA's materialized executors, payload transforms, headers, and shared resources. It must not update only pi's visible list while leaving an independent CUA runtime stale.

## Model changes

The requested tool list remains caller-owned when a model changes.

```ts
await harness.setModel("openai:gpt-5.6-sol");
```

CUA revalidates the same tool specifications against the new model. It must not silently replace, add, remove, or rename tools.

An incompatible native tool produces a direct error:

```text
anthropic browser_20260701 requires an Anthropic model; selected openai:gpt-5.6-sol
```

Caller-provided generic tools and compatible CUA-authored tools remain installed.

## One current tool list

`tools` defines the current catalog exposed to the model. There is no separate constructor-level installed catalog and active subset.

The following CUA-facing configuration should be removed:

```ts
activeToolNames
setActiveTools()
```

Callers use `setTools()` for additions, removals, and replacements. CUA may use pi's registration and activation machinery internally to implement deferred loading, but that distinction must not become a second public source of truth in `CuaAgent` or `CuaAgentHarness`.

The CLI's interactive `/tools` menu is an application-level consumer of exactly this contract, not a second mechanism. It holds the list it composed for the active model as the baseline, and applies a user-selected **subset** of that baseline through one `setTools()` call. It never adds a tool the application did not compose, so it cannot introduce an unsupported tool. Because tool identities are provider-specific, a `/model` change rebuilds the baseline from the new model's defaults and discards the previous selection with an explicit notice — the alternative, re-applying a selection by key across providers, is the silent replacement forbidden under Non-goals.

## System instructions and descriptions

CUA should get out of the business of generating default system prompts.

The model should learn what is available from the exact tool names, descriptions, and schemas it receives. Correctness-critical prerequisites belong in tool descriptions and schemas.

For example, `browser_act` must explain that ref-based steps require current refs from `browser_snapshot` or `browser_find`, that refs must not be invented, and that navigation may require a fresh snapshot.

Selecting a provider-native tool or predefined toolset must not silently install the provider's example system prompt. The caller owns the system prompt.

CUA tool specifications should not contribute `promptSnippet`, `promptGuidelines`, or active-tool-specific system-prompt fragments by default. This keeps tool additions cache-friendly and makes `tools: []` genuinely free of CUA interaction instructions.

If a correctness requirement cannot be expressed in a tool description or schema, that is a design issue to resolve explicitly before adding system-prompt generation back into scope.

## Provider support

Provider support should be validated per requested tool, not per global mode.

A provider capability description may include:

- ordinary function-tool support
- provider-native tool support
- accepted JSON Schema features
- tool-name restrictions
- support for mixing native and function tools
- coordinate conventions used by a specific computer tool
- payload-transform composition constraints

Coordinate uncertainty in one computer tool must not disable coordinate-free browser tools such as snapshots, refs, semantic waits, or action plans.

Native adapters compose by selected identity: OpenAI replaces only its native computer placeholder, while Google removes only selected native placeholders and preserves unrelated function tools.

## Removal of `computer_use_extra`

`computer_use_extra` is deleted entirely: definition, executor, implicit installation, exports, tests, and documentation.

No replacement navigation helper is added automatically or under a new hidden name. A caller who needs navigation chooses an explicit capability, such as:

- a provider-native browser tool
- `cua.tools.browser.navigate()`
- `cua.tools.playwright()`
- a caller-provided navigation tool

An OS-computer-only toolset may still navigate through ordinary keyboard input. CUA should not silently append a separate escape-hatch tool.

## Error behavior

Construction, `setTools()`, or model switching should fail with errors that name the requested tools and the violated constraint.

Examples:

```text
tool name "browser_act" is requested by both cua.browser.act and custom.plan
```

```text
anthropic browser_20260701 cannot be used with model openai:gpt-5.6-sol
```

```text
tools "provider.<a>.native.computer" and "provider.<b>.native.browser" require conflicting payload transforms for "tools.computer_use"
```

```text
provider google does not accept the schema used by "browser_act"
```

CUA must not silently drop tools, substitute a different selected toolset, append tools, or rename an existing tool after a dynamic addition. A selected native tool may declare an equivalent function-transport fallback under the same identity, name, schema, and executor for credentials that cannot access the native provider feature; this does not change the caller's tool catalog.

## Removal of current API

The following constructor options are removed rather than deprecated:

```ts
extraTools
mode
nativeTool
playwright
activeToolNames
```

The following methods are removed from the CUA-facing API:

```ts
setMode()
getMode()
setActiveTools()
```

`computer_use_extra` and CUA-generated default system prompts are removed with them.

Their replacements are direct tool-list entries:

| Current option | Replacement |
| --- | --- |
| `extraTools: [tool]` | include `tool` in `tools` |
| `mode: "computer"` | `tools: cua.toolsets.computer()` or an explicit provider-native list |
| `mode: "browser"` | `tools: cua.toolsets.browser()` or an explicit list |
| `mode: "hybrid"` | compose the desired provider and CUA tools explicitly |
| `nativeTool: spec` | `tools: [cua.providers.anthropic.tools.browser(spec)]` |
| `playwright: true` | `tools: [cua.tools.playwright()]` |
| `activeToolNames` | pass the exact current list and change it with `setTools()` |

## Documentation requirements

The implementation updates:

- `docs/architecture.md` with the tool-spec composition and provider-adapter ownership boundaries
- package READMEs with exact constructor examples and no legacy mode terminology
- API documentation with the definitions of tool, action, and toolset
- user-facing examples for native-only, provider-native plus CUA, Playwright-only, browser-act-only, empty, batch, and dynamic-loading configurations

Every provider tool surface must expose the first-party source it mirrors. CUA-authored additions must be described as CUA capabilities rather than provider defaults.

## Implemented design resolutions

1. **Name composition:** exact and provider-normalized collisions reject; caller aliases/namespaces are explicit; native names are fixed.
2. **Payload transforms:** transforms consume stable identities, declare static write claims, and compose in a fixed phase order.
3. **Result ownership:** each tool returns only requested reads, explicit screenshots, or its own structured semantic feedback.
4. **Batch overlap:** batches are mechanical; `browser_act` remains semantic; browser batches share ref state without a workflow DSL.
5. **Dynamic loading:** `setTools()` uses pi 0.83.0 additive markers only for final, cache-preserving in-tool additions; other changes are eager.
6. **Shared resources:** one resource pool survives tool/model changes and owns the translator and lazy CDP executor.
7. **Provider exports:** the native OpenAI, Anthropic, and Google surfaces are namespaced, cite first-party sources, and are tested against their declared contracts. Meta, xAI, and Moonshot use CUA-authored browser tools; the CLI explicitly appends `browser_act` to the Meta and xAI catalogs. Moonshot is excluded: its API accepts the complex `browser_wait_for` schema but rejects a request carrying `browser_act`'s much larger one, so the catalog gates oversized schemas separately from merely-complex ones.

## Decisions recorded

- `tools: []` is valid.
- CUA does not generate a default system prompt.
- `computer_use_extra` is removed with no implicit replacement.
- There is one current public tool list; no CUA-facing `activeToolNames` layer.
- First-party provider-native tools are namespaced separately from CUA-authored tools.
- Tool factories and toolsets are discoverable under a namespace, not exported as many global functions.
- `browser_act` remains outside `cua.toolsets.browser()`; applications may opt
  into it explicitly, and the CLI does so for structured CUA-browser catalogs.
- Naming, payload-transform composition, result formatting, and batch overlap must be resolved before code is written.

## Acceptance criteria

- Both constructors have one required tool-selection source of truth and accept `tools: []`.
- The current tool-related constructor options, active-tool option, and mode methods are removed.
- `computer_use_extra` and CUA-generated default system prompts are removed.
- CUA-authored and first-party provider-native tools are exposed through distinct, discoverable namespaces.
- Exact native-browser-only, provider-native-plus-CUA, Playwright-only, browser-act-only, and empty configurations are tested.
- No undeclared helper tool is installed.
- `computer_batch` exposes explicit action control, and a browser batch design is resolved and tested.
- Mid-conversation additive tool loading uses provider-native deferred loading where supported and preserves the prompt cache.
- Removals and replacements use a safe fallback and preserve transcript/session correctness.
- Model switching preserves the requested tool catalog or reports a named incompatibility.
- Tool descriptions mention only their own selected capabilities and prerequisites.
- Provider adapters compose explicit tool transformations rather than classify tools by ambiguous names.
- Coordinate conversion and result formatting are tool-owned; screenshots require explicit screenshot or zoom actions.
- Architecture, API, README, and user-facing terminology consistently distinguish tools, actions, and toolsets.
