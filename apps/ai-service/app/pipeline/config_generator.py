import hashlib
import json
import os
import re
import uuid
from typing import Any

import httpx
from pydantic import BaseModel, Field, ValidationError
from psycopg import Connection


class FieldMappingItem(BaseModel):
    source_field: str
    target_field: str
    transformation_rule: str
    transformation_expression: str | None = None
    confidence: float = Field(ge=0.0, le=1.0)
    requires_human_review: bool
    review_reason: str


class MappingResponse(BaseModel):
    field_mappings: list[FieldMappingItem]
    unmapped_required_fields: list[str]
    mapping_notes: str


MAPPING_PROMPT = """
You are an enterprise integration engineer.
Given a requirement and the target adapter's request schema, generate field mappings.

Requirement: __REQUIREMENT_JSON__
Adapter Schema: __ADAPTER_SCHEMA__
Tenant's known fields: __TENANT_FIELD_INVENTORY__

Return ONLY valid JSON:
{
  "field_mappings": [
    {
      "source_field": "field name in tenant system",
      "target_field": "field name in adapter API",
      "transformation_rule": "direct | concat | format | compute | conditional",
      "transformation_expression": "expression if not direct",
      "confidence": 0.0,
      "requires_human_review": true,
      "review_reason": "why human should verify this"
    }
  ],
  "unmapped_required_fields": ["adapter fields with no tenant source"],
  "mapping_notes": "any caveats"
}
"""


def _local_field_hash(value: str) -> int:
    return int(hashlib.sha256(value.encode("utf-8")).hexdigest(), 16)


def _collect_strings(value: Any, bucket: set[str]) -> None:
    if isinstance(value, str):
        tokens = re.findall(r"[A-Za-z0-9_]+", value)
        for token in tokens:
            if len(token) > 2:
                bucket.add(token.lower())
        return
    if isinstance(value, list):
        for item in value:
            _collect_strings(item, bucket)
        return
    if isinstance(value, dict):
        for item in value.values():
            _collect_strings(item, bucket)


def _json_safe(value: Any) -> Any:
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [_json_safe(item) for item in value]
    return value


def get_tenant_field_inventory(
    conn: Connection[Any],
    tenant_id: str,
    structured_content: dict[str, Any] | None = None,
) -> list[str]:
    inventory: set[str] = set()

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT config_json
            FROM tenant_config_versions
            WHERE tenant_id = %s
            ORDER BY version_number DESC
            LIMIT 3
            """,
            (tenant_id,),
        )
        for row in cur.fetchall():
            _collect_strings(row["config_json"], inventory)

        cur.execute(
            """
            SELECT structured_content
            FROM documents
            WHERE tenant_id = %s
            ORDER BY created_at DESC
            LIMIT 3
            """,
            (tenant_id,),
        )
        for row in cur.fetchall():
            _collect_strings(row["structured_content"], inventory)

    if structured_content:
        _collect_strings(structured_content, inventory)

    return sorted(inventory)


def _parse_json(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    return json.loads(text)


def _call_mapping_llm(
    requirement: dict[str, Any],
    adapter_schema: dict[str, Any],
    tenant_field_inventory: list[str],
) -> MappingResponse:
    api_key = os.getenv("NVIDIA_MAIN_LLM_API_KEY") or os.getenv("NVIDIA_REQUIREMENTS_API_KEY") or os.getenv("NVIDIA_API_KEY", "")
    api_key = api_key.strip()
    if not api_key:
        raise RuntimeError("NVIDIA_API_KEY is required for mapping generation")

    endpoint = os.getenv("NVIDIA_CHAT_ENDPOINT", "https://integrate.api.nvidia.com/v1/chat/completions")
    model = os.getenv("NVIDIA_MAIN_LLM_MODEL", "mistralai/mistral-small-3.1-24b-instruct-2503")

    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": MAPPING_PROMPT.replace("__REQUIREMENT_JSON__", json.dumps(requirement, ensure_ascii=False))
                .replace("__ADAPTER_SCHEMA__", json.dumps(adapter_schema, ensure_ascii=False))
                .replace("__TENANT_FIELD_INVENTORY__", json.dumps(tenant_field_inventory, ensure_ascii=False)),
            }
        ],
        "temperature": 0.1,
        "max_tokens": 1500,
    }

    with httpx.Client(timeout=90.0) as client:
        response = client.post(
            endpoint,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()

    content = data["choices"][0]["message"]["content"]
    parsed = _parse_json(content)
    return MappingResponse.model_validate(parsed)


def _deterministic_mappings(
    requirement: dict[str, Any],
    adapter_schema: dict[str, Any],
    tenant_field_inventory: list[str],
) -> MappingResponse:
    adapter_fields = []
    request_schema = adapter_schema.get("request_schema", {})
    if isinstance(request_schema, dict):
        fields = request_schema.get("fields", [])
        if isinstance(fields, list):
            adapter_fields = [str(field) for field in fields]

    requirement_sentence = str(requirement.get("source_sentence", ""))
    required_words = set(re.findall(r"[A-Za-z0-9_]+", requirement_sentence.lower()))
    available_fields = tenant_field_inventory or list(required_words) or ["document_text"]

    mappings: list[FieldMappingItem] = []
    unmapped: list[str] = []

    for target_field in adapter_fields:
        candidates = [field for field in available_fields if target_field.lower() in field.lower() or field.lower() in target_field.lower()]
        source_field = candidates[0] if candidates else available_fields[0]
        exact = source_field.lower() == target_field.lower()
        transformation_rule = "direct" if exact else "conditional"
        transformation_expression = None if exact else f"map {source_field} to {target_field}"
        confidence = 0.97 if exact else 0.68
        requires_review = confidence < 0.85
        review_reason = "Direct field name alignment" if exact else "Human verification needed for inferred mapping"
        mappings.append(
            FieldMappingItem(
                source_field=source_field,
                target_field=target_field,
                transformation_rule=transformation_rule,
                transformation_expression=transformation_expression,
                confidence=confidence,
                requires_human_review=requires_review,
                review_reason=review_reason,
            )
        )
        if not exact and target_field not in available_fields:
            unmapped.append(target_field)

    return MappingResponse(
        field_mappings=mappings,
        unmapped_required_fields=unmapped,
        mapping_notes="Deterministic fallback mapping used because the LLM response was unavailable.",
    )


def _build_edges_from_conditions(requirements: list[dict[str, Any]], node_ids_by_requirement_id: dict[str, str]) -> list[dict[str, Any]]:
    edges: list[dict[str, Any]] = []
    for requirement in requirements:
        requirement_id = str(requirement.get("requirement_id"))
        current_node_id = node_ids_by_requirement_id.get(requirement_id)
        if not current_node_id:
            continue
        for condition in requirement.get("conditions", []) or []:
            depends_on = condition.get("depends_on")
            if not depends_on:
                continue
            from_node_id = node_ids_by_requirement_id.get(str(depends_on))
            if not from_node_id:
                continue
            if from_node_id == current_node_id:
                continue
            condition_type = str(condition.get("condition_type", "prerequisite"))
            edge_type = "parallel" if condition_type == "parallel" else "success"
            edges.append(
                {
                    "id": str(uuid.uuid4()),
                    "from_node_id": from_node_id,
                    "to_node_id": current_node_id,
                    "condition_type": condition_type,
                    "edge_type": edge_type,
                }
            )
    return edges


def generate_config(
    conn: Connection[Any],
    requirements: list[dict[str, Any]],
    matched_adapters: list[list[dict[str, Any]]],
    tenant_id: str,
    document_id: str,
    structured_content: dict[str, Any] | None = None,
) -> dict[str, Any]:
    tenant_field_inventory = get_tenant_field_inventory(conn, tenant_id, structured_content)

    field_mappings: list[dict[str, Any]] = []
    dag_nodes: list[dict[str, Any]] = []
    match_results: list[dict[str, Any]] = []
    node_ids_by_requirement_id: dict[str, str] = {}

    for requirement, adapter_candidates in zip(requirements, matched_adapters):
        selected_adapter = adapter_candidates[0] if adapter_candidates else {}
        adapter_schema = selected_adapter.get("schema_def") or {}
        if isinstance(adapter_schema, str):
            try:
                adapter_schema = json.loads(adapter_schema)
            except json.JSONDecodeError:
                adapter_schema = {}

        try:
            mapping_response = _call_mapping_llm(requirement, adapter_schema, tenant_field_inventory)
        except Exception:
            mapping_response = _deterministic_mappings(requirement, adapter_schema, tenant_field_inventory)

        field_mappings.extend([mapping.model_dump() for mapping in mapping_response.field_mappings])
        match_results.append(
            {
                "requirement_id": requirement.get("requirement_id"),
                "source_sentence": requirement.get("source_sentence"),
                "selected_adapter_id": selected_adapter.get("id"),
                "selected_version_id": selected_adapter.get("selected_version_id"),
                "match_confidence": selected_adapter.get("match_confidence"),
                "match_method": selected_adapter.get("match_method"),
                "match_explanation": selected_adapter.get("match_explanation"),
                "top_candidates": _json_safe(adapter_candidates[:3]),
                "mapping_notes": mapping_response.mapping_notes,
                "unmapped_required_fields": mapping_response.unmapped_required_fields,
            }
        )

        node_id = str(uuid.uuid4())
        node_ids_by_requirement_id[str(requirement.get("requirement_id"))] = node_id
        dag_nodes.append(
            {
                "id": node_id,
                "tenant_config_id": None,
                "tenant_id": tenant_id,
                "adapter_version_id": selected_adapter.get("selected_version_id"),
                "node_type": requirement.get("api_action"),
                "condition": requirement.get("conditions"),
                "retry_policy": {"max_attempts": 3, "backoff": "exponential"},
                "timeout_ms": 5000,
            }
        )

    dag_edges = _build_edges_from_conditions(requirements, node_ids_by_requirement_id)

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id
            FROM tenant_configs
            WHERE tenant_id = %s
              AND name = 'default'
            LIMIT 1
            """,
            (tenant_id,),
        )
        tenant_config_row = cur.fetchone()
        if tenant_config_row:
            tenant_config_id = tenant_config_row["id"]
        else:
            cur.execute(
                """
                INSERT INTO tenant_configs (tenant_id, name)
                VALUES (%s, 'default')
                RETURNING id
                """,
                (tenant_id,),
            )
            tenant_config_id = cur.fetchone()["id"]

        cur.execute(
            """
            SELECT COALESCE(MAX(version_number), 0) AS max_version
            FROM tenant_config_versions
            WHERE tenant_config_id = %s
            """,
            (tenant_config_id,),
        )
        next_version = int(cur.fetchone()["max_version"]) + 1

        config_version_id = str(uuid.uuid4())
        safe_match_results = _json_safe(match_results)
        config_json = _json_safe({
            "field_mappings": field_mappings,
            "dag": {"nodes": dag_nodes, "edges": dag_edges},
            "match_results": safe_match_results,
        })

        cur.execute(
            """
            INSERT INTO tenant_config_versions
              (id, tenant_config_id, tenant_id, version_number, config_json, created_by, status, source_document_id, generator_model, match_results)
            VALUES
              (%s, %s, %s, %s, %s::jsonb, 'ai', 'draft', %s, %s, %s::jsonb)
            """,
            (
                config_version_id,
                tenant_config_id,
                tenant_id,
                next_version,
                json.dumps(config_json),
                document_id,
                os.getenv("NVIDIA_MAIN_LLM_MODEL", "mistralai/mistral-small-3.1-24b-instruct-2503"),
                json.dumps(safe_match_results),
            ),
        )

        for mapping in field_mappings:
            cur.execute(
                """
                INSERT INTO field_mappings
                  (tenant_config_id, tenant_id, source_field, target_field, transformation_rule)
                VALUES
                  (%s, %s, %s, %s, %s)
                """,
                (
                    tenant_config_id,
                    tenant_id,
                    mapping.get("source_field"),
                    mapping.get("target_field"),
                    mapping.get("transformation_rule"),
                ),
            )

        for node in dag_nodes:
            cur.execute(
                """
                INSERT INTO dag_nodes
                  (id, tenant_config_id, tenant_id, adapter_version_id, node_type, condition, retry_policy, timeout_ms)
                VALUES
                  (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s)
                """,
                (
                    node["id"],
                    tenant_config_id,
                    tenant_id,
                    node.get("adapter_version_id"),
                    node.get("node_type"),
                    json.dumps(node.get("condition")),
                    json.dumps(node.get("retry_policy", {})),
                    node.get("timeout_ms", 5000),
                ),
            )

        for edge in dag_edges:
            cur.execute(
                """
                INSERT INTO dag_edges
                  (id, from_node_id, to_node_id, condition_type, edge_type)
                VALUES
                  (%s, %s, %s, %s, %s)
                """,
                (
                    edge["id"],
                    edge["from_node_id"],
                    edge["to_node_id"],
                    edge["condition_type"],
                    edge["edge_type"],
                ),
            )

        cur.execute(
            """
            UPDATE tenant_configs
            SET current_version_id = %s
            WHERE id = %s
            """,
            (config_version_id, tenant_config_id),
        )

    return {
        "tenant_config_id": tenant_config_id,
        "version_id": config_version_id,
        "version_number": next_version,
        "config_json": config_json,
        "match_results": safe_match_results,
    }
