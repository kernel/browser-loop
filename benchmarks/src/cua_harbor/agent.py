"""``CuaHarborAgent`` — a Harbor ``BaseAgent`` that drives the cua harness.

Loaded by Harbor via ``--agent-import-path cua_harbor:CuaHarborAgent``. It runs
the cua agent loop against the Kernel environment's existing browser session by
spawning the bundled Node entrypoint (``node/dist/task.js``) on the host,
attaching to ``KERNEL_SESSION_ID`` (never creating or deleting the session). The
entrypoint writes the answer, screenshots, and a raw event log under
``self.logs_dir``; this agent maps that log to an ATIF trajectory.
"""

import asyncio
import json
import os
import shutil
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from cua_harbor import constants
from cua_harbor.models import provider_key_env, to_cua_model_ref
from cua_harbor.trajectory import build_trajectory

_PACKAGED_NODE_DIST = Path(__file__).parent / "_node_dist"
_REPO_NODE_DIST = Path(__file__).resolve().parents[2] / "node" / "dist"


class CuaHarborAgent(BaseAgent):
    SUPPORTS_ATIF = True
    SUPPORTS_WINDOWS = False

    @staticmethod
    def name() -> str:
        return "cua"

    def version(self) -> str | None:
        pkg = _REPO_NODE_DIST.parent / "package.json"
        if pkg.exists():
            deps = json.loads(pkg.read_text()).get("dependencies", {})
            pinned = deps.get("@onkernel/cua-agent")
            if pinned:
                return pinned.lstrip("^~")
        return constants.DEFAULT_CUA_AGENT_VERSION

    def _bundle_path(self) -> Path:
        """Resolve the Node entrypoint: packaged copy first, repo sibling next."""
        for dist in (_PACKAGED_NODE_DIST, _REPO_NODE_DIST):
            bundle = dist / "task.js"
            if bundle.exists():
                return bundle
        raise FileNotFoundError(
            "cua Node entrypoint not built; run "
            "`cd benchmarks/node && npm install && npm run build`"
        )

    async def setup(self, environment: BaseEnvironment) -> None:
        # Host run: the entrypoint talks to the Kernel control plane directly, so
        # nothing is installed in the VM. Fail fast if node or the bundle is missing.
        if shutil.which("node") is None:
            raise RuntimeError("node is required on the host to run the cua agent")
        self._bundle_path()

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self._last_instruction = instruction
        persistent = environment._persistent_env
        session_id = persistent.get(constants.ENV_KERNEL_SESSION_ID)
        api_key = persistent.get(constants.ENV_KERNEL_API_KEY)
        if not session_id or not api_key:
            raise RuntimeError(
                "Kernel session not started: missing "
                f"{constants.ENV_KERNEL_SESSION_ID}/{constants.ENV_KERNEL_API_KEY}"
            )
        if not self.model_name:
            raise RuntimeError("model_name is required (pass -m provider/name)")

        child_env = {
            **os.environ,
            **provider_key_env(self.model_name, self.extra_env),
            constants.ENV_KERNEL_API_KEY: api_key,
            constants.ENV_KERNEL_SESSION_ID: session_id,
            constants.ENV_CUA_MODEL: to_cua_model_ref(self.model_name),
            constants.ENV_AGENT_OUT_DIR: str(self.logs_dir),
            constants.ENV_AGENT_INSTRUCTION: instruction,
            constants.ENV_TASK_ID: session_id,
        }

        stdout_path = self.logs_dir / "node-stdout.log"
        stderr_path = self.logs_dir / "node-stderr.log"
        with stdout_path.open("wb") as out, stderr_path.open("wb") as err:
            proc = await asyncio.create_subprocess_exec(
                "node",
                str(self._bundle_path()),
                env=child_env,
                stdout=out,
                stderr=err,
            )
            await proc.wait()
        self._ensure_answer_file()
        # Populate context now so a later timeout still leaves token/cost metrics,
        # and so a non-zero exit that still produced an answer is graded normally.
        self.populate_context_post_run(context)

        # A non-zero exit means the entrypoint threw (bad setup, a provider error,
        # an aborted turn) instead of finishing the task. If it still left an
        # answer, grade it; if it produced nothing, raise so Harbor records the
        # failure (retryable) rather than scoring an empty answer as a legitimate
        # 0. NonZeroAgentExitCodeError is the agent-error type Harbor's trial loop
        # catches, so the verifier still runs either way.
        if proc.returncode != 0:
            answer = (self.logs_dir / constants.ANSWER_FILE).read_text().strip()
            if not answer:
                raise NonZeroAgentExitCodeError(
                    f"cua entrypoint exited with code {proc.returncode} and produced "
                    f"no answer; see {stderr_path}"
                )
            self.logger.warning(
                f"cua entrypoint exited with code {proc.returncode} but produced an "
                f"answer; grading it. See {stderr_path}"
            )

    def _ensure_answer_file(self) -> None:
        answer_path = self.logs_dir / constants.ANSWER_FILE
        if answer_path.exists():
            return
        run_jsonl = self.logs_dir / constants.RUN_JSONL
        answer = ""
        if run_jsonl.exists():
            for line in run_jsonl.read_text().splitlines():
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                if rec.get("t") == "final":
                    answer = rec.get("answer", "")
        answer_path.write_text(answer)

    def populate_context_post_run(self, context: AgentContext) -> None:
        trajectory = build_trajectory(
            self.logs_dir / constants.RUN_JSONL,
            instruction=getattr(self, "_last_instruction", ""),
            model_name=self.model_name,
        )
        if trajectory is None:
            return

        (self.logs_dir / constants.TRAJECTORY_FILE).write_text(
            json.dumps(trajectory.to_json_dict(), indent=2, ensure_ascii=False)
        )

        if trajectory.final_metrics:
            metrics = trajectory.final_metrics
            context.cost_usd = metrics.total_cost_usd
            context.n_input_tokens = metrics.total_prompt_tokens or 0
            context.n_cache_tokens = metrics.total_cached_tokens or 0
            context.n_output_tokens = metrics.total_completion_tokens or 0
