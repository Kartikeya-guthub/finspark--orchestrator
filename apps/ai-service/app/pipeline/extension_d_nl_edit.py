import copy
import json
import os
import re
from typing import Any

import httpx
from pydantic import BaseModel, Field, ValidationError
from psycopg import connect
from psycopg.rows import dict_row

from app.pipeline.safety import safety_check_config

NL_EDIT_PROMPT = """
You are an enterprise integration configuration editor.
Apply this natural language instruction to the existing configuration.

Current Configuration:
{current_config}

Instruction: {instruction}

Return ONLY valid JSON describing the change:
{
  "change_type": "update_field | add_node | remove_node | update_retry | update_timeout | add_condition",
  "target": "exact path in config e.g. dag.nodes[0].retry_policy",
  "old_value": "what it was",
  "new_value": "what it should be",
  "explanation": "human readable explanation of what changed and why",
  "confidence": 0.95,
  "requires_review": false
}
"""


class NLChange(BaseModel):
    change_type: str
    target: str
    old_value: Any = None
    new_value: Any = None
    explanation: str
    confidence: float = Field(ge=0.0, le=1.0)
    requires_review: bool = False


def _db_url() -> str:
    database_url = os.getenv("DATABASE_URL")
    if database_url:
        return database_url
    user = os.getenv("POSTGRES_USER", "finspark")
    password = os.getenv("POSTGRES_PASSWORD", "finspark")
    host = os.getenv("POSTGRES_HOST", "127.0.0.1")
    port = os.getenv("POSTGRES_PORT", "5432")
    database = os.getenv("POSTGRES_DB", "finspark")
    return f"postgresql://{user}:{password}@{host}:{port}/{database}"


def _extract_json(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    return json.loads(text)


def _tokenize_path(path: str) -> list[str | int]:
    path = path.strip()
    parts: list[str | int] = []
    for segment in path.split("."):
        if not segment:
            continue
        matched = re.match(r"^([a-zA-Z_][a-zA-Z0-9_]*)", segment)
        if matched:
            parts.append(matched.group(1))
            rest = segment[len(matched.group(1)):]
        else:
            rest = segment
        for index_match in re.finditer(r"\[(\d+)\]", rest):
            parts.append(int(index_match.group(1)))
    return parts


def _read_path(config: Any, path: str) -> Any:
    cursor = config
    for token in _tokenize_path(path):
        if isinstance(token, int):
            if not isinstance(cursor, list) or token >= len(cursor):
                return None
            cursor = cursor[token]
            continue
        if not isinstance(cursor, dict) or token not in cursor:
            return None
        cursor = cursor[token]
    return cursor


def _write_path(config: Any, path: str, value: Any) -> None:
    tokens = _tokenize_path(path)
    if not tokens:
        return
    cursor = config
    for token in tokens[:-1]:
        if isinstance(token, int):
            if not isinstance(cursor, list):
                raise ValueError("invalid_path")
            while len(cursor) <= token:
                cursor.append({})
            cursor = cursor[token]
            continue
        if not isinstance(cursor, dict):
            raise ValueError("invalid_path")
        if token not in cursor or cursor[token] is None:
            cursor[token] = {}
        cursor = cursor[token]

    final_token = tokens[-1]
    if isinstance(final_token, int):
        if not isinstance(cursor, list):
            raise ValueError("invalid_path")
        while len(cursor) <= final_token:
            cursor.append(None)
        cursor[final_token] = value
    else:
        if not isinstance(cursor, dict):
            raise ValueError("invalid_path")
        cursor[final_token] = value


def _compute_diff(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    before_keys = set(before.keys())
    after_keys = set(after.keys())
    changed = [key for key in sorted(before_keys & after_keys) if before.get(key) != after.get(key)]
    return {
        "added_keys": sorted(after_keys - before_keys),
        "removed_keys": sorted(before_keys - after_keys),
        "changed_keys": changed,
    }


def _fallback_change(instruction: str, current_config: dict[str, Any]) -> NLChange:
    lowered = instruction.lower()
    if "retry" in lowered:
        return NLChange(
            change_type="update_retry",
            target="dag.nodes[0].retry_policy",
            old_value=_read_path(current_config, "dag.nodes[0].retry_policy"),
            new_value={"max_attempts": 3, "backoff": "exponential"},
            explanation="Fallback parser inferred retry policy update.",
            confidence=0.62,
            requires_review=True,
        )
    if "timeout" in lowered:
        return NLChange(
            change_type="update_timeout",
            target="dag.nodes[0].timeout_ms",
            old_value=_read_path(current_config, "dag.nodes[0].timeout_ms"),
            new_value=5000,
            explanation="Fallback parser inferred timeout update.",
            confidence=0.6,
            requires_review=True,
        )

    return NLChange(
        change_type="update_field",
        target="metadata.last_nl_instruction",
        old_value=_read_path(current_config, "metadata.last_nl_instruction"),
        new_value=instruction,
        explanation="Stored instruction in metadata as fallback action.",
        confidence=0.5,
        requires_review=True,
    )


def _call_nl_edit_llm(current_config: dict[str, Any], instruction: str) -> NLChange:
    api_key = os.getenv("NVIDIA_MAIN_LLM_API_KEY") or os.getenv("NVIDIA_REQUIREMENTS_API_KEY") or os.getenv("NVIDIA_API_KEY", "")
    api_key = api_key.strip()
    if not api_key:
        raise RuntimeError("missing_nvidia_api_key")

    endpoint = os.getenv("NVIDIA_CHAT_ENDPOINT", "https://integrate.api.nvidia.com/v1/chat/completions")
    model = os.getenv("NVIDIA_MAIN_LLM_MODEL", "mistralai/mistral-small-3.1-24b-instruct-2503")

    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": NL_EDIT_PROMPT.format(
                    current_config=json.dumps(current_config, indent=2),
                    instruction=instruction,
                ),
            }
        ],
        "temperature": 0.1,
        "max_tokens": 700,
    }

    with httpx.Client(timeout=90.0) as client:
        response = client.post(
            endpoint,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()

    parsed = _extract_json(data["choices"][0]["message"]["content"])
    return NLChange.model_validate(parsed)


async def apply_nl_instruction(config_version_id: str, instruction: str, actor: str) -> dict[str, Any]:
    with connect(_db_url(), row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, tenant_config_id, tenant_id, version_number, config_json
                FROM tenant_config_versions
                WHERE id = %s
                LIMIT 1
                """,
                (config_version_id,),
            )
            current = cur.fetchone()

        if not current:
            raise ValueError("config_version_not_found")

        current_config = current.get("config_json") if isinstance(current.get("config_json"), dict) else {}

        change: NLChange
        try:
            change = _call_nl_edit_llm(current_config, instruction)
        except (RuntimeError, httpx.HTTPError, json.JSONDecodeError, ValidationError, KeyError):
            change = _fallback_change(instruction, current_config)

        new_config = copy.deepcopy(current_config)
        if change.old_value is None:
            change.old_value = _read_path(new_config, change.target)
        _write_path(new_config, change.target, change.new_value)

        diff = _compute_diff(current_config, new_config)
        safety = safety_check_config(new_config)

        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COALESCE(MAX(version_number), 0) AS max_version
                FROM tenant_config_versions
                WHERE tenant_config_id = %s
                """,
                (current["tenant_config_id"],),
            )
            next_version = int(cur.fetchone()["max_version"]) + 1

            cur.execute(
                """
                INSERT INTO tenant_config_versions
                  (tenant_config_id, tenant_id, version_number, config_json, created_by, status, generator_model, match_results)
                VALUES (%s, %s, %s, %s::jsonb, %s, %s, %s, '[]'::jsonb)
                RETURNING id
                """,
                (
                    current["tenant_config_id"],
                    current["tenant_id"],
                    next_version,
                    json.dumps(new_config),
                    actor,
                    "draft" if safety.get("safe", False) else "blocked",
                    "natural_language_edit",
                ),
            )
            new_version_id = cur.fetchone()["id"]

            cur.execute(
                """
                INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, before, after, actor)
                VALUES (%s, 'tenant_config', %s, 'natural_language_edit', %s::jsonb, %s::jsonb, %s)
                """,
                (
                    current["tenant_id"],
                    new_version_id,
                    json.dumps({"instruction": instruction}),
                    json.dumps(
                        {
                            "change_applied": change.model_dump(),
                            "diff": diff,
                            "safety": safety,
                            "source_version_id": config_version_id,
                        }
                    ),
                    actor,
                ),
            )

        conn.commit()

        return {
            "new_version_id": str(new_version_id),
            "change": change.model_dump(),
            "diff": diff,
            "safety": safety,
        }
