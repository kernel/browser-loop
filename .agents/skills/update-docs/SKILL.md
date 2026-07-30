---
name: update-docs
description: Keep repository documentation accurate by auditing docs against source code, configs, READMEs, and external references. Use when updating docs, checking architecture docs, reviewing README drift, or maintaining files under docs/.
---

# Update Docs

Use this workflow to keep docs grounded in the current codebase. Prefer source-of-truth files over memory, and update only claims that are stale, missing, or misleading.

## Quick Start

1. List docs under `docs/` and identify the requested target docs.
2. Read the target doc before searching broadly.
3. Build a source-of-truth map for each major claim: code, config, package metadata, README, tests, or external docs.
4. Compare architecture diagrams, commands, examples, exported APIs, dependency descriptions, and invariants against those sources.
5. Edit the doc in the existing voice and structure. Preserve accurate content; avoid unrelated rewrites.
6. Validate links, paths, code snippets, diagrams, and commands that changed.

## Generic Review Loop

For every doc update:

- Check repository topology first: root package/config files, workspace references, package manifests, and build/test scripts.
- Check nearby implementation files for behavioral claims. Do not treat README prose as stronger evidence than code.
- Check package READMEs for public-facing wording that should stay consistent with the doc.
- Check tests when the doc describes regression coverage, CLI behavior, or expected outputs.
- Check external citations when the doc describes provider APIs or dated vendor features.
- Note the files that mattered most, then fold those notes into this skill if they are reusable.

## Editing Rules

- Keep docs concise and reader-oriented.
- Preserve intentional design goals and invariants even when implementation details move.
- Update diagrams when package ownership, dependencies, or runtime flow changes.
- Keep examples executable-looking: current commands, current package names, current model IDs.
- Do not add speculative roadmap content unless the doc already has an explicit out-of-scope or future-work section.
- Prefer local file paths over vague references like "the adapter" when naming a source of truth.

## `docs/architecture.md` Workflow

Start with these source-of-truth checks:

- Package topology: `package.json`, `tsconfig.json`, and `packages/*/package.json`.
- Design invariants: `@onkernel/cua-ai` owns provider-specific policy (catalog, tool schemas, payload transforms); `@onkernel/cua-agent` is provider-neutral runtime glue around `pi-agent-core` (no provider names in `packages/agent/src`); provider differences reach the agent as compiled `CuaToolCatalog` data; `@onkernel/cua-cli` composes both for orchestration.
- Model layer: `packages/ai/src/index.ts`, `cua.ts`, `tool-catalog.ts`, `getCuaModel`/`listCuaModels`/`parseCuaModelRef`, provider adapters, and `api-keys.ts`.
- Execution layer: `packages/agent/src/index.ts`, `CuaAgent` and `CuaAgentHarness` wiring, and the canonical CUA tool executors against `@onkernel/sdk`.
- CLI runtime flow: `packages/cli/src/cli.ts`, `cli-harness.ts`, `harness.ts`, `harness-browser.ts`, `harness-models.ts`, `harness-sessions.ts`, `harness-named-sessions.ts`, `harness-skills.ts`, `print.ts`, `output/harness-jsonl.ts`, `action/`, and `tui/`.
- TUI test infrastructure: `packages/ptywright/package.json`, `src/index.ts`, `src/session.ts`, `src/terminal.ts`, and `README.md`.
- External drift: provider computer-use docs, `@earendil-works/pi-*` versions, and `@onkernel/sdk` versions in package manifests.

Questions `architecture.md` should answer after each update:

- What owns the canonical action vocabulary and the model catalog?
- Where is the cua-ai vs cua-agent ownership boundary, and how do provider differences reach the agent without provider conditionals in `packages/agent/src`?
- Where does Kernel SDK browser execution happen?
- What does the CLI compose at runtime via `buildCuaHarness`?
- Which package is dev/test infrastructure only?

## Validation

- Re-read the changed doc and verify every new claim has a source.
- Check Markdown links and relative paths touched by the edit.
- For Mermaid changes, ensure node IDs have no spaces, labels with punctuation are quoted, and no explicit styling is used.
- For command changes, prefer a lightweight dry-run or help command when available.
- For docs-only changes, do not run the full build unless the edited examples or generated docs depend on build output.
