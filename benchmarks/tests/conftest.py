import json
from pathlib import Path

import pytest


class FakeEnv:
    """Minimal stand-in for a started KernelEnvironment.

    Exposes only ``_persistent_env``, which is what CuaHarborAgent.run reads.
    """

    def __init__(self, session_id: str = "sess-123", api_key: str = "kapi-xyz"):
        self._persistent_env = {
            "KERNEL_SESSION_ID": session_id,
            "KERNEL_API_KEY": api_key,
        }


@pytest.fixture
def fake_env() -> FakeEnv:
    return FakeEnv()


@pytest.fixture
def run_jsonl_records() -> list[dict]:
    """A user + one assistant turn (a click tool call) + its tool result + final."""
    return [
        {"t": "user", "ts": 1_700_000_000_000, "text": "Go to example.com"},
        {
            "t": "assistant",
            "ts": 1_700_000_001_000,
            "model": "anthropic:claude-opus-4-8",
            "text": "clicking the link",
            "reasoning": "I should click",
            "tool_calls": [{"id": "call_1", "name": "click", "arguments": {"x": 1, "y": 2}}],
            "usage": {
                "input": 100,
                "output": 20,
                "cacheRead": 10,
                "cacheWrite": 0,
                "cost": {"total": 0.0123},
            },
        },
        {
            "t": "tool_result",
            "ts": 1_700_000_002_000,
            "call_id": "call_1",
            "is_error": False,
            "text": "clicked",
            "shots": ["shots/shot-1.png"],
        },
        {
            "t": "final",
            "ts": 1_700_000_003_000,
            "answer": "Example Domain",
            "session_id": "sess-123",
            "model": "anthropic:claude-opus-4-8",
            "agent_version": "0.3.5",
        },
    ]


def _write_jsonl(path: Path, records: list[dict]) -> Path:
    path.write_text("".join(f"{json.dumps(r)}\n" for r in records))
    return path


@pytest.fixture
def write_jsonl():
    return _write_jsonl
