"""On-disk contract shared by the Python agent and the Node entrypoint.

These names pin every relative path under ``self.logs_dir`` (== ``/logs/agent``
in the Kernel VM) and every environment variable the Node process reads, so the
agent, the trajectory mapper, the Node ``task.ts``, and any ``test.sh`` agree by
construction.
"""

# Paths relative to self.logs_dir (== /logs/agent in-VM).
ANSWER_FILE = "answer.txt"  # grading channel the verifier reads
TRAJECTORY_FILE = "trajectory.json"  # ATIF trajectory (analysis / RL)
RUN_JSONL = "run.jsonl"  # raw cua event log the trajectory mapper reads
SHOTS_DIR = "shots"  # spilled screenshots, referenced by the ATIF image sources

# Environment variables the Node entrypoint consumes.
ENV_KERNEL_API_KEY = "KERNEL_API_KEY"
ENV_KERNEL_SESSION_ID = "KERNEL_SESSION_ID"
ENV_CUA_MODEL = "CUA_MODEL"  # "provider:name"
ENV_AGENT_OUT_DIR = "AGENT_OUT_DIR"  # absolute dir the entrypoint writes into
ENV_AGENT_INSTRUCTION = "AGENT_INSTRUCTION"  # the prompt (avoids argv escaping)
ENV_TASK_ID = "TASK_ID"

# Fallback when the bundled node/package.json pin cannot be read.
DEFAULT_CUA_AGENT_VERSION = "0.3.5"
