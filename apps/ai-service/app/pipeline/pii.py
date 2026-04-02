import json
import os
import re
from typing import Any

import httpx
from httpx import HTTPStatusError

PII_PATTERNS: list[tuple[str, re.Pattern[str], str]] = [
    ("aadhaar", re.compile(r"\b\d{4}[- ]?\d{4}[- ]?\d{4}\b"), "[PII_REDACTED_AADHAAR]"),
    (
        "pan",
        re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b", re.IGNORECASE),
        "[PII_REDACTED_PAN]",
    ),
    (
        "phone",
        re.compile(r"\b(?:\+91[- ]?)?[6-9]\d{9}\b"),
        "[PII_REDACTED_PHONE]",
    ),
    (
        "email",
        re.compile(r"\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}\b"),
        "[PII_REDACTED_EMAIL]",
    ),
    (
        "account_number",
        re.compile(r"\b\d{9,18}\b"),
        "[PII_REDACTED_ACCOUNT]",
    ),
    (
        "name",
        re.compile(r"\b(?:customer|applicant)\s+name\s*:\s*[A-Za-z ]{3,}\b", re.IGNORECASE),
        "[PII_REDACTED_NAME]",
    ),
]


def redact_text_regex(text: str) -> tuple[str, list[dict[str, Any]]]:
    redacted = text
    entities: list[dict[str, Any]] = []
    for pii_type, pattern, replacement in PII_PATTERNS:
        matches = list(pattern.finditer(redacted))
        if not matches:
            continue
        redacted = pattern.sub(replacement, redacted)
        entities.append({"type": pii_type, "count": len(matches)})
    return redacted, entities


def flatten_to_chunks(structured_content: Any) -> tuple[list[str], list[list[str]]]:
    chunks: list[str] = []
    paths: list[list[str]] = []

    def walk(node: Any, path: list[str]) -> None:
        if isinstance(node, str):
            chunks.append(node)
            paths.append(path)
            return
        if isinstance(node, list):
            for idx, item in enumerate(node):
                walk(item, path + [str(idx)])
            return
        if isinstance(node, dict):
            for key, value in node.items():
                walk(value, path + [key])

    walk(structured_content, [])
    return chunks, paths


def _set_path(root: Any, path: list[str], value: Any) -> None:
    cursor = root
    for i, token in enumerate(path):
        is_last = i == len(path) - 1
        if token.isdigit():
            idx = int(token)
            if is_last:
                cursor[idx] = value
            else:
                cursor = cursor[idx]
        else:
            if is_last:
                cursor[token] = value
            else:
                cursor = cursor[token]


def rebuild_structure(structured_content: Any, redacted_chunks: list[dict[str, Any]], paths: list[list[str]]) -> Any:
    rebuilt = json.loads(json.dumps(structured_content))
    for idx, entry in enumerate(redacted_chunks):
        _set_path(rebuilt, paths[idx], entry["redacted"])
    return rebuilt


def summarize_entity_types(redacted_chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summary: dict[str, int] = {}
    for entry in redacted_chunks:
        for entity in entry.get("entities_found", []):
            entity_type = str(entity.get("type", "unknown"))
            count = int(entity.get("count", 0))
            summary[entity_type] = summary.get(entity_type, 0) + count
    return [{"type": k, "count": v} for k, v in summary.items()]


def _call_gliner_pii(chunk: str) -> tuple[str, list[dict[str, Any]]]:
    api_key = os.getenv("NVIDIA_GLINER_API_KEY") or os.getenv("NVIDIA_API_KEY", "")
    api_key = api_key.strip()
    if not api_key:
        raise RuntimeError("NVIDIA_API_KEY is required for structured PII redaction")

    endpoint = os.getenv("NVIDIA_CHAT_ENDPOINT", "https://integrate.api.nvidia.com/v1/chat/completions")
    payload = {
        "model": os.getenv("NVIDIA_GLINER_MODEL", "nvidia/gliner-pii"),
        "messages": [
            {
                "role": "system",
                "content": "Return valid JSON only with keys redacted_text and entities where entities is [{type,count}].",
            },
            {"role": "user", "content": chunk},
        ],
        "temperature": 0.0,
    }

    with httpx.Client(timeout=60.0) as client:
        try:
            response = client.post(
                endpoint,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
            )
            response.raise_for_status()
            data = response.json()
        except (HTTPStatusError, httpx.RequestError, ValueError, KeyError):
            return redact_text_regex(chunk)

    content = data["choices"][0]["message"]["content"]
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return redact_text_regex(chunk)
    redacted_text = str(parsed.get("redacted_text", chunk))

    entities_raw = parsed.get("entities", [])
    entities: list[dict[str, Any]] = []
    if isinstance(entities_raw, list):
        counts: dict[str, int] = {}
        for item in entities_raw:
            if isinstance(item, dict):
                item_type = str(item.get("type", "unknown"))
                item_count = int(item.get("count", 1))
            else:
                item_type = str(item)
                item_count = 1
            counts[item_type] = counts.get(item_type, 0) + item_count
        entities = [{"type": k, "count": v} for k, v in counts.items()]

    return redacted_text, entities


def redact_structured(structured_content: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], int]:
    chunks, paths = flatten_to_chunks(structured_content)
    redacted_chunks: list[dict[str, Any]] = []

    for chunk in chunks:
        redacted_text, entities = _call_gliner_pii(chunk)
        redacted_chunks.append(
            {
                "original": "[RESTRICTED]",
                "redacted": redacted_text,
                "entities_found": entities,
            }
        )

    redacted_structure = rebuild_structure(structured_content, redacted_chunks, paths)
    summary = summarize_entity_types(redacted_chunks)
    return redacted_structure, summary, len(chunks)
