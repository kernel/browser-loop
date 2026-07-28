# `@onkernel/cua-ai`

The model and tool-policy layer for Kernel computer-use agents, built on
`@earendil-works/pi-ai` 0.80.10.

Use [`@onkernel/cua-agent`](../agent) when you also want Kernel-browser tool
execution. Use this package directly for model discovery, explicit tool catalog
construction, and provider transport composition.

## Install

```bash
npm install @onkernel/cua-ai
```

Requires Node 22.19 or newer.

## Model catalog

Model references are always provider-qualified:

```ts
import {
  getCuaModel,
  listCuaModels,
  parseCuaModelRef,
} from "@onkernel/cua-ai";

const model = getCuaModel("openai:gpt-5.6-sol");
console.log(parseCuaModelRef("anthropic:claude-opus-5"));
console.table(listCuaModels("google"));
```

`gemini:` aliases `google:` and `moonshot:` aliases `moonshotai:`. The package
does not export a default model. See [supported models](docs/supported-models.md)
for the curated list.

## Explicit tools

All CUA-owned tools are available from one frozen namespace:

```ts
import { cua } from "@onkernel/cua-ai";

const tools = [
  cua.tools.browser.snapshot(),
  cua.tools.browser.click(),
  cua.tools.computer.screenshot(),
];
```

Nothing is inferred from the model and no fallback tools are appended.

### Atomic browser tools

```ts
cua.tools.browser.snapshot();
cua.tools.browser.text();
cua.tools.browser.find();
cua.tools.browser.click();
cua.tools.browser.hover();
cua.tools.browser.drag();
cua.tools.browser.fill();
cua.tools.browser.scrollTo();
cua.tools.browser.scroll();
cua.tools.browser.type();
cua.tools.browser.key();
cua.tools.browser.navigate();
cua.tools.browser.listTabs();
cua.tools.browser.newTab();
cua.tools.browser.screenshot();
cua.tools.browser.evaluate();
cua.tools.browser.waitFor();
cua.tools.browser.act();
```

`browser_act` retains the established browser-action schema. Atomic tools expose
operation-specific arguments directly—there is no outer action wrapper.

### Atomic computer tools

```ts
cua.tools.computer.click();
cua.tools.computer.doubleClick();
cua.tools.computer.mouseDown();
cua.tools.computer.mouseUp();
cua.tools.computer.type();
cua.tools.computer.keypress();
cua.tools.computer.scroll();
cua.tools.computer.move();
cua.tools.computer.drag();
cua.tools.computer.wait();
cua.tools.computer.screenshot();
cua.tools.computer.zoom();
cua.tools.computer.goto();
cua.tools.computer.back();
cua.tools.computer.forward();
cua.tools.computer.url();
cua.tools.computer.cursorPosition();
```

Computer coordinates default to pixels. Callers can request an explicit
normalized contract:

```ts
cua.toolsets.computer({
  coordinates: cua.coordinates.normalized([0, 1000]),
});
```

### Toolsets, names, and batches

```ts
cua.toolsets.browser();
cua.toolsets.computer();
cua.toolsets.mixed();
cua.toolsets.browser({ namespace: "page" });

cua.tools.browser.snapshot({ name: "page_snapshot" });
cua.tools.computer.click({ name: "os_click" });

cua.tools.computer.batch({ actions: ["click", "keypress", "screenshot"] });
cua.tools.browser.batch({ actions: ["snapshot", "click", "wait_for", "text"] });

cua.tools.playwright();
```

Batches are mechanical primitive lists. They have no branching, saved values,
references, or workflow DSL.

## Provider-native composition

Provider-native tools are selected explicitly and may coexist with ordinary
function tools.

```ts
const tools = [
  cua.providers.anthropic.tools.computer({
    version: "20260701",
    enableZoom: true,
  }),
  cua.tools.browser.snapshot(),
];
```

Available groups:

```ts
cua.providers.openai.tools.computer();

cua.providers.anthropic.tools.computer({ version: "20260701" });
cua.providers.anthropic.tools.browser({ version: "20260701" });
cua.providers.anthropic.toolsets.computer(); // recommended deferred ordinary tools
cua.providers.anthropic.toolsets.browser();

cua.providers.google.toolsets.browser({ exclude: ["right_click"] });
cua.providers.google.toolsets.legacyBrowser({ exclude: ["drag_and_drop"] });

// Meta, xAI, and Moonshot use the ordinary CUA browser tools.
cua.toolsets.browser();

cua.providers.tzafon.tools.computer();
cua.providers.yutori.toolsets.n1();
cua.providers.yutori.toolsets.n15Core();
```

The current Google browser set exposes the current predefined action names and
uses normalized coordinates in `[0, 999]`. Its native `computer_use`
declaration excludes every unselected name across Google's published current
and legacy vocabularies because Gemini 3 preview endpoints can still surface
legacy predefined functions. This compatibility exclusion does not install
legacy helpers. If Google emits an excluded name anyway, the adapter returns a
named exact-catalog error instead of forwarding an undeclared tool call. The
legacy set remains distinct and is only compatible with a Gemini 2.5
computer-use model.

Provider-native caller-visible names are fixed by protocol. Version/tool/model
mismatches fail during catalog compilation. If an Anthropic credential cannot
access `browser_20260701`, CUA retries with an equivalent `browser` function
tool and remembers that choice for the credential and process. The mirrored sets track the
providers' published guidance: [Anthropic computer use](https://docs.anthropic.com/en/docs/build-with-claude/computer-use),
[Google computer use](https://ai.google.dev/gemini-api/docs/computer-use),
[Meta computer use](https://dev.meta.ai/docs/getting-started/cookbook/computer-use-macos),
[xAI function calling](https://docs.x.ai/developers/tools/function-calling), and
[Moonshot tool use](https://platform.kimi.ai/docs/api/tool-use).

## Catalog compilation

`compileCuaToolCatalog()` is the identity and validation boundary used by
`@onkernel/cua-agent`:

```ts
const catalog = compileCuaToolCatalog({
  model: "anthropic:claude-opus-5",
  requestedTools: tools,
  resources,
});

catalog.requested;      // exact caller list
catalog.entries;        // identities, fingerprints, declarations, coordinates
catalog.agentTools;     // materialized pi AgentTools
catalog.headers.merge(callerHeaders);
await catalog.payload.apply(payload, catalog.model);
catalog.incoming;
```

A CUA-owned identity remains stable when its name is customized. Caller tools
receive `caller.<name>` identities. Compilation rejects:

- duplicate identities;
- exact or provider-normalized caller-visible name collisions;
- unsafe names;
- incompatible model/provider-native combinations;
- conflicting payload-transform write claims;
- partial provider-native selections that violate a provider contract.

The catalog fingerprint includes model, order, identity, name, schema,
coordinates, and executor identity. Schema or executor replacement therefore
cannot masquerade as a no-op.

Generated payload processing has deterministic order:

1. model preparation;
2. tool declaration serialization;
3. provider request fields;
4. visual grounding;
5. caller `onPayload` (applied by `cua-agent`).

Generated header requirements merge with caller headers. Comma-list headers are
unioned and deduplicated; exact-value conflicts throw.

## Dynamic loading metadata

Ordinary function tools are marked eligible only where pi 0.80.10 supports
deferred loading. Provider-native tools are eager-only. The catalog itself does
not guess when tools were added; `CuaAgent`/`CuaAgentHarness` record in-tool
additions through pi's active-tool change entries.

## Provider behavior

- **OpenAI**: CUA-owned Responses transport for native computer plus ordinary
  function composition and response threading.
- **Anthropic**: exact native declarations, beta-header composition, adaptive
  model preparation, and recommended deferred function toolsets.
- **Google**: a CUA-owned Interactions API adapter plus current and legacy
  predefined browser sets with explicit exclusions and generation-specific
  coordinate contracts.
- **Meta/xAI/Moonshot**: ordinary function tools with serial tool calls when the
  selected catalog mutates browser state.
- **Tzafon**: identity-scoped native declaration replacement with actual viewport
  dimensions.
- **Yutori**: identity-scoped native `tool_set`/`disable_tools` fields and one
  fresh request-time screenshot in the latest provider message.

## API keys

```ts
import {
  cuaApiKeyEnvVarsForProvider,
  getCuaEnvApiKeyForModel,
  requireCuaEnvApiKeyForModel,
} from "@onkernel/cua-ai";
```

Conventional variables are `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GOOGLE_API_KEY`/`GEMINI_API_KEY`, `META_API_KEY`, `XAI_API_KEY`,
`MOONSHOT_API_KEY`, `TZAFON_API_KEY`, and `YUTORI_API_KEY`.

## Development

```bash
npm run typecheck --workspace @onkernel/cua-ai
npm test --workspace @onkernel/cua-ai
npm run build --workspace @onkernel/cua-ai
```

See [`examples/quickstart.ts`](examples/quickstart.ts) for direct catalog/model
usage.

## License

MIT.
