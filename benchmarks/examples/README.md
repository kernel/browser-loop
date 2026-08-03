# Example task: `cua-hello`

A minimal browser task that smokes the whole connection: it lands the Kernel
browser on `example.com`, asks the cua agent for the page's main heading, and a
deterministic verifier checks the answer for "Example Domain".

## Run it

From `benchmarks/`, build the Node entrypoint and resolve the Python package,
then invoke Harbor against the task with the Kernel environment and the cua
agent:

```bash
cd benchmarks && uv sync && (cd node && npm install && npm run build)
uv run harbor run -p examples/tasks/cua-hello -e kernel \
  --agent-import-path cua_harbor:CuaHarborAgent \
  -m anthropic/claude-opus-4-8 --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
```

`KERNEL_API_KEY` must be set in your environment (Harbor's Kernel environment
preflight requires it). Swap `-m` and the matching `--ae` key for another
provider (e.g. `-m openai/gpt-5.5 --ae OPENAI_API_KEY=$OPENAI_API_KEY`).
