import json
import os
from typing import Any

import httpx


MOCK_RESPONSE_PROMPT = """
Generate a realistic mock API response for scenario: {scenario}
Schema: {schema_json}
Return only valid JSON matching the schema.
For failure scenarios, return appropriate error structure.
"""


def _extract_json_content(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    return json.loads(text)


def _fallback_response(adapter_schema: dict[str, Any], scenario: str) -> dict[str, Any]:
    fields = []
    request_schema = adapter_schema.get("response_schema", {}) if isinstance(adapter_schema, dict) else {}
    if isinstance(request_schema, dict):
        maybe_fields = request_schema.get("fields", [])
        if isinstance(maybe_fields, list):
            fields = [str(field) for field in maybe_fields]

    if scenario == "timeout":
        return {"error": "timeout", "retryable": True, "message": "Upstream adapter timed out."}
    if scenario == "partial_failure":
        return {"status": "partial_failure", "processed": max(len(fields) - 1, 0), "errors": ["One field could not be resolved"]}
    if scenario == "schema_mismatch":
        return {"status": "schema_mismatch", "error": "Adapter payload did not match expected schema"}

    output = {"status": "success"}
    for field in fields:
        low = field.lower()
        if "score" in low:
            output[field] = 742
        elif "id" in low:
            output[field] = "MOCK-" + field.upper()[:8]
        elif "amount" in low:
            output[field] = 125000
        elif "date" in low:
            output[field] = "2026-04-02"
        elif "name" in low:
            output[field] = "Riya Sharma"
        elif "status" in low:
            output[field] = "verified"
        else:
            output[field] = f"mock_{field}"
    return output


def generate_mock_response(adapter_schema: dict[str, Any], scenario: str) -> dict[str, Any]:
    api_key = os.getenv("NVIDIA_MAIN_LLM_API_KEY") or os.getenv("NVIDIA_REQUIREMENTS_API_KEY") or os.getenv("NVIDIA_API_KEY", "")
    api_key = api_key.strip()

    if not api_key:
        return _fallback_response(adapter_schema, scenario)

    endpoint = os.getenv("NVIDIA_CHAT_ENDPOINT", "https://integrate.api.nvidia.com/v1/chat/completions")
    model = os.getenv("NVIDIA_MOCK_MODEL", "mistralai/mistral-small-3.1-24b-instruct-2503")
    prompt = MOCK_RESPONSE_PROMPT.format(scenario=scenario, schema_json=json.dumps(adapter_schema, ensure_ascii=False))

    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.7,
        "max_tokens": 800,
    }

    try:
        with httpx.Client(timeout=60.0) as client:
            response = client.post(
                endpoint,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
            )
            response.raise_for_status()
            data = response.json()

        content = data["choices"][0]["message"]["content"]
        return _extract_json_content(content)
    except Exception:
        return _fallback_response(adapter_schema, scenario)
