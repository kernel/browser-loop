# Agent Tool Configuration

**Status:** Draft for later review  
**Scope:** `@onkernel/cua-agent` and the tool-building surface in `@onkernel/cua-ai`  
**Compatibility:** Not a goal; these packages are alpha and may make breaking API changes.

## Summary

`CuaAgent` and `CuaAgentHarness` should have one explicit source of truth for the tools exposed to a model: a required `tools` array.

The array may contain:

- Kernel CUA tool specifications, such as browser snapshot or browser action plans
- provider-native tools, such as Anthropic's native browser tool
- runtime tools, such as `playwright_execute`
- ordinary caller-provided `AgentTool` objects

The current `extraTools`, `mode`, `nativeTool`, and `playwright` constructor options should be removed. No global or derived mode should replace them. Each CUA tool specification must contain enough information to build, expose, execute, and describe that tool independently.

Convenience toolsets may return arrays of tool specifications, but they must not establish hidden runtime modes or add undeclared tools.

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
- `computer_use_extra` may be added implicitly.
- `CuaAgentHarness.activeToolNames` can hide a subset after installation.

The same configuration also controls unrelated runtime policy: coordinate interpretation, post-action screenshots, system instructions, provider eligibility, and payload rewriting. This makes new interaction methods difficult to add and makes the actual model-facing surface difficult to predict.

The public distinction should instead be simple:

- A **tool** is a callable capability directly exposed to the model.
- An **action** is an operation requested within a tool call.
- A **toolset** is an ordinary array of tools chosen by the caller.

For example, Anthropic's native `browser` is one tool with multiple actions. `browser_act` is one tool containing a sequence of step actions. `browser_snapshot` is a single-purpose tool whose input does not need an action discriminator.

`CuaAction` may remain an internal normalized execution representation, but agent constructors should not expose it as their tool-selection API.

## Goals

1. Make the exact model-facing tool catalog obvious at the constructor call site.
2. Support minimal configurations without hidden additions.
3. Allow provider-native, canonical CUA, Playwright, and caller tools to compose in one list.
4. Let every tool own the runtime policy required to execute it correctly.
5. Keep installed-tool selection separate from the harness's dynamic active-tool selection.
6. Validate tool/model incompatibilities directly and early.
7. Permit experimentation with new tools without adding constructor flags or global modes.

## Non-goals

- Preserving the current constructor API
- Preserving current mode-dependent tool aliases
- Automatically selecting a supposedly optimal toolset for a model
- Exposing the internal canonical action IR as constructor configuration
- Automatically adding prerequisite or fallback tools
- Silently replacing incompatible tools when the model changes

## Proposed public API

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
  activeToolNames?: string[];
}
```

A `CuaToolSpec` is declarative because CUA must materialize it against the Kernel browser, SDK client, selected model, and provider transport. An `AgentTool` is already executable and can be installed directly.

The exact naming and factory namespace are open to revision. The required semantic property is that each factory adds one inspectable model-facing tool.

## Exact configurations

### Native Anthropic browser plus an unrelated custom tool

```ts
tools: [
  cua.tools.anthropic.browser({
    version: "20260701",
    javascript: true,
  }),
  customerLookupTool,
]
```

The model receives exactly the native browser tool and `customer_lookup`. CUA must not add canonical browser tools, computer navigation helpers, screenshots, or Playwright.

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

### Native and canonical tools together

```ts
tools: [
  cua.tools.anthropic.computer({ version: "20260701" }),
  cua.tools.browser.snapshot(),
  cua.tools.browser.act(),
]
```

This combination is valid only if the provider transport accepts the native declaration alongside ordinary function tools. Validation belongs to the selected tool specifications and provider request composer, not to a global mode check.

## Convenience toolsets

Convenience helpers may provide curated arrays:

```ts
tools: cua.toolsets.computer()
```

```ts
tools: cua.toolsets.browser()
```

```ts
tools: cua.toolsets.mixed()
```

They are ordinary array factories, so callers can inspect and compose them:

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

## No global or derived mode

The runtime must not derive `computer`, `browser`, or `hybrid` state from the selected tools. Those labels are too coarse to govern execution safely.

Instead, each `CuaToolSpec` supplies the policy needed for that tool to do its work:

- model-facing name, description, and schema or native declaration
- local executor construction
- provider and model compatibility checks
- request headers and payload transformation, when required
- incoming native-call normalization, when required
- coordinate contract and conversion, when applicable
- browser viewport or OS display grounding behavior, when applicable
- post-action observation behavior
- tool-specific instruction fragments, when unavoidable
- conflicts with other tool specifications

Examples:

- A computer click tool owns its provider coordinate conversion and OS-level input execution.
- A browser click tool owns viewport/ref targeting and CDP execution.
- A native Anthropic browser tool owns its beta header, native declaration, input mapping, and first-failure rules.
- `playwright_execute` owns its execution context and does not imply screenshot or computer tools.
- `browser_act` owns semantic polling, plan deadlines, and stable successor collection.

No shared mode is needed to decide which screenshot to return. A tool that needs post-action grounding declares the appropriate observation source itself. A tool that returns structured text may declare that no automatic image is needed.

## Tool composition

Tool specifications are composed before the first provider request.

Composition must:

1. Materialize each requested tool against the browser and client.
2. Validate unique model-facing names.
3. Validate every tool against the selected model and provider.
4. Compose compatible headers and payload transforms.
5. Reject conflicting transforms with an error naming the conflicting tools.
6. Compose tool-specific instruction fragments without inventing a global mode prompt.
7. Install exactly the requested tools.

Payload transforms must operate on explicit tool identities, not infer ownership from names such as `click`. This is required for providers like Tzafon and Yutori, whose current native-tool adapters classify or replace tools by name.

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

Caller-provided generic tools and compatible canonical CUA tools remain installed.

## Installed versus active tools

`tools` defines the installed catalog for both agent classes.

`CuaAgent` exposes the configured catalog directly because pi's lower-level `Agent` has no separate active-tool catalog.

`CuaAgentHarness` retains pi's existing active-tool mechanism:

```ts
const harness = new CuaAgentHarness({
  // ...
  tools: [
    cua.tools.browser.snapshot(),
    cua.tools.browser.act(),
    customerLookupTool,
  ],
  activeToolNames: ["browser_snapshot", "customer_lookup"],
});

await harness.setActiveTools([
  "browser_snapshot",
  "browser_act",
]);
```

Tool names must remain stable because they are persisted in harness sessions. There is no mode switch that aliases `browser_act` to `act` or changes activation identity.

`setTools()` replaces the caller-owned catalog and must update CUA's materialized runtime consistently. It must not be an inherited operation that can be overwritten later by an independent runtime controller.

## Tool names

A configured tool's name should be the name exposed to the model and returned by inspection APIs. Tool factories must not rename tools based on the presence of other tools.

Names should distinguish potentially coexisting capabilities, for example `computer_click` and `browser_click`. Provider-native names may follow provider requirements and may allow an explicit supported override.

Stable names are more important than preserving the current computer/browser mode aliases.

## Tools and actions

Public documentation should use these terms consistently:

### Tool

A callable entry in the provider request's tool catalog.

Examples:

- `browser_act`
- `browser_snapshot`
- `playwright_execute`
- Anthropic's native `browser`
- a caller's `customer_lookup`

### Action

An operation selected through a tool's arguments.

Examples:

- `left_click` in Anthropic's native browser tool
- a `click` step inside `browser_act.steps`
- `goto` inside a batch computer tool

Some single-purpose tools do not need an explicit action argument. Internally converting their call into a `CuaAction` does not make the public callable surface an action.

If a particular tool supports restricting its actions, that restriction belongs to that tool's factory:

```ts
cua.tools.computer.batch({
  actions: ["click", "type", "screenshot"],
})
```

A server-defined native tool may not permit action restriction. Its factory must reject unsupported configuration rather than pretend to narrow the provider schema.

## System instructions and descriptions

The model should learn what is available primarily from the exact tool names, descriptions, and schemas it receives.

Each tool description must state its prerequisites. For example, `browser_act` must explain that ref-based steps require current refs from `browser_snapshot` or `browser_find`, that refs must not be invented, and that navigation may require a fresh snapshot.

Cross-tool instruction fragments may be composed when needed, but they must be generated from the actual selected tools. A caller selecting only Playwright should not receive computer or snapshot instructions. A caller selecting native browser plus a custom business tool should receive no canonical browser-tool guidance.

Correctness-critical requirements should live in tool descriptions and schemas rather than only in a default system prompt, because callers may replace the prompt.

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

## Error behavior

Construction or model switching should fail with errors that name the requested tools and the violated constraint.

Examples:

```text
tool name "browser_act" is configured more than once
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

CUA must not silently drop tools, substitute a different toolset, or append fallback tools.

## Removal of current options

The following constructor options should be removed rather than deprecated:

```ts
extraTools
mode
nativeTool
playwright
```

Their replacements are direct tool-list entries:

| Current option | Replacement |
| --- | --- |
| `extraTools: [tool]` | `tools: [..., tool]` |
| `mode: "computer"` | `tools: cua.toolsets.computer()` |
| `mode: "browser"` | `tools: cua.toolsets.browser()` |
| `mode: "hybrid"` | `tools: cua.toolsets.mixed()` |
| `nativeTool: spec` | `tools: [cua.tools.anthropic.browser(spec)]` |
| `playwright: true` | `tools: [cua.tools.playwright()]` |

`setMode()` and `getMode()` should also be removed. Callers replace tools with `setTools()` or change their active subset with `setActiveTools()`.

## Open questions

1. What final namespace and factory names should `cua.tools` and `cua.toolsets` use?
2. Should constructors require at least one tool, or permit `tools: []` for a text-only agent?
3. Which stable names should replace the current mode-dependent aliases?
4. Which instruction fragments, if any, belong outside individual tool descriptions?
5. What interface should a tool use to declare payload-transform conflicts and post-action grounding?
6. Should `browser_act` remain outside `cua.toolsets.browser()` until it has broader production evidence?

## Acceptance criteria for a future implementation

- Both constructors have one tool-selection source of truth.
- The four current tool-related constructor options and mode methods are removed.
- Exact native-browser-only, Playwright-only, and browser-act-only configurations are tested.
- No undeclared helper tool is installed.
- Model switching preserves the requested tool catalog or reports a named incompatibility.
- Harness active-tool state uses stable model-facing names.
- Tool descriptions and generated instructions mention only selected capabilities.
- Provider adapters compose explicit tool transformations rather than classify tools by ambiguous names.
- Coordinate conversion and post-action grounding are tool-owned, with no global or derived mode.
