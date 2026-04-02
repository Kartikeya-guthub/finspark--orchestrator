import json
import os
from typing import Any
from pathlib import Path

from fastapi import FastAPI, HTTPException
from minio import Minio
from dotenv import load_dotenv
from psycopg import connect
from psycopg.rows import dict_row

from app.pipeline.config_generator import generate_config
from app.pipeline.extractor import extract_requirements
from app.pipeline.ocr import extract_plain_text, extract_structure
from app.pipeline.matcher import match_adapters
from app.pipeline.pii import redact_structured, redact_text_regex

ROOT_ENV = Path(__file__).resolve().parents[3] / ".env"
load_dotenv(ROOT_ENV)

app = FastAPI(title="finspark-ai-service", version="0.1.0")

def db_url() -> str:
    database_url = os.getenv("DATABASE_URL")
    if database_url:
        return database_url
    user = os.getenv("POSTGRES_USER", "finspark")
    password = os.getenv("POSTGRES_PASSWORD", "finspark")
    host = os.getenv("POSTGRES_HOST", "127.0.0.1")
    port = os.getenv("POSTGRES_PORT", "5432")
    database = os.getenv("POSTGRES_DB", "finspark")
    return f"postgresql://{user}:{password}@{host}:{port}/{database}"


def minio_client() -> Minio:
    endpoint = os.getenv("MINIO_ENDPOINT", "127.0.0.1")
    port = os.getenv("MINIO_API_PORT", "9000")
    use_ssl = os.getenv("MINIO_USE_SSL", "false").lower() == "true"
    return Minio(
        endpoint=f"{endpoint}:{port}",
        access_key=os.getenv("MINIO_ROOT_USER", "minioadmin"),
        secret_key=os.getenv("MINIO_ROOT_PASSWORD", "minioadmin"),
        secure=use_ssl,
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/process-document")
def process_document(payload: dict[str, Any]) -> dict[str, Any]:
    document_id = payload.get("documentId")
    tenant_id = payload.get("tenantId")
    object_path = payload.get("objectPath")
    filename = payload.get("filename")

    if not all([document_id, tenant_id, object_path, filename]):
        raise HTTPException(status_code=400, detail="documentId, tenantId, objectPath, filename required")

    bucket = os.getenv("MINIO_BUCKET_DOCS", "finspark-documents")
    client = minio_client()

    try:
        response = client.get_object(bucket, object_path)
        file_bytes = response.read()
        response.close()
        response.release_conn()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"failed_to_fetch_object: {exc}") from exc

    content_type = payload.get("contentType") or "application/octet-stream"

    try:
        original_text = extract_plain_text(filename, file_bytes)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"text_extraction_failed: {exc}") from exc

    redacted_text, pii_entities = redact_text_regex(original_text)
    structured = extract_structure(filename, file_bytes, str(content_type))
    structured_redacted, structured_pii_entities, chunk_count = redact_structured(structured)

    with connect(db_url(), row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO document_texts (document_id, tenant_id, original_text, redacted_text, pii_entities)
                VALUES (%s, %s, %s, %s, %s::jsonb)
                ON CONFLICT (document_id)
                DO UPDATE SET
                  original_text = EXCLUDED.original_text,
                  redacted_text = EXCLUDED.redacted_text,
                  pii_entities = EXCLUDED.pii_entities,
                  updated_at = now()
                """,
                (document_id, tenant_id, original_text, redacted_text, json.dumps(pii_entities)),
            )

            cur.execute(
                """
                UPDATE documents
                SET parse_status = 'processing_requirements',
                    structured_content = %s::jsonb
                WHERE id = %s AND tenant_id = %s
                """,
                (json.dumps(structured_redacted), document_id, tenant_id),
            )

            cur.execute(
                """
                INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, before, after, actor)
                VALUES (%s, 'document', %s, 'pii_redaction', NULL, %s::jsonb, 'ai-service')
                """,
                (
                    tenant_id,
                    document_id,
                    json.dumps({"entities_found": pii_entities}),
                ),
            )

            cur.execute(
                """
                INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, before, after, actor)
                VALUES (%s, 'document', %s, 'structure_extraction', NULL, %s::jsonb, 'ai-service')
                """,
                (
                    tenant_id,
                    document_id,
                    json.dumps(
                        {
                            "source": structured.get("source", "unknown"),
                            "sections": len(structured_redacted.get("sections", []))
                            if isinstance(structured_redacted, dict)
                            else 0,
                            "tables": len(structured_redacted.get("tables", []))
                            if isinstance(structured_redacted, dict)
                            else 0,
                            "headers": len(structured_redacted.get("headers", []))
                            if isinstance(structured_redacted, dict)
                            else 0,
                            "entities_found": [],
                        }
                    ),
                ),
            )

            cur.execute(
                """
                INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, before, after, actor)
                VALUES (%s, 'document', %s, 'pii_redaction_structured', NULL, %s::jsonb, 'ai-service')
                """,
                (
                    tenant_id,
                    document_id,
                    json.dumps(
                        {
                            "entities_summary": structured_pii_entities,
                            "chunk_count": chunk_count,
                        }
                    ),
                ),
            )

        extraction = extract_requirements(
            conn=conn,
            structured_content=structured_redacted,
            document_id=document_id,
            tenant_id=tenant_id,
        )

        matched_adapters = [match_adapters(conn, requirement.model_dump()) for requirement in extraction.requirements]
        config_result = None
        if extraction.requirements:
            config_result = generate_config(
                conn=conn,
                requirements=[requirement.model_dump() for requirement in extraction.requirements],
                matched_adapters=matched_adapters,
                tenant_id=tenant_id,
                document_id=document_id,
                structured_content=structured_redacted,
            )

        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE documents
                SET parse_status = %s
                WHERE id = %s AND tenant_id = %s
                """,
                (
                    'config_generated' if config_result else 'requirements_extracted',
                    document_id,
                    tenant_id,
                ),
            )

            cur.execute(
                """
                INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, before, after, actor)
                VALUES (%s, 'document', %s, 'requirement_extraction', NULL, %s::jsonb, 'ai-service')
                """,
                (
                    tenant_id,
                    document_id,
                    json.dumps(
                        {
                            "requirements_count": len(extraction.requirements),
                            "extraction_confidence": extraction.extraction_confidence,
                            "ambiguous_requirements": extraction.ambiguous_requirements,
                            "missing_information": extraction.missing_information,
                        }
                    ),
                ),
            )

            if config_result:
                cur.execute(
                    """
                    INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, before, after, actor)
                    VALUES (%s, 'tenant_config', %s, 'config_generation', NULL, %s::jsonb, 'ai-service')
                    """,
                    (
                        tenant_id,
                        config_result["version_id"],
                        json.dumps(
                            {
                                "tenant_config_id": str(config_result["tenant_config_id"]),
                                "version_number": config_result["version_number"],
                                "requirements_count": len(extraction.requirements),
                                "match_results": config_result["match_results"],
                            },
                            default=str,
                        ),
                    ),
                )

        conn.commit()

    return {
        "status": "ok",
        "document_id": document_id,
        "tenant_id": tenant_id,
        "entities_found": pii_entities,
        "structured_entities_found": structured_pii_entities,
        "structure_source": structured.get("source", "unknown"),
        "requirements_count": len(extraction.requirements),
        "extraction_confidence": extraction.extraction_confidence,
        "config_version_id": None if config_result is None else config_result["version_id"],
        "config_version_number": None if config_result is None else config_result["version_number"],
    }
