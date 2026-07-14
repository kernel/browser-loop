# AgentHarness extension compatibility

Pi currently binds extensions to `AgentSession`, not `AgentHarness`. This directory
contains the temporary adapter used by the CUA CLI:

- `context.ts` implements Pi extension context actions over the harness.
- `hooks.ts` forwards harness hooks and lifecycle events to `ExtensionRunner`.
- `tool-registry.ts` reconciles extension tools with CUA tool/model changes.
- `host.ts` owns discovery, lifecycle, and manual reload.

Pi's `packages/agent/docs/hooks.md` designs generic `AgentHarness` hooks and its
`packages/agent/docs/agent-harness.md` plans a later coding-agent migration onto
that hook/session facade. When those APIs are public, replace this directory from
`../setup.ts`; `../add-tool.ts` and its standard Pi extension artifacts should not
need to move with it.
