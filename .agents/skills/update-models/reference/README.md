# Update Models Reference

These scripts support the `update-models` skill. Run them from the repository root.

## Requirements

- Node 20+
- Repository dependencies installed with `npm install`
- TypeScript runner available through `npx tsx` or another local TS runner
- Provider API keys as needed:
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `GOOGLE_API_KEY` or `GEMINI_API_KEY`
  - `XAI_API_KEY`
  - `MOONSHOT_API_KEY`

The scripts never print API keys. Smoke tests are non-destructive: they ask each model to emit a computer-use tool call, then inspect the response without executing the action. Meta, xAI, and Moonshot use supplied function tools; other providers may use provider-native computer tools.

## Common Commands

Discover all providers and smoke-test likely candidates:

```bash
npx tsx .agents/skills/update-models/reference/discover-models.ts --provider all --out /tmp/cua-model-report.json
```

Probe native action vocabularies for a specific provider/model:

```bash
npx tsx .agents/skills/update-models/reference/native-action-probe.ts --provider openai --model gpt-5.5 --out /tmp/openai-actions.json
npx tsx .agents/skills/update-models/reference/native-action-probe.ts --provider xai --model grok-4.5 --out /tmp/xai-actions.json
```

Clone/update official examples and extract tool-handling evidence:

```bash
npx tsx .agents/skills/update-models/reference/audit-official-examples.ts --out /tmp/cua-example-evidence.json
```

Examples are cached under `/tmp/cua-update-models/examples` by default so cloned upstream repos do not appear as untracked files in this repository.

Compare official docs, examples, and local adapter constants:

```bash
npx tsx .agents/skills/update-models/reference/provider-doc-drift.ts --examples /tmp/cua-example-evidence.json --out /tmp/cua-drift.json
```

## Evidence Types

- `metadata`: provider model-list APIs.
- `docs`: provider docs or SDK source fetched live.
- `examples`: provider-owned or doc-linked example repos.
- `smoke`: live API response shape for provider-native computer use.
- `local`: constants in this repo's provider adapters.

Use `report-schema.md` when summarizing results for humans.
