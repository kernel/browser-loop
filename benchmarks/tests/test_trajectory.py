from cua_harbor.trajectory import build_trajectory


def test_build_trajectory_validates_and_maps(tmp_path, run_jsonl_records, write_jsonl):
    path = write_jsonl(tmp_path / "run.jsonl", run_jsonl_records)
    traj = build_trajectory(path, instruction="Go to example.com", model_name="anthropic/claude-opus-4-8")

    assert traj is not None
    assert traj.session_id == "sess-123"
    assert traj.agent.name == "cua"
    assert traj.agent.version == "0.3.5"
    assert traj.agent.model_name == "anthropic:claude-opus-4-8"

    # user step then agent step, sequential ids.
    assert [s.step_id for s in traj.steps] == [1, 2]
    assert traj.steps[0].source == "user"
    assert traj.steps[0].message == "Go to example.com"

    agent_step = traj.steps[1]
    assert agent_step.source == "agent"
    assert agent_step.reasoning_content == "I should click"
    assert agent_step.model_name == "anthropic:claude-opus-4-8"
    assert [tc.tool_call_id for tc in agent_step.tool_calls] == ["call_1"]
    assert agent_step.llm_call_count == 1

    # tool result attaches to the same step; source_call_id matches the tool call.
    result = agent_step.observation.results[0]
    assert result.source_call_id == "call_1"
    image = next(p for p in result.content if p.type == "image")
    assert image.source.path == "shots/shot-1.png"
    assert image.source.media_type == "image/png"

    # per-step metrics: prompt_tokens includes cached.
    assert agent_step.metrics.prompt_tokens == 110
    assert agent_step.metrics.completion_tokens == 20
    assert agent_step.metrics.cached_tokens == 10
    assert agent_step.metrics.cost_usd == 0.0123

    fm = traj.final_metrics
    assert fm.total_prompt_tokens == 110
    assert fm.total_completion_tokens == 20
    assert fm.total_cached_tokens == 10
    assert fm.total_cost_usd == 0.0123
    assert fm.total_steps == 2


def test_build_trajectory_empty_run_floor(tmp_path, write_jsonl):
    path = write_jsonl(tmp_path / "run.jsonl", [])
    traj = build_trajectory(path, instruction="do the thing", model_name="openai/gpt-5.5")
    assert traj is not None
    assert len(traj.steps) == 1
    assert traj.steps[0].source == "user"
    assert traj.steps[0].message == "do the thing"


def test_build_trajectory_none_without_instruction(tmp_path, write_jsonl):
    path = write_jsonl(tmp_path / "run.jsonl", [])
    assert build_trajectory(path, instruction="", model_name=None) is None


def test_build_trajectory_missing_file_uses_floor(tmp_path):
    traj = build_trajectory(tmp_path / "absent.jsonl", instruction="hi", model_name="openai/gpt-5.5")
    assert traj is not None
    assert traj.steps[0].message == "hi"
