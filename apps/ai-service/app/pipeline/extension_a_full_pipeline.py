import json
import os
from typing import Any

from psycopg import connect
from psycopg.rows import dict_row

from app.pipeline.config_generator import generate_config
from app.pipeline.extractor import RequirementExtraction, extract_requirements
from app.pipeline.matcher import match_adapters
from app.pipeline.safety import safety_check_config


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


def _is_stub_fallback(extraction: RequirementExtraction) -> bool:
    if extraction.extraction_confidence <= 0.35:
        return True
    for requirement in extraction.requirements:
        notes = str(requirement.notes or "").lower()
        if "fallback stub extraction" in notes:
            return True
    return False


async def full_extraction_pipeline(document_id: str, tenant_id: str) -> dict[str, Any]:
    """
    Complete pipeline:
    ocdrnet -> gliner-pii (x2) -> mistral-small extraction
    -> nemoretriever embed -> rerank-qa match
    -> mistral-small mapping -> nemotron-safety guard
    """
    with connect(_db_url(), row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT d.id, d.tenant_id, d.parse_status, d.structured_content, dt.redacted_text
                FROM documents d
                LEFT JOIN document_texts dt ON dt.document_id = d.id
                WHERE d.id = %s AND d.tenant_id = %s
                LIMIT 1
                """,
                (document_id, tenant_id),
            )
            document = cur.fetchone()

        if not document:
            raise ValueError("document_not_found")

        parse_status = str(document.get("parse_status") or "")
        if parse_status != "structure_extracted":
            raise ValueError("document_not_ready_structure_extracted_required")

        structured_content = document.get("structured_content")
        if not isinstance(structured_content, dict):
            structured_content = {
                "raw_text": str(document.get("redacted_text") or ""),
                "sections": [],
                "tables": [],
                "headers": [],
            }

        extraction = extract_requirements(
            conn=conn,
            structured_content=structured_content,
            document_id=document_id,
            tenant_id=tenant_id,
        )

        requirements = [requirement.model_dump() for requirement in extraction.requirements]
        matched_adapters: list[list[dict[str, Any]]] = []

        for requirement in requirements:
            matches = match_adapters(conn, requirement)
            matched_adapters.append(matches)

            best_match = matches[0] if matches else {}
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE requirements
                    SET status = %s,
                        notes = COALESCE(notes, '') || %s
                    WHERE document_id = %s
                      AND tenant_id = %s
                      AND requirement_id = %s
                    """,
                    (
                        "matched" if best_match else "unmatched",
                        json.dumps(
                            {
                                "matched_adapter_version_id": best_match.get("selected_version_id"),
                                "match_confidence": best_match.get("match_confidence"),
                                "match_explanation": best_match.get("match_explanation"),
                            }
                        ),
                        document_id,
                        tenant_id,
                        str(requirement.get("requirement_id") or ""),
                    ),
                )

        config_version = generate_config(
            conn=conn,
            requirements=requirements,
            matched_adapters=matched_adapters,
            tenant_id=tenant_id,
            document_id=document_id,
            structured_content=structured_content,
        )

        safety_result = safety_check_config(config_version["config_json"])
        with conn.cursor() as cur:
            if safety_result.get("safe", False):
                cur.execute(
                    """
                    UPDATE tenant_config_versions
                    SET status = 'pending_review'
                    WHERE id = %s
                    """,
                    (config_version["version_id"],),
                )
                cur.execute(
                    """
                    UPDATE documents
                    SET parse_status = 'config_generated'
                    WHERE id = %s AND tenant_id = %s
                    """,
                    (document_id, tenant_id),
                )
            else:
                cur.execute(
                    """
                    UPDATE tenant_config_versions
                    SET status = 'blocked'
                    WHERE id = %s
                    """,
                    (config_version["version_id"],),
                )
                cur.execute(
                    """
                    UPDATE documents
                    SET parse_status = 'config_blocked'
                    WHERE id = %s AND tenant_id = %s
                    """,
                    (document_id, tenant_id),
                )

            cur.execute(
                """
                INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, before, after, actor)
                VALUES (%s, 'tenant_config', %s, 'full_pipeline_executed', NULL, %s::jsonb, 'ai-service')
                """,
                (
                    tenant_id,
                    config_version["version_id"],
                    json.dumps(
                        {
                            "requirements_count": len(requirements),
                            "extraction_confidence": extraction.extraction_confidence,
                            "used_stub_fallback": _is_stub_fallback(extraction),
                            "safety": safety_result,
                        }
                    ),
                ),
            )

        conn.commit()

        return {
            "requirements": requirements,
            "matched_adapters": matched_adapters,
            "extraction_confidence": extraction.extraction_confidence,
            "config_version": {
                "id": config_version["version_id"],
                "version_number": config_version["version_number"],
                "config_json": config_version["config_json"],
            },
            "safety": safety_result,
            "used_stub_fallback": _is_stub_fallback(extraction),
        }
