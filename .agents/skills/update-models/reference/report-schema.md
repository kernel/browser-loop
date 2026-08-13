# Report Schema

Use this shape for JSON reports and the same fields when writing a Markdown summary.

## Top Level

```json
{
  "generated_at": "2026-04-26T00:00:00.000Z",
  "repo": "/path/to/cua",
  "providers": {
    "openai": {},
    "anthropic": {},
    "gemini": {},
    "meta": {},
    "xai": {},
    "moonshot": {}
  },
  "example_evidence": {},
  "drift": {},
  "recommendations": []
}
```

## Provider Result

```json
{
  "provider": "openai",
  "metadata_source": "models.list",
  "models": [
    {
      "id": "gpt-5.5",
      "display_name": "GPT-5.5",
      "created_at": "2026-04-01T00:00:00.000Z",
      "raw": {},
      "supports_generation": true,
      "model_docs": {
        "url": "https://developers.openai.com/api/docs/models/gpt-5.5",
        "streaming": "supported",
        "function_calling": "supported",
        "computer_use": "supported",
        "responses_endpoint": "supported"
      },
      "computer_use": {
        "status": "pass",
        "tool_name": "computer",
        "tool_version": null,
        "beta_header": null,
        "observed_actions": ["screenshot"],
        "response_item_types": ["computer_call"],
        "accepts_image_tool_results": "assumed-from-docs",
        "error": null
      },
      "cua": {
        "provider_inference": "openai",
        "pi_ai_registry": "missing",
        "dynamic_model_fallback": "available",
        "local_adapter_support": "passes-smoke"
      },
      "recommended_action": "candidate-default"
    }
  ]
}
```

## Drift Result

```json
{
  "provider": "anthropic",
  "documented_tool_versions": ["computer_20251124"],
  "example_tool_versions": ["computer_20251124"],
  "local_tool_versions": ["computer_20251124"],
  "documented_actions": ["screenshot", "left_click"],
  "example_repo_actions": ["screenshot", "left_click"],
  "observed_actions": ["screenshot"],
  "repo_supported_actions": ["screenshot", "left_click"],
  "unknown_observed_actions": [],
  "notes": []
}
```

## Markdown Summary

Use this order:

1. New or changed model candidates.
2. Computer-use smoke-test pass/fail/inconclusive table.
3. Official example repo findings.
4. Drift against local adapter constants.
5. CUA support changes needed:
   - default model update
   - `pi-ai` registry present or dynamic fallback needed
   - model-specific docs do not block required runtime features
   - provider routing update
   - adapter action/tool version update
   - docs/config examples update
6. Recommended repo changes and blockers.

Only recommend changing defaults when metadata discovery, official evidence, smoke tests, and CUA compatibility all line up.
