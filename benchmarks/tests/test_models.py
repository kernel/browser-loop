import pytest

from cua_harbor.models import PROVIDER_KEY_ENV, provider_key_env, to_cua_model_ref


def test_to_cua_model_ref_replaces_first_slash():
    assert to_cua_model_ref("anthropic/claude-opus-4-8") == "anthropic:claude-opus-4-8"


def test_to_cua_model_ref_only_first_slash():
    assert to_cua_model_ref("openai/gpt-5/mini") == "openai:gpt-5/mini"


def test_to_cua_model_ref_requires_provider():
    with pytest.raises(ValueError):
        to_cua_model_ref("claude-opus-4-8")


def test_provider_key_env_picks_anthropic_key():
    extra = {"ANTHROPIC_API_KEY": "sk-ant", "OPENAI_API_KEY": "sk-oai", "OTHER": "x"}
    assert provider_key_env("anthropic/claude-opus-4-8", extra) == {"ANTHROPIC_API_KEY": "sk-ant"}


def test_provider_key_env_prefers_all_recognized_present():
    extra = {"ANTHROPIC_OAUTH_TOKEN": "tok", "ANTHROPIC_API_KEY": "sk-ant"}
    got = provider_key_env("anthropic/claude-opus-4-8", extra)
    assert got == {"ANTHROPIC_OAUTH_TOKEN": "tok", "ANTHROPIC_API_KEY": "sk-ant"}


def test_provider_key_env_aliases_gemini_to_google_envs():
    extra = {"GOOGLE_API_KEY": "g", "GEMINI_API_KEY": "ge"}
    assert provider_key_env("gemini/gemini-3-flash", extra) == extra


def test_provider_key_env_empty_when_unknown_provider():
    assert provider_key_env("mystery/model", {"ANTHROPIC_API_KEY": "x"}) == {}


def test_provider_key_env_table_covers_known_providers():
    assert set(PROVIDER_KEY_ENV) == {"anthropic", "openai", "google", "gemini", "tzafon", "yutori"}
