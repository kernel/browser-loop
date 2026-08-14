# CUA CLI Harness Migration

**Status:** Historical (2026-08-14). The CLI now composes a stock pi `AgentHarness` from
`attach()` rather than `CuaAgentHarness`, which no longer exists. Retained as the record of
the print/action/interactive consolidation this describes.

The CLI uses one shared composition path for print,
action, and TUI flows. Its current architecture—including explicit tool-list
selection, coding-tool composition, sessions, skills, and rendering—is
documented in [`architecture.md`](architecture.md#cli-composition).

This file intentionally contains no historical API guidance; use the package
READMEs and changelogs when migrating a consumer.
