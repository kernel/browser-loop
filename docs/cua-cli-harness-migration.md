# CUA CLI Harness Migration

**Status:** Completed and superseded.

The CLI now uses the shared `CuaAgentHarness` composition path for print,
action, and TUI flows. Its current architecture—including explicit tool-list
selection, coding-tool composition, sessions, skills, and rendering—is
documented in [`architecture.md`](architecture.md#cli-composition).

This file intentionally contains no historical API guidance; use the package
READMEs and changelogs when migrating a consumer.
