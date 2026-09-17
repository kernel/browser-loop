# Jev System One browser-agent prototype

This experiment tests whether TypeSafe AI's Jev can drive a browser loop directly from a natural-language task, and compares it with a minimal planner + Jev design.

## Conclusion

Jev can run the whole interaction loop when code can enumerate every legal action and argument. It handled all 26 bounded interaction/extraction trials in the recorded run. It cannot satisfy a genuinely open-ended task such as summarization because the System One API returns typed decisions, not generated text. The hybrid completed all 29 trials, but roughly doubled median wall time and cost 2.7x more overall.

Recommended split:

- Use Jev directly for closed-world browser workflows: choose among grounded DOM actions, select verbatim values already present in the task or page, and stop against explicit evidence.
- Add a small planner/finalizer only when the task requires decomposition, unseen argument generation, or prose synthesis.
- Keep control flow, side effects, action bounds, and completion invariants in code. Do not treat Jev as a drop-in chat-model agent.

## What the API supports

The prototype calls `POST /v1/systemone` through `@typesafe-ai/sdk` using `JEV_API_KEY`. A request contains structured `state` plus named questions. Jev supports:

- `choice`: one option from a caller-defined set (maximum 255), with a full probability distribution and confidence;
- `noul`: a yes/no probability;
- `score`: an expected position on a caller-defined ordered rubric.

Jev does not generate arbitrary strings, selectors, code, or tool arguments. The model used in the recorded run resolved from `jev-latest` to `jev-1.13.0`. TypeSafe reports input and output token counts, but currently prices only input at $0.042 per million tokens.

Sources:

- <https://docs.typesafe.ai/api>
- <https://docs.typesafe.ai/concepts/how-to-build-with-system-one>
- <https://docs.typesafe.ai/primitives/choice>
- <https://typesafe.ai/blog/introducing-system-one-models-and-jev>

## Architecture

1. **Observe deterministically.** Playwright reads the URL, title, bounded visible body text, and up to 120 visible interactive DOM elements. No model-written JavaScript runs.
2. **Enumerate actions in code.** The candidate set contains clicks, select options, bounded fill values, back, finish, and fail. Password/file inputs are excluded. Already-checked controls are not offered again. The list is capped at 255 options.
3. **Decide with Jev.** One System One call asks a `choice` for the next action and a parallel `noul` for completion evidence. The selected label maps back to an in-memory action object.
4. **Gate and execute.** Code enforces a 12-step limit, rejects very low action confidence, executes only the enumerated action, and owns deterministic stop conditions such as a requested destination navigation.
5. **Answer within capability.** Jev-only can select an exact answer from bounded page spans. It returns `unsupported` before acting when the task requires free-form generation.
6. **Hybrid option.** Gemini 3.5 Flash-Lite runs once to normalize browser end states and collect literal values. It runs again only for requested free-form synthesis. Jev still chooses every browser action.

The planner never executes browser actions. The browser loop remains constrained even when planning is enabled.

## Files

- `agent.ts`: loop, gates, Jev-only capability boundary, and hybrid composition
- `actions.ts`: bounded action/value candidate generation
- `browser.ts`: local Chromium observation and execution
- `models.ts`: Jev policy and Gemini planner/finalizer
- `fixture-server.ts`: credential-free synthetic tasks
- `eval.ts`: repeated synthetic/public evaluation harness
- `artifacts/jev-eval-2026-09-17.json`: raw per-run traces and measurements

## Reproduce

Requirements: Node.js 22+, a local Chromium binary, `JEV_API_KEY`, and `GOOGLE_API_KEY` for hybrid mode.

```bash
cd packages/browser-loop/examples/jev-system-one
npm ci --workspaces=false
npm run typecheck
npm test

# Full recorded matrix: 3 repetitions per synthetic case, 1 per public case.
npm run eval -- --mode both --repeat 3 --public --output artifacts/jev-eval.json

# Jev-only does not require GOOGLE_API_KEY.
npm run eval -- --mode jev-only --repeat 3

# Run one public task.
npm run run -- \
  --mode jev-only \
  --url https://news.ycombinator.com \
  --task "Open the newest submissions page using the new link."
```

The harness launches one local headless Chromium process, gives every trial a fresh browser context, and closes contexts, Chromium, and the fixture server in `finally` blocks.

## Recorded evaluation

Run date: 2026-09-17. Synthetic cases ran three times per mode; public cases ran once per mode. Costs use published list prices: Jev at $0.042/M input tokens and Gemini 3.5 Flash-Lite at $0.30/M input plus $2.50/M output. Browser cost is excluded because Chromium ran locally.

| Case | Jev-only | Hybrid |
| --- | ---: | ---: |
| Single safe click | 3/3 | 3/3 |
| Two-field form | 3/3 | 3/3 |
| Select + checkbox | 3/3 | 3/3 |
| Semantic price/stock comparison | 3/3 | 3/3 |
| Multi-page wizard | 3/3 | 3/3 |
| Search then choose result | 3/3 | 3/3 |
| Dynamic reveal then choose | 3/3 | 3/3 |
| Bounded exact-text extraction | 3/3 | 3/3 |
| Open-ended two-sentence summary | 0/3, explicitly unsupported | 3/3 |
| Public example.com navigation | 1/1 | 1/1 |
| Public Hacker News navigation | 1/1 | 1/1 |
| **All trials** | **26/29 (89.7%)** | **29/29 (100%)** |
| **Bounded interaction/extraction only** | **26/26 (100%)** | **26/26 (100%)** |

| Metric | Jev-only | Hybrid |
| --- | ---: | ---: |
| Median end-to-end trial latency | 652 ms | 1,599 ms |
| p95 end-to-end trial latency | 1,387 ms | 2,274 ms |
| Median Jev API call latency | 151 ms | 150 ms |
| p95 Jev API call latency | 278 ms | 212 ms |
| Jev calls | 84 | 87 |
| Planner/finalizer calls | 0 | 32 |
| Jev input / output tokens | 123,036 / 20,823 | 118,475 / 18,522 |
| Planner input / output tokens | 0 / 0 | 10,059 / 2,418 |
| Total estimated model cost | $0.005168 | $0.014039 |

The hybrid's planner call added roughly 0.9 seconds to a typical trial. It did not improve bounded-action success in this small matrix; its measurable value was enabling the open-ended summary.

## Limitations

- The evaluation is small and mostly synthetic. The two public tasks are sanity checks, not BrowserGym/WebArena coverage.
- Observation is DOM/text-only. There is no screenshot perception, canvas handling, iframe traversal, shadow-DOM traversal, download/upload flow, CAPTCHA handling, or coordinate action.
- Jev-only fill values must be recoverable as bounded spans from the task. It cannot invent an email body, derive an unseen date, or produce prose.
- Completion is the weakest part of a generic loop. The prototype combines Jev's independent completion probability, its finish choice, and deterministic URL rules. Production workflows should use task-specific postconditions instead of generic thresholds.
- Confidence thresholds were not calibrated on enough examples for destructive actions. This prototype deliberately omits credentials, password/file inputs, and production side effects.
- The action list can still be expensive on large forms because fill candidates are the cross product of fields and task spans. A production implementation should use a planner-produced value map or hierarchical selection.
- Planner output can be semantically imperfect even when JSON-valid. Code filters synthesis steps out of the browser goal, but richer plans need schema-level invariants and evals.
- Token counts come from provider responses; dollar amounts are estimates from published list prices and exclude free-tier effects, retries, and local browser compute.

## Recommendation

Do not build a general natural-language browser agent around Jev alone. Build a constrained browser executor where code generates the legal action space and Jev ranks it. Route only tasks requiring decomposition or generation to a small planner/finalizer. For fixed workflows, omit the planner: it added latency and cost without improving success here.
