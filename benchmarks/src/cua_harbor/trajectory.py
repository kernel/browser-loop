"""Map the Node entrypoint's ``run.jsonl`` to a Harbor ATIF ``Trajectory``.

The record schema is the cross-repo contract written by ``node/src/sink.ts`` and
read here. One assistant turn becomes one ``source="agent"`` step; the tool
results answering that turn's tool calls attach to the same step's observation.
Modeled on ``harbor.agents.installed.claude_code._convert_events_to_trajectory``.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from harbor.models.trajectories.agent import Agent
from harbor.models.trajectories.content import ContentPart, ImageSource
from harbor.models.trajectories.final_metrics import FinalMetrics
from harbor.models.trajectories.metrics import Metrics
from harbor.models.trajectories.observation import Observation
from harbor.models.trajectories.observation_result import ObservationResult
from harbor.models.trajectories.step import Step
from harbor.models.trajectories.tool_call import ToolCall
from harbor.models.trajectories.trajectory import Trajectory

from cua_harbor.models import to_cua_model_ref

_EXT_MEDIA_TYPE = {
    "png": "image/png",
    "webp": "image/webp",
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "gif": "image/gif",
}


def _iso(ts: Any) -> str | None:
    """Unix-ms (cua) -> ISO 8601 (ATIF validator). Pass ISO strings through."""
    if ts is None:
        return None
    if isinstance(ts, str):
        return ts
    return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat()


def _media_type(rel_path: str) -> str:
    return _EXT_MEDIA_TYPE.get(rel_path.rsplit(".", 1)[-1].lower(), "image/png")


def _metrics_from_usage(usage: dict[str, Any]) -> Metrics:
    cost = usage.get("cost") or {}
    cache_read = usage.get("cacheRead", 0)
    return Metrics(
        prompt_tokens=usage.get("input", 0) + cache_read + usage.get("cacheWrite", 0),
        completion_tokens=usage.get("output", 0),
        cached_tokens=cache_read,
        cost_usd=cost.get("total"),
    )


def _read_records(run_jsonl_path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line in run_jsonl_path.read_text().splitlines():
        line = line.strip()
        if line:
            records.append(json.loads(line))
    return records


def build_trajectory(
    run_jsonl_path: Path,
    *,
    instruction: str,
    model_name: str | None,
) -> Trajectory | None:
    """Build a validated ATIF ``Trajectory`` from ``run.jsonl``.

    Returns ``None`` only when there is nothing to record (no records and no
    instruction). Otherwise a 1-step user floor is synthesized so the trajectory
    still validates and the failure is recorded.
    """
    records = _read_records(run_jsonl_path) if run_jsonl_path.exists() else []

    steps: list[Step] = []
    pending_calls: dict[str, Step] = {}  # tool_call_id -> the agent step it belongs to
    final: dict[str, Any] | None = None
    total_prompt = total_completion = total_cached = 0
    total_cost = 0.0
    saw_cost = False

    def next_id() -> int:
        return len(steps) + 1

    for rec in records:
        kind = rec.get("t")
        if kind == "user":
            steps.append(
                Step(
                    step_id=next_id(),
                    source="user",
                    message=rec.get("text", ""),
                    timestamp=_iso(rec.get("ts")),
                )
            )
        elif kind == "assistant":
            tool_calls = [
                ToolCall(
                    tool_call_id=tc["id"],
                    function_name=tc.get("name", ""),
                    arguments=tc.get("arguments") or {},
                )
                for tc in rec.get("tool_calls") or []
            ]
            usage = rec.get("usage") or {}
            metrics = _metrics_from_usage(usage)
            step = Step(
                step_id=next_id(),
                source="agent",
                message=rec.get("text", ""),
                reasoning_content=rec.get("reasoning"),
                model_name=rec.get("model"),
                tool_calls=tool_calls or None,
                metrics=metrics,
                llm_call_count=1,
                timestamp=_iso(rec.get("ts")),
            )
            steps.append(step)
            for tc in tool_calls:
                pending_calls[tc.tool_call_id] = step
            total_prompt += metrics.prompt_tokens or 0
            total_completion += metrics.completion_tokens or 0
            total_cached += metrics.cached_tokens or 0
            if metrics.cost_usd is not None:
                total_cost += metrics.cost_usd
                saw_cost = True
        elif kind == "tool_result":
            step = pending_calls.get(rec.get("call_id"))
            if step is None:
                continue  # result for an unknown call id; nothing to attach to
            content: list[ContentPart] = []
            if rec.get("text"):
                content.append(ContentPart(type="text", text=rec["text"]))
            for rel in rec.get("shots") or []:
                content.append(
                    ContentPart(
                        type="image",
                        source=ImageSource(media_type=_media_type(rel), path=rel),
                    )
                )
            result = ObservationResult(
                source_call_id=rec.get("call_id"),
                content=content or None,
            )
            if step.observation is None:
                step.observation = Observation(results=[result])
            else:
                step.observation.results.append(result)
        elif kind == "final":
            final = rec

    if not steps:
        if not instruction:
            return None
        steps.append(Step(step_id=1, source="user", message=instruction))

    final = final or {}
    agent_model = final.get("model")
    if not agent_model and model_name and "/" in model_name:
        agent_model = to_cua_model_ref(model_name)
    return Trajectory(
        session_id=final.get("session_id"),
        agent=Agent(
            name="cua",
            version=final.get("agent_version", "unknown"),
            model_name=agent_model,
        ),
        steps=steps,
        final_metrics=FinalMetrics(
            total_prompt_tokens=total_prompt,
            total_completion_tokens=total_completion,
            total_cached_tokens=total_cached,
            total_cost_usd=total_cost if saw_cost else None,
            total_steps=len(steps),
        ),
    )
