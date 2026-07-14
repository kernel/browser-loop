# Agent Tool Configuration

**Status:** Draft for later review  
**Scope:** `@onkernel/cua-agent` and the tool-building surface in `@onkernel/cua-ai`  
**Compatibility:** Not a goal; these packages are alpha and may make breaking API changes.

## Summary

`CuaAgent` and `CuaAgentHarness` should have one explicit source of truth for the tools exposed to a model: a required `tools` array. `tools: []` is valid for a text-only agent.

The array may contain:

- CUA-authored tools, such as browser snapshots, browser action plans, browser waits, batches, and `playwright_execute`
- provider-defined native browser or computer tools
- CUA implementations of other provider-recommended tool shapes and toolsets
- ordinary caller-provided `AgentTool` objects

Provider-recommended tools are intentionally distinct from CUA-authored tools. The former reproduce the basic tools or schemas a model provider recommends in its computer-use examples; the latter are additional capabilities designed and maintained by CUA. A caller should be able to combine either category with custom application tools while seeing exactly what the model receives.

The current `extraTools`, `mode`, `nativeTool`, and `playwright` constructor options should be removed. `activeToolNames`, `setActiveTools()`, `setMode()`, `getMode()`, `computer_use_extra`, and CUA-generated default system prompts should also be removed. No global or derived mode should replace them.

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
3. Distinguish provider-recommended tools from additional CUA-authored capabilities.
4. Allow provider-native, provider-recommended, CUA-authored, Playwright, and caller tools to compose in one list.
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

## Proposed public namespace

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

Provider-defined and provider-recommended surfaces live under the provider namespace:

```ts
cua.providers.anthropic.tools.browser(...)
cua.providers.anthropic.tools.computer(...)
cua.providers.anthropic.toolsets.computer()

cua.providers.google.toolsets.computer()
cua.providers.meta.toolsets.computer()
cua.providers.moonshot.toolsets.computer()
```

The distinction is deliberate:

- `cua.providers.<provider>` mirrors native declarations or the basic tool shapes and sets recommended by that provider.
- `cua.tools` contains additional tools CUA designed, such as snapshots, semantic waits, browser action plans, browser batches, and Playwright execution.
- `cua.toolsets` contains CUA-curated combinations of CUA-authored tools.

The exact property names may be refined, but the final exports must remain namespaced, autocomplete-friendly, and free of a large flat list of package-level tool factory functions.

## Proposed constructor API

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
  env,
  session,
  model: "openai:gpt-5.5",
  tools: [
    cua.tools.playwright(),
  ],
});
```

Conceptually:

```ts
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

A `CuaToolSpec` is declarative because CUA must materialize it against the Kernel browser, SDK client, selected model, and provider transport. An `AgentTool` is already executable and can be installed directly.

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

### Provider-recommended computer tools plus CUA additions

```ts
tools: [
  ...cua.providers.anthropic.toolsets.computer(),
  cua.tools.browser.snapshot(),
  cua.tools.browser.act(),
]
```

The provider namespace supplies the basic tools Anthropic recommends. The additional snapshot and action-plan tools are visibly CUA-authored choices.

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
tools: cua.providers.anthropic.toolsets.computer()
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

Every toolset must document and test its exact members. Experimental tools such as `browser_act` should remain outside default toolsets until explicitly accepted into them:

```ts
tools: [
  ...cua.toolsets.browser(),
  cua.tools.browser.act(),
]
```

Provider-recommended toolsets must cite or test against the provider surface they mirror. They should not silently include CUA-authored additions.

## No global or derived mode

The runtime must not derive `computer`, `browser`, or `hybrid` state from the selected tools. Those labels are too coarse to govern execution safely.

Instead, each `CuaToolSpec` supplies the policy needed for that tool to do its work:

- stable tool identity and preferred model-facing name
- description and schema or native declaration
- local executor construction
- provider and model compatibility checks
- request headers and payload transformation, when required
- incoming native-call normalization, when required
- coordinate contract and conversion, when applicable
- browser viewport or OS display grounding behavior, when applicable
- post-action observation behavior
- conflicts with other tool specifications

Examples:

- A computer click tool owns its provider coordinate conversion and OS-level input execution.
- A browser click tool owns viewport/ref targeting and CDP execution.
- A native Anthropic browser tool owns its beta header, native declaration, input mapping, and first-failure rules.
- `playwright_execute` owns its execution context and does not imply screenshot or computer tools.
- `browser_act` owns semantic polling, plan deadlines, and stable successor collection.

No shared mode is needed to decide which screenshot to return. A tool that needs post-action grounding declares the appropriate observation source itself. A tool that returns structured text may declare that no automatic image is needed.

Tools may share internal resources such as one CDP connection, ref lifecycle, or Kernel client. Resource sharing must be explicit runtime infrastructure and must not create a hidden mode or alter the caller's tool list.

## Tool names and collisions

A tool specification has a stable identity and a preferred model-facing name. The final model-facing name is returned by inspection APIs and persisted with tool calls.

Composition sees the complete requested list and must detect name collisions before the first request. It must never silently shadow a tool.

The naming policy is a design blocker that must be resolved before implementation. Candidate behavior is:

1. Keep preferred provider-recommended names when unique.
2. Reject collisions by default with an error naming both tool identities.
3. Permit an explicit alias or namespace option when the underlying provider allows renaming.
4. Reject aliases for native tools whose server-defined name is fixed.
5. Never rename an existing tool as a side effect of adding another tool mid-conversation.

A toolset factory should not need hidden global state. The central composer sees all expanded tool specs and applies the collision policy. A toolset may expose explicit naming or namespace options, but automatic context-sensitive aliasing must not make the resulting catalog unpredictable.

This policy must be prototyped with provider-recommended computer tools plus CUA browser tools before implementation begins.

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

Current or proposed action-bearing tools include:

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

A CUA or provider-recommended toolset may choose and document a default batch configuration, but constructing the batch tool directly must make its allowed actions visible. The batch must not gain actions merely because unrelated individual tools are present.

### Browser batch

CUA should offer a browser-plane equivalent that does not dispatch OS computer-use input:

```ts
cua.tools.browser.batch({
  actions: ["snapshot", "click", "fill", "wait_for", "text"],
})
```

The browser batch would execute browser/CDP operations and return their ordered read results. Its action schema, ref lifetime behavior, failure short-circuiting, and result grounding must be specified explicitly.

### Browser batch versus browser act

`browser_batch` and `browser_act` must not become two vague names for the same feature:

- `browser_batch` is a mechanical ordered container for explicitly selected browser actions and read results.
- `browser_act` is a dependent plan with per-step and final semantic expectations, causal outcomes, deadlines, stop reasons, and stable successor feedback.

The overlap still needs a design review before implementation. In particular, the design must decide whether ref-producing reads can feed later actions inside one batch and whether a simpler batch should instead be a restricted form of the action-plan tool.

### Native action restrictions

A server-defined native tool may not permit action restriction. Its factory must reject unsupported configuration rather than pretend to narrow the provider schema. Provider-recommended function-tool mirrors may expose restrictions only when the outgoing schema actually enforces them.

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

Payload transforms must operate on explicit tool identities, not infer ownership from names such as `click`. This is required for providers like Tzafon and Yutori, whose current native-tool adapters classify or replace tools by name.

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
await harness.setModel("openai:gpt-5.5");
```

CUA revalidates the same tool specifications against the new model. It must not silently replace, add, remove, or rename tools.

An incompatible native tool produces a direct error:

```text
anthropic browser_20260701 requires an Anthropic model; selected openai:gpt-5.5
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

Tool changes must be persisted in harness sessions so resumed and branched conversations reconstruct the tool catalog that applied at each transcript point.

## System instructions and descriptions

CUA should get out of the business of generating default system prompts.

The model should learn what is available from the exact tool names, descriptions, and schemas it receives. Correctness-critical prerequisites belong in tool descriptions and schemas.

For example, `browser_act` must explain that ref-based steps require current refs from `browser_snapshot` or `browser_find`, that refs must not be invented, and that navigation may require a fresh snapshot.

Provider-recommended toolsets may reproduce provider tool shapes, but selecting them must not silently install the provider's example system prompt. The caller owns the system prompt.

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

Tzafon and Yutori require adapter changes before arbitrary composition is safe because their current payload hooks replace or suppress tools by name. That limitation should be reported against the affected requested tools, not represented as a blanket rejection of browser or mixed configurations.

## Removal of `computer_use_extra`

`computer_use_extra` should be deleted entirely: definition, executor, implicit installation, exports, tests, and documentation.

No replacement navigation helper is added automatically or under a new hidden name. A caller who needs navigation chooses an explicit capability, such as:

- a provider-native browser tool
- a provider-recommended toolset that genuinely includes navigation
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
anthropic browser_20260701 cannot be used with model openai:gpt-5.5
```

```text
tools "tzafon_computer" and "browser_click" require conflicting payload transforms
```

```text
provider google does not accept the schema used by "browser_act"
```

CUA must not silently drop tools, substitute a different toolset, append fallback tools, or rename an existing tool after a dynamic addition.

## Removal of current API

The following constructor options should be removed rather than deprecated:

```ts
extraTools
mode
nativeTool
playwright
activeToolNames
```

The following methods should be removed from the CUA-facing API:

```ts
setMode()
getMode()
setActiveTools()
```

`computer_use_extra` and CUA-generated default system prompts should be removed with them.

Their replacements are direct tool-list entries:

| Current option | Replacement |
| --- | --- |
| `extraTools: [tool]` | include `tool` in `tools` |
| `mode: "computer"` | `tools: cua.providers.<provider>.toolsets.computer()` or an explicit list |
| `mode: "browser"` | `tools: cua.toolsets.browser()` or an explicit list |
| `mode: "hybrid"` | compose the desired provider and CUA tools explicitly |
| `nativeTool: spec` | `tools: [cua.providers.anthropic.tools.browser(spec)]` |
| `playwright: true` | `tools: [cua.tools.playwright()]` |
| `activeToolNames` | pass the exact current list and change it with `setTools()` |

## Documentation requirements

The future implementation must update:

- `docs/architecture.md` with the tool-spec composition and provider-adapter ownership boundaries
- package READMEs with exact constructor examples and no legacy mode terminology
- API documentation with the definitions of tool, action, and toolset
- user-facing examples for native-only, provider-recommended plus CUA, Playwright-only, browser-act-only, empty, batch, and dynamic-loading configurations

Provider-recommended toolsets must link to or name the provider guidance they mirror. CUA-authored additions must be described as CUA capabilities rather than provider defaults.

## Design blockers before implementation

No implementation should begin until these questions have concrete prototypes or decisions:

1. **Name composition:** reject versus explicitly alias collisions, especially when provider-native names are fixed.
2. **Payload transforms:** compose native and function tools without classifying them by ambiguous model-facing names.
3. **Grounding ownership:** define post-action browser viewport versus OS display capture per tool, including mixed tool lists.
4. **Batch overlap:** settle the relationship among `computer_batch`, `browser_batch`, and `browser_act`, including intra-batch ref flow.
5. **Dynamic loading:** map `setTools()` onto pi's additive deferred-loading protocol while preserving CUA executors and session history.
6. **Shared resources:** share translators, CDP state, and refs without deriving a mode or allowing one tool to mutate another's public contract.
7. **Provider-recommended exports:** decide exactly which official or example tool shapes each provider namespace promises to mirror and how those promises are tested.

These are architecture questions, not implementation details. The spec should be revisited after focused spikes for naming, Tzafon/Yutori payload composition, mixed grounding, and cache-preserving dynamic loading.

## Decisions recorded

- `tools: []` is valid.
- CUA does not generate a default system prompt.
- `computer_use_extra` is removed with no implicit replacement.
- There is one current public tool list; no CUA-facing `activeToolNames` layer.
- Provider-recommended tools are namespaced separately from CUA-authored tools.
- Tool factories and toolsets are discoverable under a namespace, not exported as many global functions.
- `browser_act` remains outside `cua.toolsets.browser()` until it has broader production evidence.
- Naming, payload-transform composition, grounding, and batch overlap must be resolved before code is written.

## Acceptance criteria for a future implementation

- Both constructors have one required tool-selection source of truth and accept `tools: []`.
- The current tool-related constructor options, active-tool option, and mode methods are removed.
- `computer_use_extra` and CUA-generated default system prompts are removed.
- CUA-authored and provider-recommended tools are exposed through distinct, discoverable namespaces.
- Exact native-browser-only, provider-recommended-plus-CUA, Playwright-only, browser-act-only, and empty configurations are tested.
- No undeclared helper tool is installed.
- `computer_batch` exposes explicit action control, and a browser batch design is resolved and tested.
- Mid-conversation additive tool loading uses provider-native deferred loading where supported and preserves the prompt cache.
- Removals and replacements use a safe fallback and preserve transcript/session correctness.
- Model switching preserves the requested tool catalog or reports a named incompatibility.
- Tool descriptions mention only their own selected capabilities and prerequisites.
- Provider adapters compose explicit tool transformations rather than classify tools by ambiguous names.
- Coordinate conversion and post-action grounding are tool-owned, with no global or derived mode.
- Architecture, API, README, and user-facing terminology consistently distinguish tools, actions, and toolsets.
