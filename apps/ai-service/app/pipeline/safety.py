import json
import os
import re
from typing import Any

import httpx


SAFETY_CHECK_PROMPT = """
Review this integration configuration for:
1. Any hardcoded credentials, API keys, or secrets (should be vault:// references only)
2. Any PII values embedded in transformation rules
3. Any transformation expressions that could cause data leakage
4. Any field mappings that map sensitive fields to logging or non-secure targets

Configuration: {config_json}

Return JSON:
{{
  "safe": true | false,
  "violations": [
    {{ "type": "credential_exposure | pii_leak | unsafe_expression", "location": "...", "detail": "..." }}
  ],
  "warnings": ["non-critical concerns"],
  "recommendation": "approve | review | reject"
}}
"""


class SafetyViolationError(RuntimeError):
    def __init__(self, violations: list[dict[str, str]]) -> None:
        super().__init__("safety_check_failed")
        self.violations = violations


def _extract_json_content(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    return json.loads(text)


def _llm_safety_check(config_json: dict[str, Any]) -> dict[str, Any] | None:
    api_key = os.getenv("NVIDIA_MAIN_LLM_API_KEY") or os.getenv("NVIDIA_REQUIREMENTS_API_KEY") or os.getenv("NVIDIA_API_KEY", "")
    api_key = api_key.strip()
    if not api_key:
        return None

    endpoint = os.getenv("NVIDIA_CHAT_ENDPOINT", "https://integrate.api.nvidia.com/v1/chat/completions")
    model = os.getenv("NVIDIA_SAFETY_MODEL", "nvidia/llama-3.1-nemotron-safety-guard-8b-v3")
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": SAFETY_CHECK_PROMPT.format(config_json=json.dumps(config_json, ensure_ascii=False)),
            }
        ],
        "max_tokens": 500,
        "temperature": 0.0,
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
        parsed = _extract_json_content(content)
        return {
            "safe": bool(parsed.get("safe", False)),
            "violations": list(parsed.get("violations", [])),
            "warnings": list(parsed.get("warnings", [])),
            "recommendation": str(parsed.get("recommendation", "review")),
        }
    except Exception:
        return None


def _looks_like_secret(value: str) -> bool:
    if value.startswith("vault://"):
        return False
    secret_patterns = [
        r"(?i)api[_-]?key\s*[:=]\s*[A-Za-z0-9_\-]{12,}",
        r"(?i)(secret|token|password)\s*[:=]\s*[A-Za-z0-9_\-]{8,}",
        r"(?i)sk-[A-Za-z0-9_\-]{12,}",
        r"(?i)nvapi-[A-Za-z0-9_\-]{12,}",
    ]
    return any(re.search(pattern, value) for pattern in secret_patterns)


def _looks_like_pii(value: str) -> bool:
    pii_patterns = [
        r"\b\d{4}\s?\d{4}\s?\d{4}\b",  # Aadhaar-like
        r"\b[A-Z]{5}\d{4}[A-Z]\b",  # PAN-like
        r"\b\d{10}\b",  # phone-like
        r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",  # email
    ]
    return any(re.search(pattern, value) for pattern in pii_patterns)


def _scan_config(config_json: dict[str, Any]) -> dict[str, Any]:
    violations: list[dict[str, str]] = []
    warnings: list[str] = []

    field_mappings = config_json.get("field_mappings", [])
    if isinstance(field_mappings, list):
        for index, mapping in enumerate(field_mappings):
            if not isinstance(mapping, dict):
                continue
            expression = str(mapping.get("transformation_expression") or "")
            source_field = str(mapping.get("source_field") or "")
            target_field = str(mapping.get("target_field") or "")

            if expression and _looks_like_secret(expression):
                violations.append(
                    {
                        "type": "credential_exposure",
                        "location": f"field_mappings[{index}].transformation_expression",
                        "detail": "Hardcoded credential-like value found; use vault:// references.",
                    }
                )

            if expression and _looks_like_pii(expression):
                violations.append(
                    {
                        "type": "pii_leak",
                        "location": f"field_mappings[{index}].transformation_expression",
                        "detail": "PII-like value embedded in transformation expression.",
                    }
                )

            if re.search(r"(?i)(console\.log|logger|print\(|http|fetch\(|axios|webhook|external)", expression):
                violations.append(
                    {
                        "type": "unsafe_expression",
                        "location": f"field_mappings[{index}].transformation_expression",
                        "detail": "Expression contains logging/network behavior that can leak data.",
                    }
                )

            source_sensitive = re.search(r"(?i)(aadhaar|pan|phone|email|dob|ssn|account|card)", source_field)
            target_unsafe = re.search(r"(?i)(log|debug|trace|telemetry|public|stdout)", target_field)
            if source_sensitive and target_unsafe:
                violations.append(
                    {
                        "type": "unsafe_expression",
                        "location": f"field_mappings[{index}]",
                        "detail": "Sensitive source field appears mapped to a non-secure/logging target.",
                    }
                )

    serialized = json.dumps(config_json, ensure_ascii=False)
    if _looks_like_secret(serialized):
        violations.append(
            {
                "type": "credential_exposure",
                "location": "config_json",
                "detail": "Potential hardcoded credentials detected in configuration payload.",
            }
        )

    if not field_mappings:
        warnings.append("No field mappings were present during safety scan.")

    safe = len(violations) == 0
    recommendation = "approve" if safe else "reject"
    return {
        "safe": safe,
        "violations": violations,
        "warnings": warnings,
        "recommendation": recommendation,
    }


def safety_check_config(config_json: dict[str, Any]) -> dict[str, Any]:
    scanned = _scan_config(config_json)
    llm_result = _llm_safety_check(config_json)

    if llm_result:
        merged_violations = scanned["violations"] + [
            violation for violation in llm_result.get("violations", []) if violation not in scanned["violations"]
        ]
        merged_warnings = scanned["warnings"] + [
            warning for warning in llm_result.get("warnings", []) if warning not in scanned["warnings"]
        ]
        safe = bool(scanned["safe"]) and bool(llm_result.get("safe", False)) and not merged_violations
        recommendation = "approve" if safe else "reject"
        return {
            "safe": safe,
            "violations": merged_violations,
            "warnings": merged_warnings,
            "recommendation": recommendation,
        }

    return scanned
