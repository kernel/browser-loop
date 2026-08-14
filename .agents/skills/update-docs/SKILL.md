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

- Package topology: `package.json`, `tsconfig.json`, and `packages/*/package.json`. `@onkernel/loop` is one package with two entry points (`.` and `./pi`) and a `pi.extensions` field.
- Design invariants: `packages/loop/src/core` is the framework-neutral core (canonical actions, tool declarations, catalog compilation, tool menu, tool manager, Kernel-browser execution); `packages/loop/src/pi` owns provider-specific policy (model resolution, transport derivation, adapters, payload transforms, headers, retry); provider differences reach execution as compiled `LoopToolCatalog` data rather than provider conditionals in the translator.
- Neutral core: `packages/loop/src/index.ts`, `core/tools.ts`, `core/actions/`, `core/tool-catalog.ts`, `core/menu.ts`, `core/tool-manager.ts`, `core/resources.ts`, and `core/translator/`.
- pi binding: `packages/loop/src/pi/index.ts`, `pi/attach.ts`, `pi/models.ts` (`getLoopModel`/`listLoopModels`/`parseLoopModelRef`), `pi/providers/`, `pi/provider-retry.ts`, and `pi/api-keys.ts`.
- Extension runtime flow: `packages/loop/src/pi-extension/index.ts`, `selection.ts`, `browser-runtime.ts`, `state.ts`, and `render.ts`.
- TUI test infrastructure: `packages/ptywright/package.json`, `src/index.ts`, `src/session.ts`, `src/terminal.ts`, and `README.md`.
- External drift: provider computer-use docs, `@earendil-works/pi-*` versions, and `@onkernel/sdk` versions in package manifests.

Questions `architecture.md` should answer after each update:

- What owns the canonical action vocabulary and the model catalog?
- Where is the `src/core` vs `src/pi` boundary, and how do provider differences reach execution without provider conditionals in the translator?
- Where does Kernel SDK browser execution happen?
- What does the pi extension compose at runtime, and which selectors does it offer?
- Which package is dev/test infrastructure only?

## Validation

- Re-read the changed doc and verify every new claim has a source.
- Check Markdown links and relative paths touched by the edit.
- For Mermaid changes, ensure node IDs have no spaces, labels with punctuation are quoted, and no explicit styling is used.
- For command changes, prefer a lightweight dry-run or help command when available.
- For docs-only changes, do not run the full build unless the edited examples or generated docs depend on build output.
