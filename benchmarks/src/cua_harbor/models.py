"""Model-ref translation and provider-key selection (pure, no harbor/cua imports)."""


def to_cua_model_ref(model_name: str) -> str:
    """Translate Harbor's ``provider/name`` to cua's ``provider:name``.

    Harbor splits ``model_name`` on the first ``/`` (BaseAgent._init_model_info);
    cua's CuaModelRef is ``provider:name``.
    """
    if "/" not in model_name:
        raise ValueError(f"model must be 'provider/name', got {model_name!r}")
    return model_name.replace("/", ":", 1)


# Provider -> the env-var names cua reads for that provider's key, in the
# precedence order cua uses (@onkernel/cua-ai api-keys).
PROVIDER_KEY_ENV: dict[str, tuple[str, ...]] = {
    "anthropic": ("ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"),
    "openai": ("OPENAI_API_KEY",),
    "google": ("GOOGLE_API_KEY", "GEMINI_API_KEY"),
    "gemini": ("GOOGLE_API_KEY", "GEMINI_API_KEY"),  # cua aliases gemini -> google
    "tzafon": ("TZAFON_API_KEY",),
    "yutori": ("YUTORI_API_KEY",),
}


def provider_key_env(model_name: str, extra_env: dict[str, str]) -> dict[str, str]:
    """Subset of ``extra_env`` carrying the provider key for this model.

    Forwards every recognized var that is present. cua's
    ``requireCuaEnvApiKeyForModel`` fails fast in-process if none is set, so no
    presence check is done here.
    """
    provider = model_name.split("/", 1)[0]
    names = PROVIDER_KEY_ENV.get(provider, ())
    return {name: extra_env[name] for name in names if name in extra_env}
