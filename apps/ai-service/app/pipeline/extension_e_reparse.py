import copy
import difflib
import json
import os
import re
from typing import Any

from psycopg import connect
from psycopg.rows import dict_row

from app.pipeline.matcher import match_adapters


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


def sentence_tokenize(text: str) -> list[str]:
    chunks = re.split(r"(?<=[.!?])\s+|\n+", text)
    return [chunk.strip() for chunk in chunks if chunk.strip()]


def compute_sentence_diff(original_sentences: list[str], new_sentences: list[str]) -> dict[str, list[str]]:
    matcher = difflib.SequenceMatcher(a=original_sentences, b=new_sentences)
    added: list[str] = []
    removed: list[str] = []
    modified: list[str] = []
    unchanged: list[str] = []

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            unchanged.extend(new_sentences[j1:j2])
        elif tag == "insert":
            added.extend(new_sentences[j1:j2])
        elif tag == "delete":
            removed.extend(original_sentences[i1:i2])
        elif tag == "replace":
            removed.extend(original_sentences[i1:i2])
            modified.extend(new_sentences[j1:j2])

    return {
        "added": added,
        "removed": removed,
        "modified": modified,
        "unchanged": unchanged,
    }


def _infer_service_type(sentence: str) -> str:
    lowered = sentence.lower()
    if any(token in lowered for token in ["gst", "tax"]):
        return "gst"
    if any(token in lowered for token in ["kyc", "aadhaar", "pan"]):
        return "kyc"
    if any(token in lowered for token in ["fraud", "risk"]):
        return "fraud"
    if any(token in lowered for token in ["payment", "gateway"]):
        return "payment"
    if any(token in lowered for token in ["open banking", "account aggregator", "consent"]):
        return "open_banking"
    return "bureau"


def extract_requirements_from_text(changed_sentences: list[str]) -> list[dict[str, Any]]:
    requirements: list[dict[str, Any]] = []
    counter = 1
    for sentence in changed_sentences:
        requirements.append(
            {
                "requirement_id": f"reparse_{counter:03d}",
                "service_type": _infer_service_type(sentence),
                "provider_hint": None,
                "mandatory": any(token in sentence.lower() for token in ["must", "mandatory", "required", "shall"]),
                "confidence": 0.7,
                "source_sentence": sentence,
                "fields_needed": [],
                "conditions": [],
                "api_action": "verify",
                "notes": "Generated from BRD delta re-parse.",
            }
        )
        counter += 1
    return requirements


def _requirement_key(requirement: dict[str, Any]) -> str:
    return f"{requirement.get('service_type')}|{str(requirement.get('source_sentence') or '').lower()}"


def _matches_existing(requirement: dict[str, Any], existing: list[dict[str, Any]]) -> bool:
    key = _requirement_key(requirement)
    return any(_requirement_key(item) == key for item in existing)


def _sentence_removed(source_sentence: str, removed_sentences: list[str]) -> bool:
    source = source_sentence.strip().lower()
    return any(source == removed.strip().lower() for removed in removed_sentences)


def _analyze_impact(req_diff: dict[str, list[dict[str, Any]]], active_config: dict[str, Any]) -> dict[str, Any]:
    existing_nodes = active_config.get("dag", {}).get("nodes", []) if isinstance(active_config, dict) else []
    existing_mappings = active_config.get("field_mappings", []) if isinstance(active_config, dict) else []
    return {
        "new_requirements": len(req_diff["new"]),
        "modified_requirements": len(req_diff["modified"]),
        "removed_requirements": len(req_diff["removed"]),
        "existing_nodes": len(existing_nodes) if isinstance(existing_nodes, list) else 0,
        "existing_mappings": len(existing_mappings) if isinstance(existing_mappings, list) else 0,
    }


async def handle_brd_update(new_document_id: str, original_document_id: str, tenant_id: str) -> dict[str, Any]:
    with connect(_db_url(), row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT d.id, d.structured_content, dt.redacted_text
                FROM documents d
                LEFT JOIN document_texts dt ON dt.document_id = d.id
                WHERE d.id = %s AND d.tenant_id = %s
                LIMIT 1
                """,
                (original_document_id, tenant_id),
            )
            original = cur.fetchone()

            cur.execute(
                """
                SELECT d.id, d.structured_content, dt.redacted_text
                FROM documents d
                LEFT JOIN document_texts dt ON dt.document_id = d.id
                WHERE d.id = %s AND d.tenant_id = %s
                LIMIT 1
                """,
                (new_document_id, tenant_id),
            )
            new_doc = cur.fetchone()

        if not original or not new_doc:
            raise ValueError("document_not_found")

        original_text = str(original.get("redacted_text") or "")
        new_text = str(new_doc.get("redacted_text") or "")

        original_sentences = sentence_tokenize(original_text)
        new_sentences = sentence_tokenize(new_text)
        text_diff = compute_sentence_diff(original_sentences, new_sentences)

        if not text_diff["added"] and not text_diff["modified"] and not text_diff["removed"]:
            return {"status": "no_changes_detected"}

        changed_sentences = text_diff["added"] + text_diff["modified"]
        new_requirements = extract_requirements_from_text(changed_sentences)

        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT requirement_id, service_type, source_sentence, mandatory, confidence, api_action, notes
                FROM requirements
                WHERE document_id = %s
                  AND tenant_id = %s
                """,
                (original_document_id, tenant_id),
            )
            existing_requirements = list(cur.fetchall())

        req_diff = {
            "new": [requirement for requirement in new_requirements if not _matches_existing(requirement, existing_requirements)],
            "modified": [
                requirement
                for requirement in new_requirements
                if _matches_existing(requirement, existing_requirements)
                and any(str(requirement.get("source_sentence")) == str(existing.get("source_sentence")) for existing in existing_requirements)
            ],
            "removed": [
                existing
                for existing in existing_requirements
                if _sentence_removed(str(existing.get("source_sentence") or ""), text_diff["removed"])
            ],
            "unchanged": [
                existing
                for existing in existing_requirements
                if not _sentence_removed(str(existing.get("source_sentence") or ""), text_diff["removed"])
            ],
        }

        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT tc.id AS tenant_config_id, tcv.id AS version_id, tcv.version_number, tcv.config_json
                FROM tenant_configs tc
                JOIN tenant_config_versions tcv ON tcv.id = tc.current_version_id
                WHERE tc.tenant_id = %s
                ORDER BY tc.created_at DESC
                LIMIT 1
                """,
                (tenant_id,),
            )
            active = cur.fetchone()

        if not active:
            raise ValueError("active_config_not_found")

        active_config = active.get("config_json") if isinstance(active.get("config_json"), dict) else {}
        impact = _analyze_impact(req_diff, active_config)

        new_config = copy.deepcopy(active_config)
        if not isinstance(new_config, dict):
            new_config = {}
        if "dag" not in new_config or not isinstance(new_config.get("dag"), dict):
            new_config["dag"] = {"nodes": [], "edges": []}
        if "nodes" not in new_config["dag"] or not isinstance(new_config["dag"].get("nodes"), list):
            new_config["dag"]["nodes"] = []
        if "field_mappings" not in new_config or not isinstance(new_config.get("field_mappings"), list):
            new_config["field_mappings"] = []

        for new_req in req_diff["new"]:
            matches = match_adapters(conn, new_req)
            best = matches[0] if matches else {}
            new_config["dag"]["nodes"].append(
                {
                    "id": f"node_reparse_{new_req['requirement_id']}",
                    "adapter_version_id": best.get("selected_version_id"),
                    "node_type": new_req.get("api_action"),
                    "condition": new_req.get("conditions", []),
                    "retry_policy": {"max_attempts": 3, "backoff": "exponential"},
                    "timeout_ms": 5000,
                    "source_requirement": new_req["requirement_id"],
                }
            )
            new_config["field_mappings"].append(
                {
                    "source_field": "document_context",
                    "target_field": f"{new_req['service_type']}_input",
                    "transformation_rule": "direct",
                    "confidence": 0.65,
                    "requires_human_review": True,
                    "review_reason": "Generated from BRD delta and requires approval",
                    "source_sentence": new_req["source_sentence"],
                }
            )

        for modified_req in req_diff["modified"]:
            new_config["field_mappings"].append(
                {
                    "source_field": "document_context",
                    "target_field": f"{modified_req['service_type']}_input_updated",
                    "transformation_rule": "conditional",
                    "confidence": 0.6,
                    "requires_human_review": True,
                    "review_reason": "Modified requirement mapping regenerated",
                    "source_sentence": modified_req["source_sentence"],
                }
            )

        if req_diff["removed"]:
            metadata = new_config.get("metadata") if isinstance(new_config.get("metadata"), dict) else {}
            metadata["deprecated_requirements"] = [
                {
                    "requirement_id": removed.get("requirement_id"),
                    "source_sentence": removed.get("source_sentence"),
                }
                for removed in req_diff["removed"]
            ]
            new_config["metadata"] = metadata

        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COALESCE(MAX(version_number), 0) AS max_version
                FROM tenant_config_versions
                WHERE tenant_config_id = %s
                """,
                (active["tenant_config_id"],),
            )
            next_version = int(cur.fetchone()["max_version"]) + 1

            cur.execute(
                """
                INSERT INTO tenant_config_versions
                  (tenant_config_id, tenant_id, version_number, config_json, created_by, status, source_document_id, generator_model, match_results)
                VALUES (%s, %s, %s, %s::jsonb, 'ai-reparse', 'draft', %s, 'brd-reparse', '[]'::jsonb)
                RETURNING id
                """,
                (
                    active["tenant_config_id"],
                    tenant_id,
                    next_version,
                    json.dumps(new_config),
                    new_document_id,
                ),
            )
            new_version = cur.fetchone()["id"]

            cur.execute(
                """
                INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, before, after, actor)
                VALUES (%s, 'tenant_config', %s, 'brd_reparse_update', NULL, %s::jsonb, 'ai-service')
                """,
                (
                    tenant_id,
                    new_version,
                    json.dumps(
                        {
                            "text_diff_summary": {
                                "sentences_added": len(text_diff["added"]),
                                "sentences_modified": len(text_diff["modified"]),
                                "sentences_removed": len(text_diff["removed"]),
                            },
                            "requirement_diff": {
                                "new": len(req_diff["new"]),
                                "modified": len(req_diff["modified"]),
                                "removed": len(req_diff["removed"]),
                                "unchanged": len(req_diff["unchanged"]),
                            },
                        }
                    ),
                ),
            )

        conn.commit()

        return {
            "status": "changes_detected",
            "text_diff_summary": {
                "sentences_added": len(text_diff["added"]),
                "sentences_modified": len(text_diff["modified"]),
                "sentences_removed": len(text_diff["removed"]),
            },
            "requirement_diff": req_diff,
            "config_impact": impact,
            "new_config_version_id": str(new_version),
            "unchanged_sections": len(req_diff["unchanged"]),
        }
