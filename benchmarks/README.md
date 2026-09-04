# benchmarks — run cua as a Harbor agent

You already know [cua](../README.md) drives a Kernel browser with a computer-use
model. This directory lets you point cua at **benchmarks** — and measure how
different models score — by running it under
[Harbor](https://github.com/kernel/harbor), an evaluation framework for agents.

## Harbor in one minute

Harbor runs a task by pairing two pluggable pieces:

- an **environment** — the machine the task runs on. Here it's the **Kernel**
  environment: it starts a Kernel browser session and exposes
  `KERNEL_SESSION_ID` / `KERNEL_API_KEY`.
- an **agent** — the thing that attempts the task in that environment. **That is
  what this directory provides:** a Harbor agent that drives the cua harness.

Harbor loads each by import path, so neither Harbor nor cua needs to know about
the other ahead of time. You run a task with `harbor run`, pointing `-e` at the
Kernel environment and `--agent-import-path` at the cua agent here.

## Get started

```bash
# one-time: resolve the Python env and build the Node entrypoint
uv sync && (cd node && npm install && npm run build)

# run the example task on a real Kernel browser (KERNEL_API_KEY must be set)
uv run harbor run -p examples/tasks/cua-hello -e kernel \
  --agent-import-path cua_harbor:CuaHarborAgent \
  -m anthropic/claude-opus-4-8 --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
```

That lands the browser on `example.com`, asks cua for the page heading, and a
verifier checks the answer. `-m provider/name` picks the cua model; `--ae
KEY=VALUE` forwards a provider API key (swap both for another provider, e.g.
`-m openai/gpt-5.5 --ae OPENAI_API_KEY=$OPENAI_API_KEY`).

## What's here

```
benchmarks/
  pyproject.toml          uv project "cua-harbor"; depends on harbor (git)
  src/cua_harbor/         the Harbor agent (loaded via --agent-import-path)
    agent.py              CuaHarborAgent(BaseAgent): setup / run / post-run
    trajectory.py         run.jsonl -> Harbor ATIF trajectory
    models.py             Harbor provider/name -> cua provider:name + provider-key map
    constants.py          the /logs/agent on-disk contract
  node/                   self-contained one-task entrypoint (published @onkernel/*)
    src/task.ts           attach via browsers.retrieve; run CuaAgentHarness; emit artifacts
    src/sink.ts           harness event sink: run.jsonl + spilled screenshots
    src/answer.ts         final-answer extraction from the session branch
  examples/tasks/cua-hello/   a minimal browser task to smoke the connection
```

## How a task runs

The Kernel environment starts one browser session and hands the agent
`KERNEL_SESSION_ID` / `KERNEL_API_KEY`. `CuaHarborAgent` runs on the host: it
maps the Harbor `provider/name` model to cua's `provider:name`, forwards the
provider key (from `--ae`) plus the two Kernel vars into the Node entrypoint, and
points it at `/logs/agent`. The entrypoint attaches to the existing session
(never creating or deleting it), runs `CuaAgentHarness`, and writes:

- `answer.txt` — the final assistant text (the grading channel)
- `shots/shot-<n>.<ext>` — per-step screenshots
- `run.jsonl` — a raw event log

The agent then maps `run.jsonl` to an ATIF `trajectory.json` and backfills token
and cost metrics onto Harbor's `AgentContext`. The verifier reads `answer.txt`
(and, for multimodal graders, `shots/`) from `/logs/agent`.

The entrypoint runs on the host because cua only needs the Kernel control plane
plus the session id and key — all host-reachable — and the Kernel base VM ships
no Node.

## Develop

```bash
uv run ruff check
uv run pytest

cd node && npm run build && npm run typecheck && npx vitest --run
```
