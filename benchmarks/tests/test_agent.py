import json
from pathlib import Path

import pytest

from cua_harbor.agent import CuaHarborAgent
from cua_harbor.models import to_cua_model_ref
from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.models.agent.context import AgentContext


class _FakeProc:
    returncode = 0

    async def wait(self) -> None:
        return None


def _make_agent(tmp_path: Path) -> CuaHarborAgent:
    return CuaHarborAgent(
        logs_dir=tmp_path,
        model_name="anthropic/claude-opus-4-8",
        extra_env={"ANTHROPIC_API_KEY": "sk-ant", "UNRELATED": "x"},
    )


@pytest.fixture
def patched_subprocess(monkeypatch, run_jsonl_records):
    """Replace create_subprocess_exec with a fake that writes the run.jsonl + answer."""
    captured: dict = {}

    async def fake_exec(program, *args, env=None, stdout=None, stderr=None):
        captured["program"] = program
        captured["args"] = args
        captured["env"] = env
        out_dir = Path(env["AGENT_OUT_DIR"])
        out_dir.joinpath("run.jsonl").write_text(
            "".join(f"{json.dumps(r)}\n" for r in run_jsonl_records)
        )
        out_dir.joinpath("answer.txt").write_text("Example Domain")
        out_dir.joinpath("shots").mkdir(exist_ok=True)
        out_dir.joinpath("shots", "shot-1.png").write_bytes(b"\x89PNG")
        return _FakeProc()

    monkeypatch.setattr("cua_harbor.agent.asyncio.create_subprocess_exec", fake_exec)
    monkeypatch.setattr(CuaHarborAgent, "_bundle_path", lambda self: Path("/fake/task.js"))
    return captured


async def test_run_plumbs_env_and_populates_context(tmp_path, fake_env, patched_subprocess):
    agent = _make_agent(tmp_path)
    context = AgentContext()

    await agent.run("Go to example.com", fake_env, context)

    child_env = patched_subprocess["env"]
    assert child_env["CUA_MODEL"] == to_cua_model_ref("anthropic/claude-opus-4-8")
    assert child_env["ANTHROPIC_API_KEY"] == "sk-ant"
    # Only the provider-key subset of extra_env is forwarded, not arbitrary keys.
    assert child_env.get("UNRELATED") != "x"
    assert child_env["KERNEL_SESSION_ID"] == "sess-123"
    assert child_env["KERNEL_API_KEY"] == "kapi-xyz"
    assert child_env["AGENT_OUT_DIR"] == str(tmp_path)
    assert child_env["AGENT_INSTRUCTION"] == "Go to example.com"

    assert (tmp_path / "answer.txt").read_text() == "Example Domain"

    traj = json.loads((tmp_path / "trajectory.json").read_text())
    assert traj["agent"]["name"] == "cua"
    assert [s["step_id"] for s in traj["steps"]] == [1, 2]

    assert context.cost_usd == 0.0123
    assert context.n_input_tokens == 110
    assert context.n_cache_tokens == 10
    assert context.n_output_tokens == 20


async def test_run_writes_answer_from_final_when_node_skips_it(
    tmp_path, fake_env, monkeypatch, run_jsonl_records
):
    async def fake_exec(program, *args, env=None, stdout=None, stderr=None):
        out_dir = Path(env["AGENT_OUT_DIR"])
        out_dir.joinpath("run.jsonl").write_text(
            "".join(f"{json.dumps(r)}\n" for r in run_jsonl_records)
        )
        return _FakeProc()

    monkeypatch.setattr("cua_harbor.agent.asyncio.create_subprocess_exec", fake_exec)
    monkeypatch.setattr(CuaHarborAgent, "_bundle_path", lambda self: Path("/fake/task.js"))

    agent = _make_agent(tmp_path)
    await agent.run("Go to example.com", fake_env, AgentContext())

    assert (tmp_path / "answer.txt").read_text() == "Example Domain"


async def test_run_raises_without_session(tmp_path, patched_subprocess):
    class EmptyEnv:
        _persistent_env: dict = {}

    agent = _make_agent(tmp_path)
    with pytest.raises(RuntimeError, match="Kernel session not started"):
        await agent.run("hi", EmptyEnv(), AgentContext())


class _FailProc:
    returncode = 1

    async def wait(self) -> None:
        return None


async def test_run_raises_on_nonzero_exit_without_answer(tmp_path, fake_env, monkeypatch):
    """A crash that leaves nothing to grade surfaces as a Harbor agent error."""

    async def fake_exec(program, *args, env=None, stdout=None, stderr=None):
        return _FailProc()  # no run.jsonl, no answer.txt

    monkeypatch.setattr("cua_harbor.agent.asyncio.create_subprocess_exec", fake_exec)
    monkeypatch.setattr(CuaHarborAgent, "_bundle_path", lambda self: Path("/fake/task.js"))

    agent = _make_agent(tmp_path)
    with pytest.raises(NonZeroAgentExitCodeError, match="produced no answer"):
        await agent.run("Go to example.com", fake_env, AgentContext())


async def test_run_grades_nonzero_exit_when_answer_present(
    tmp_path, fake_env, monkeypatch, run_jsonl_records
):
    """A non-zero exit that still produced an answer is graded, not raised."""

    async def fake_exec(program, *args, env=None, stdout=None, stderr=None):
        out_dir = Path(env["AGENT_OUT_DIR"])
        out_dir.joinpath("run.jsonl").write_text(
            "".join(f"{json.dumps(r)}\n" for r in run_jsonl_records)
        )
        out_dir.joinpath("answer.txt").write_text("Example Domain")
        return _FailProc()

    monkeypatch.setattr("cua_harbor.agent.asyncio.create_subprocess_exec", fake_exec)
    monkeypatch.setattr(CuaHarborAgent, "_bundle_path", lambda self: Path("/fake/task.js"))

    agent = _make_agent(tmp_path)
    await agent.run("Go to example.com", fake_env, AgentContext())
    assert (tmp_path / "answer.txt").read_text() == "Example Domain"
