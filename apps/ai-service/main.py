from __future__ import annotations

import argparse
import io
import json
import os
import re
from dataclasses import dataclass
from typing import Any

import pdfplumber
import psycopg2
import requests
from docx import Document as DocxDocument
from fastapi import FastAPI, HTTPException
from minio import Minio
from psycopg2.extras import RealDictCursor, Json
from openai import OpenAI

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://finspark:finspark@localhost:5432/finspark")
MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "localhost")
MINIO_PORT = int(os.getenv("MINIO_API_PORT", "9000"))
MINIO_ACCESS_KEY = os.getenv("MINIO_ROOT_USER", "minioadmin")
MINIO_SECRET_KEY = os.getenv("MINIO_ROOT_PASSWORD", "minioadmin")
MINIO_BUCKET = os.getenv("MINIO_BUCKET_DOCS", "documents")
GLINER_API_KEY = os.getenv("GLINER_API_KEY", os.getenv("NVIDIA_API_KEY", "")).strip()
GLINER_BASE_URL = os.getenv("GLINER_BASE_URL", os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"))
GLINER_MODEL = os.getenv("GLINER_MODEL", os.getenv("NVIDIA_GLINER_MODEL", "nvidia/gliner-pii"))
EXTRACTION_API_KEY = os.getenv("EXTRACTION_API_KEY", GLINER_API_KEY or os.getenv("NVIDIA_API_KEY", "")).strip()
EXTRACTION_BASE_URL = os.getenv("EXTRACTION_BASE_URL", GLINER_BASE_URL)
EXTRACTION_MODEL = os.getenv("EXTRACTION_MODEL", "mistralai/mistral-small-3.1-24b-instruct-2503")
EMBEDDING_API_KEY = os.getenv("EMBEDDING_API_KEY", EXTRACTION_API_KEY or GLINER_API_KEY).strip()
EMBEDDING_ENDPOINT = os.getenv("EMBEDDING_ENDPOINT", os.getenv("NVIDIA_EMBEDDINGS_ENDPOINT", "https://integrate.api.nvidia.com/v1/embeddings"))
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", os.getenv("NVIDIA_EMBEDDINGS_MODEL", "nvidia/llama-3.2-nv-embedqa-1b-v2"))
STRICT_API_ONLY = os.getenv("STRICT_API_ONLY", "true").strip().lower() not in {"0", "false", "no"}

EXTRACTION_PROMPT = """You are an Enterprise Integration Analyst.
Analyze the provided redacted document text and extract integration requirements.

Return ONLY valid JSON with this shape:
{
    "requirements": [
        {
            "service_type": "KYC|BUREAU|FRAUD|PAYMENT|ACCOUNT|OTHER",
            "mandatory": true,
            "confidence": 0.0,
            "source_sentence": "original sentence from the document",
            "api_action": "short action name",
            "conditions": {}
        }
    ]
}

Rules:
- Extract each distinct integration requirement as one item.
- Use a boolean for mandatory.
- Use a float between 0 and 1 for confidence.
- source_sentence must be copied from the document.
- If the document says a service must happen after another service, add a condition like {"depends_on": "req_kyc_id"}.
- Prefer concise service_type values.
- Do not add markdown, code fences, or commentary.
"""

MAPPING_PROMPT = """You are an Enterprise Integration Mapping Engine.
You receive one requirement, candidate bank fields, and one matched adapter request schema.

Return ONLY valid JSON with this shape:
{
    "field_mappings": [
        {
            "source_field": "bank_field_name",
            "target_field": "adapter_field_name",
            "confidence": 0.0
        }
    ]
}

Rules:
- source_field must come from bank fields.
- target_field must come from adapter request schema keys.
- confidence must be a float in range [0, 1].
- Prefer semantically correct mappings over string similarity.
- Do not add markdown, code fences, or commentary.
"""


@dataclass(frozen=True)
class RequirementItem:
    requirement_id: str
    service_type: str
    mandatory: bool
    confidence: float
    source_sentence: str
    api_action: str
    conditions: dict[str, Any]


@dataclass(frozen=True)
class FieldMappingItem:
    source_field: str
    target_field: str
    confidence: float

redaction_client = OpenAI(
    api_key=GLINER_API_KEY or None,
    base_url=GLINER_BASE_URL,
)

app = FastAPI(title="finspark-ai-service")
minio_client = Minio(
    f"{MINIO_ENDPOINT}:{MINIO_PORT}",
    access_key=MINIO_ACCESS_KEY,
    secret_key=MINIO_SECRET_KEY,
    secure=False,
)


def get_connection():
    return psycopg2.connect(DATABASE_URL)


def ensure_document_columns() -> None:
    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute("ALTER TABLE documents ADD COLUMN IF NOT EXISTS raw_text TEXT")
            cursor.execute("ALTER TABLE documents ADD COLUMN IF NOT EXISTS redacted_content JSONB")
            cursor.execute("ALTER TABLE requirements ADD COLUMN IF NOT EXISTS matched_adapter_version_id UUID")
            cursor.execute("ALTER TABLE requirements ADD COLUMN IF NOT EXISTS match_explanation TEXT")
            cursor.execute("ALTER TABLE adapter_versions ALTER COLUMN embedding TYPE vector(2048)")
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS audit_events (
                  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                  entity_type TEXT NOT NULL,
                  entity_id TEXT NOT NULL,
                  action TEXT NOT NULL,
                  actor TEXT NOT NULL,
                  data JSONB NOT NULL DEFAULT '{}'::jsonb,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
        connection.commit()


def write_audit_event(
    connection: Any,
    tenant_id: str,
    entity_type: str,
    entity_id: str,
    action: str,
    actor: str,
    data: dict[str, Any],
) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, actor, data)
            VALUES (%s, %s, %s, %s, %s, %s::jsonb)
            """,
            (tenant_id, entity_type, entity_id, action, actor, json.dumps(data or {})),
        )


def ensure_bucket() -> None:
    if not minio_client.bucket_exists(MINIO_BUCKET):
        minio_client.make_bucket(MINIO_BUCKET)


def extract_text(filename: str, payload: bytes) -> str:
    lower_name = filename.lower()
    if lower_name.endswith(".pdf"):
        extracted: list[str] = []
        with pdfplumber.open(io.BytesIO(payload)) as pdf:
            for page in pdf.pages:
                extracted.append(page.extract_text() or "")
        return "\n".join(chunk for chunk in extracted if chunk)
    if lower_name.endswith(".docx"):
        doc = DocxDocument(io.BytesIO(payload))
        return "\n".join(paragraph.text for paragraph in doc.paragraphs if paragraph.text)
    return payload.decode("utf-8", errors="ignore")


def fallback_redact(text: str) -> tuple[str, list[dict[str, Any]]]:
    redacted = re.sub(r"\b(?:\d{4}[- ]?){2}\d{4}\b", "[PII_REDACTED]", text)
    redacted = re.sub(r"\b[A-Z]{5}\d{4}[A-Z]\b", "[PII_REDACTED]", redacted, flags=re.IGNORECASE)
    entities: list[dict[str, Any]] = []
    if redacted != text:
        entities.append({"type": "fallback_regex", "count": 1})
    return redacted, entities


def nvidia_redact(text: str) -> tuple[str, list[dict[str, Any]]]:
    if not GLINER_API_KEY:
        if STRICT_API_ONLY:
            raise ValueError("gliner_api_key_missing")
        return fallback_redact(text)

    try:
        response = redaction_client.chat.completions.create(
            model=GLINER_MODEL,
            messages=[
                {
                    "role": "user",
                    "content": (
                        "Redact personal identifiers from the following text. "
                        "Return JSON with keys redacted_text and entities. Text: " + text
                    ),
                }
            ],
            temperature=0.0,
            max_tokens=1200,
        )

        content = response.choices[0].message.content or "{}"
        parsed = json.loads(content)
        redacted_text = str(parsed.get("redacted_text", text))
        entities_raw = parsed.get("entities", [])
        entities = entities_raw if isinstance(entities_raw, list) else []

        if not redacted_text.strip() or redacted_text.strip() == text.strip():
            return fallback_redact(text)

        return redacted_text, entities
    except Exception as error:
        return fallback_redact(text)


def golden_flow_requirements() -> list[RequirementItem]:
    return [
        RequirementItem(
            requirement_id="req_kyc_id",
            service_type="KYC",
            mandatory=True,
            confidence=1.0,
            source_sentence="Golden flow requires KYC verification first.",
            api_action="kyc_verification",
            conditions={},
        ),
        RequirementItem(
            requirement_id="req_bureau_id",
            service_type="BUREAU",
            mandatory=True,
            confidence=1.0,
            source_sentence="Golden flow requires bureau check after KYC.",
            api_action="bureau_check",
            conditions={"depends_on": "req_kyc_id"},
        ),
        RequirementItem(
            requirement_id="req_fraud_id",
            service_type="FRAUD",
            mandatory=True,
            confidence=1.0,
            source_sentence="Golden flow requires fraud screening after bureau.",
            api_action="fraud_screening",
            conditions={"depends_on": "req_bureau_id"},
        ),
        RequirementItem(
            requirement_id="req_payment_id",
            service_type="PAYMENT",
            mandatory=True,
            confidence=1.0,
            source_sentence="Golden flow requires payment setup after fraud screening.",
            api_action="payment_setup",
            conditions={"depends_on": "req_fraud_id"},
        ),
    ]


def normalize_requirement_item(raw_item: dict[str, Any], fallback_requirement_id: str) -> RequirementItem:
    conditions = raw_item.get("conditions", {})
    if not isinstance(conditions, dict):
        conditions = {}

    source_sentence = str(raw_item.get("source_sentence") or "")
    service_type_raw = str(raw_item.get("service_type") or "OTHER")

    normalized_service_type = normalize_service_type(service_type_raw, source_sentence)
    normalized_api_action = normalize_api_action(
        str(raw_item.get("api_action") or raw_item.get("service_type") or "unknown_action"),
        source_sentence,
        normalized_service_type,
    )
    normalized_conditions = normalize_conditions(conditions, normalized_api_action, normalized_service_type)

    return RequirementItem(
        requirement_id=str(raw_item.get("requirement_id") or fallback_requirement_id),
        service_type=normalized_service_type,
        mandatory=bool(raw_item.get("mandatory", False)),
        confidence=float(raw_item.get("confidence", 0.0)),
        source_sentence=source_sentence,
        api_action=normalized_api_action,
        conditions=normalized_conditions,
    )


def normalize_service_type(service_type: str, source_sentence: str) -> str:
    normalized = (service_type or "").strip().upper()
    sentence = (source_sentence or "").lower()

    # Domain-first overrides for sanctioning and enhanced due diligence workflows.
    if any(token in sentence for token in ["sanction", "watchlist", "terrorist", "money laundering", "complyadvantage"]):
        return "FRAUD"
    if any(token in sentence for token in ["enhanced due diligence", "source of funds", "sahamati", "account aggregator", "aa fetch"]):
        return "OPEN_BANKING"
    if any(token in sentence for token in ["onfido", "passport", "identity", "aadhaar", "kyc"]):
        return "KYC"
    if any(token in sentence for token in ["wise", "transferwise", "payout", "currency conversion", "beneficiary_iban", "swift_code"]):
        return "PAYMENT"

    if normalized in {"KYC", "BUREAU", "FRAUD", "PAYMENT", "GST", "OPEN_BANKING"}:
        return normalized
    if normalized == "ACCOUNT":
        return "OPEN_BANKING"
    return "OTHER"


def normalize_api_action(api_action: str, source_sentence: str, service_type: str) -> str:
    sentence = (source_sentence or "").lower()
    action = (api_action or "").strip().lower()

    if "kill-switch" in sentence or "kill switch" in sentence:
        return "kill_switch"
    if any(token in sentence for token in ["sanction", "watchlist", "complyadvantage"]):
        return "screen_sanctions"
    if any(token in sentence for token in ["source of funds", "enhanced due diligence", "sahamati", "aa fetch"]):
        return "verify_source_of_funds"
    if any(token in sentence for token in ["passport", "onfido"]):
        return "verify_passport"
    if "aadhaar" in sentence:
        return "verify_aadhaar"
    if any(token in sentence for token in ["wise", "transferwise", "payout", "currency conversion"]):
        return "process_payout"

    if service_type == "KYC" and action in {"kyc", "verify_kyc", "unknown_action"}:
        return "verify_identity"
    if service_type == "OPEN_BANKING" and action in {"account", "unknown_action"}:
        return "fetch_financials"
    return action or "unknown_action"


def normalize_conditions(conditions: dict[str, Any], api_action: str, service_type: str) -> dict[str, Any]:
    normalized = dict(conditions or {})

    if api_action == "kill_switch":
        normalized.setdefault("depends_on", "req_fraud_id")
        normalized.setdefault("trigger", "sanctions_hit")
    elif api_action == "verify_source_of_funds":
        normalized.setdefault("depends_on", "req_fraud_id")
        normalized.setdefault("threshold_amount_usd", 10000)
    elif api_action == "process_payout":
        normalized.setdefault("depends_on", "req_fraud_id")
    elif service_type == "PAYMENT":
        normalized.setdefault("depends_on", "req_fraud_id")

    return normalized


def extract_json_payload(content: str) -> dict[str, Any]:
    try:
        return json.loads(content)
    except Exception:
        # Handle markdown-wrapped responses like ```json ... ```.
        fenced = re.search(r"```(?:json)?\s*(\{[\s\S]*\})\s*```", content, flags=re.IGNORECASE)
        if fenced:
            return json.loads(fenced.group(1))

        first = content.find("{")
        last = content.rfind("}")
        if first != -1 and last != -1 and last > first:
            return json.loads(content[first : last + 1])
        raise


def extract_json_any(content: str) -> Any:
    try:
        return json.loads(content)
    except Exception:
        fenced = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", content, flags=re.IGNORECASE)
        if fenced:
            return json.loads(fenced.group(1))

        bracket_first = content.find("[")
        bracket_last = content.rfind("]")
        if bracket_first != -1 and bracket_last != -1 and bracket_last > bracket_first:
            return json.loads(content[bracket_first : bracket_last + 1])

        brace_first = content.find("{")
        brace_last = content.rfind("}")
        if brace_first != -1 and brace_last != -1 and brace_last > brace_first:
            return json.loads(content[brace_first : brace_last + 1])
        raise


def resolve_chat_completions_url(base_url: str) -> str:
    trimmed = base_url.rstrip("/")
    if trimmed.endswith("/chat/completions"):
        return trimmed
    return f"{trimmed}/chat/completions"


def to_vector_literal(embedding: list[float]) -> str:
    return "[" + ",".join(f"{value:.8f}" for value in embedding) + "]"


def generate_embedding(text: str, input_type: str) -> list[float]:
    if not EMBEDDING_API_KEY:
        raise ValueError("embedding_api_key_missing")

    headers = {
        "Authorization": f"Bearer {EMBEDDING_API_KEY}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    payload = {
        "model": EMBEDDING_MODEL,
        "input": text,
        "input_type": input_type,
    }
    response = requests.post(EMBEDDING_ENDPOINT, headers=headers, json=payload, timeout=60)
    response.raise_for_status()
    data = response.json()
    items = data.get("data", [])
    if not items or not isinstance(items, list):
        raise ValueError("embedding_response_missing_data")
    embedding = items[0].get("embedding", [])
    if not embedding or not isinstance(embedding, list):
        raise ValueError("embedding_response_invalid_vector")
    return [float(value) for value in embedding]


def call_extraction_endpoint(redacted_text: str) -> dict[str, Any]:
    invoke_url = resolve_chat_completions_url(EXTRACTION_BASE_URL)
    headers = {
        "Authorization": f"Bearer {EXTRACTION_API_KEY}",
        "Accept": "application/json",
    }
    payload = {
        "model": EXTRACTION_MODEL,
        "messages": [
            {"role": "system", "content": EXTRACTION_PROMPT},
            {"role": "user", "content": redacted_text},
        ],
        "max_tokens": 1200,
        "temperature": 0.2,
        "stream": False,
    }

    response = requests.post(invoke_url, headers=headers, json=payload, timeout=60)
    response.raise_for_status()
    return response.json()


def call_chat_completion(messages: list[dict[str, str]], max_tokens: int = 1200, temperature: float = 0.2) -> dict[str, Any]:
    invoke_url = resolve_chat_completions_url(EXTRACTION_BASE_URL)
    headers = {
        "Authorization": f"Bearer {EXTRACTION_API_KEY}",
        "Accept": "application/json",
    }
    payload = {
        "model": EXTRACTION_MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
    }

    response = requests.post(invoke_url, headers=headers, json=payload, timeout=60)
    response.raise_for_status()
    return response.json()


def infer_bank_fields(requirement: dict[str, Any]) -> list[str]:
    sentence = str(requirement.get("source_sentence") or "").lower()
    service_type = str(requirement.get("service_type") or "").upper()
    fields = ["application_id", "customer_id", "loan_amount"]

    if "pan" in sentence:
        fields.append("applicant_pan")
    if "aadhaar" in sentence or "aadhar" in sentence:
        fields.append("applicant_aadhaar")
    if "citizenship" in sentence:
        fields.append("user_citizenship")
    if "passport" in sentence or "onfido" in sentence:
        fields.extend(["passport_photo_ref", "user_citizenship"])
    if "sender_name" in sentence or "sender name" in sentence:
        fields.append("sender_name")
    if "receiver_name" in sentence or "receiver name" in sentence:
        fields.append("receiver_name")
    if "swift" in sentence:
        fields.append("swift_code")
    if "iban" in sentence:
        fields.append("beneficiary_iban")
    if "transfer_amount" in sentence or "transfer amount" in sentence:
        fields.append("transfer_amount")
    if "credit" in sentence or "bureau" in sentence or service_type == "BUREAU":
        fields.extend(["applicant_pan", "applicant_name", "applicant_dob", "loan_amount"])
    if service_type == "KYC":
        fields.extend(["applicant_name", "applicant_dob", "applicant_pan", "applicant_aadhaar", "user_citizenship", "passport_photo_ref"])
    if service_type == "FRAUD":
        fields.extend(["device_id", "ip_address", "customer_id", "txn_amount", "sender_name", "receiver_name"])
    if service_type == "PAYMENT":
        fields.extend(["beneficiary_account", "ifsc_code", "beneficiary_iban", "swift_code", "amount", "transfer_amount", "currency"])
    if service_type == "OPEN_BANKING":
        fields.extend(["transfer_amount", "currency", "consent_handle", "account_ref"])

    seen: set[str] = set()
    deduped: list[str] = []
    for field in fields:
        if field not in seen:
            seen.add(field)
            deduped.append(field)
    return deduped


def extract_schema_fields(request_schema: Any) -> list[str]:
    if not isinstance(request_schema, dict):
        return []

    properties = request_schema.get("properties")
    if isinstance(properties, dict):
        return [str(key) for key in properties.keys()]

    if isinstance(request_schema.get("fields"), list):
        fields: list[str] = []
        for item in request_schema.get("fields", []):
            if isinstance(item, dict) and item.get("name"):
                fields.append(str(item["name"]))
        return fields

    return [str(key) for key in request_schema.keys() if isinstance(key, str)]


def normalize_field_mapping_item(raw_item: dict[str, Any]) -> FieldMappingItem | None:
    source_field = str(raw_item.get("source_field") or "").strip()
    target_field = str(raw_item.get("target_field") or "").strip()
    if not source_field or not target_field:
        return None

    confidence_raw = raw_item.get("confidence", 0.5)
    try:
        confidence = float(confidence_raw)
    except Exception:
        confidence = 0.5
    confidence = max(0.0, min(1.0, confidence))

    return FieldMappingItem(
        source_field=source_field,
        target_field=target_field,
        confidence=confidence,
    )


def fallback_field_mappings(requirement: dict[str, Any], request_schema: Any) -> list[FieldMappingItem]:
    bank_fields = infer_bank_fields(requirement)
    adapter_fields = extract_schema_fields(request_schema)
    if not adapter_fields:
        adapter_fields = ["request_id"]

    mappings: list[FieldMappingItem] = []
    for target in adapter_fields[:3]:
        lowered = target.lower()
        source = "application_id"
        if "pan" in lowered:
            source = "applicant_pan"
        elif "aadhaar" in lowered or "aadhar" in lowered:
            source = "applicant_aadhaar"
        elif "passport" in lowered or "document" in lowered:
            source = "passport_photo_ref"
        elif "citizenship" in lowered or "country" in lowered:
            source = "user_citizenship"
        elif "sender" in lowered:
            source = "sender_name"
        elif "receiver" in lowered:
            source = "receiver_name"
        elif "iban" in lowered:
            source = "beneficiary_iban"
        elif "swift" in lowered:
            source = "swift_code"
        elif "transfer" in lowered and "amount" in lowered:
            source = "transfer_amount"
        elif "amount" in lowered:
            source = "transfer_amount"
        elif "name" in lowered:
            source = "applicant_name"
        elif "dob" in lowered or "birth" in lowered:
            source = "applicant_dob"
        elif bank_fields:
            source = bank_fields[0]

        mappings.append(FieldMappingItem(source_field=source, target_field=target, confidence=0.65))

    return mappings


def generate_field_mappings(requirement: dict[str, Any], request_schema: Any) -> tuple[list[FieldMappingItem], str]:
    # If no adapter was matched (or schema is unavailable), skip mapping generation.
    if not requirement.get("matched_adapter_version_id") or not request_schema:
        return [], "unmatched"

    if not EXTRACTION_API_KEY:
        if STRICT_API_ONLY:
            raise ValueError("extraction_api_key_missing_for_field_mappings")
        return fallback_field_mappings(requirement, request_schema), "stub"

    bank_fields = infer_bank_fields(requirement)
    try:
        payload = {
            "requirement": {
                "service_type": requirement.get("service_type"),
                "source_sentence": requirement.get("source_sentence"),
                "api_action": requirement.get("api_action"),
            },
            "bank_fields": bank_fields,
            "adapter_request_schema": request_schema,
        }
        data = call_chat_completion(
            messages=[
                {"role": "system", "content": MAPPING_PROMPT},
                {"role": "user", "content": json.dumps(payload)},
            ],
            max_tokens=800,
            temperature=0.1,
        )
        choices = data.get("choices", [])
        if not choices or not isinstance(choices, list):
            raise ValueError("mapping_missing_choices")

        message = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
        content = str(message.get("content", "{}"))
        parsed_any = extract_json_any(content)

        items_raw: list[Any]
        if isinstance(parsed_any, dict):
            candidate = parsed_any.get("field_mappings", [])
            items_raw = candidate if isinstance(candidate, list) else []
        elif isinstance(parsed_any, list):
            items_raw = parsed_any
        else:
            items_raw = []

        mappings = [
            mapping
            for mapping in (
                normalize_field_mapping_item(item)
                for item in items_raw
                if isinstance(item, dict)
            )
            if mapping is not None
        ]
        if not mappings:
            raise ValueError("mapping_empty")
        return mappings, "ai"
    except Exception as error:
        if STRICT_API_ONLY:
            raise RuntimeError(f"field_mapping_api_failed: {error}") from error
        return fallback_field_mappings(requirement, request_schema), "stub"


def build_execution_dag(connection: Any, document_id: str, tenant_id: str) -> dict[str, Any]:
    with connection.cursor(cursor_factory=RealDictCursor) as cursor:
        cursor.execute(
            """
            SELECT r.id,
                   r.service_type,
                   r.api_action,
                   r.source_sentence,
                   r.conditions,
                   r.matched_adapter_version_id,
                   av.request_schema,
                   a.name AS adapter_name
            FROM requirements r
            LEFT JOIN adapter_versions av ON av.id = r.matched_adapter_version_id
            LEFT JOIN adapters a ON a.id = av.adapter_id
            WHERE r.document_id = %s AND r.tenant_id = %s
            ORDER BY COALESCE(r.conditions->>'requirement_id', r.id::text), r.id
            """,
            (document_id, tenant_id),
        )
        requirements = cursor.fetchall()

    with connection.cursor(cursor_factory=RealDictCursor) as cursor:
        cursor.execute("SELECT id FROM tenant_configs WHERE tenant_id = %s LIMIT 1", (tenant_id,))
        tenant_config = cursor.fetchone()
        if tenant_config:
            tenant_config_id = str(tenant_config["id"])
        else:
            cursor.execute(
                "INSERT INTO tenant_configs (tenant_id) VALUES (%s) RETURNING id",
                (tenant_id,),
            )
            created = cursor.fetchone()
            if not created:
                raise ValueError("tenant_config_creation_failed")
            tenant_config_id = str(created["id"])

        cursor.execute(
            "SELECT COALESCE(MAX(version_number), 0) AS max_version FROM tenant_config_versions WHERE tenant_config_id = %s",
            (tenant_config_id,),
        )
        version_row = cursor.fetchone()
        max_version = int(version_row["max_version"] if version_row and version_row["max_version"] is not None else 0)
        next_version = max_version + 1

        cursor.execute(
            "INSERT INTO tenant_config_versions (tenant_config_id, version_number, config_json, status) VALUES (%s, %s, %s::jsonb, %s) RETURNING id",
            (tenant_config_id, next_version, json.dumps({}), "draft"),
        )
        inserted_version = cursor.fetchone()
        if not inserted_version:
            raise ValueError("tenant_config_version_creation_failed")
        tenant_config_version_id = str(inserted_version["id"])

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    all_mappings: list[dict[str, Any]] = []
    requirement_id_to_node_id: dict[str, str] = {}

    with connection.cursor(cursor_factory=RealDictCursor) as cursor:
        # Deterministic pass 1: create nodes and mappings in requirement order.
        for requirement in requirements:
            conditions = requirement.get("conditions")
            if not isinstance(conditions, dict):
                conditions = {}

            requirement_key = str(conditions.get("requirement_id") or requirement.get("id"))
            service_type = str(requirement.get("service_type") or "OTHER")

            cursor.execute(
                """
                INSERT INTO dag_nodes (tenant_config_version_id, adapter_version_id, node_type, condition)
                VALUES (%s, %s, %s, %s::jsonb)
                RETURNING id
                """,
                (
                    tenant_config_version_id,
                    requirement.get("matched_adapter_version_id"),
                    service_type,
                    json.dumps(conditions),
                ),
            )
            node_row = cursor.fetchone()
            if not node_row:
                raise ValueError("dag_node_creation_failed")
            node_id = str(node_row["id"])
            requirement_id_to_node_id[requirement_key] = node_id
            requirement_id_to_node_id.setdefault(requirement_key.lower(), node_id)
            requirement_id_to_node_id.setdefault(f"req_{service_type.lower()}_id", node_id)

            request_schema = requirement.get("request_schema")
            mappings, mapping_method = generate_field_mappings(requirement, request_schema)
            for mapping in mappings:
                cursor.execute(
                    """
                    INSERT INTO field_mappings (tenant_config_version_id, source_field, target_field, confidence)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (tenant_config_version_id, mapping.source_field, mapping.target_field, mapping.confidence),
                )
                all_mappings.append(
                    {
                        "requirement_id": requirement_key,
                        "service_type": service_type,
                        "adapter_version_id": requirement.get("matched_adapter_version_id"),
                        "adapter_name": requirement.get("adapter_name"),
                        "source_field": mapping.source_field,
                        "target_field": mapping.target_field,
                        "confidence": mapping.confidence,
                        "method": mapping_method,
                    }
                )

            nodes.append(
                {
                    "node_id": node_id,
                    "requirement_id": requirement_key,
                    "service_type": service_type,
                    "api_action": requirement.get("api_action"),
                    "adapter_version_id": requirement.get("matched_adapter_version_id"),
                    "adapter_name": requirement.get("adapter_name"),
                    "conditions": conditions,
                }
            )

        # Deterministic pass 2: create edges from depends_on relationships.
        for requirement in requirements:
            conditions = requirement.get("conditions")
            if not isinstance(conditions, dict):
                continue

            requirement_key = str(conditions.get("requirement_id") or requirement.get("id"))
            depends_on = str(conditions.get("depends_on") or "").strip()
            if not depends_on:
                continue

            from_node_id = requirement_id_to_node_id.get(depends_on) or requirement_id_to_node_id.get(depends_on.lower())
            to_node_id = requirement_id_to_node_id.get(requirement_key)
            if not from_node_id or not to_node_id:
                continue

            cursor.execute(
                """
                INSERT INTO dag_edges (tenant_config_version_id, from_node_id, to_node_id)
                VALUES (%s, %s, %s)
                RETURNING id
                """,
                (tenant_config_version_id, from_node_id, to_node_id),
            )
            edge_row = cursor.fetchone()
            if edge_row:
                edges.append(
                    {
                        "edge_id": str(edge_row["id"]),
                        "from_node_id": from_node_id,
                        "to_node_id": to_node_id,
                        "depends_on_requirement_id": depends_on,
                        "requirement_id": requirement_key,
                    }
                )

        config_json = {
            "document_id": document_id,
            "tenant_id": tenant_id,
            "version_number": next_version,
            "field_mappings": all_mappings,
            "dag": {
                "nodes": nodes,
                "edges": edges,
            },
        }

        cursor.execute(
            "UPDATE tenant_config_versions SET config_json = %s::jsonb WHERE id = %s",
            (json.dumps(config_json), tenant_config_version_id),
        )
        cursor.execute(
            "UPDATE tenant_configs SET current_version_id = %s WHERE id = %s",
            (tenant_config_version_id, tenant_config_id),
        )
        cursor.execute(
            "UPDATE documents SET parse_status = 'config_generated' WHERE id = %s",
            (document_id,),
        )

    return {
        "tenant_config_id": tenant_config_id,
        "tenant_config_version_id": tenant_config_version_id,
        "version_number": next_version,
        "config_json": config_json,
    }


def extract_requirements_with_ai(redacted_text: str) -> tuple[list[RequirementItem], str]:
    if not EXTRACTION_API_KEY:
        if STRICT_API_ONLY:
            raise ValueError("extraction_api_key_missing")
        return golden_flow_requirements(), "stub"

    try:
        data = call_extraction_endpoint(redacted_text)
        choices = data.get("choices", [])
        if not choices or not isinstance(choices, list):
            raise ValueError("missing_choices")

        message = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
        content = str(message.get("content", "{}"))
        parsed = extract_json_payload(content)
        requirements_raw = parsed.get("requirements", [])
        if not isinstance(requirements_raw, list) or not requirements_raw:
            raise ValueError("invalid_requirements_payload")

        requirements = [
            normalize_requirement_item(item, f"req_{index + 1}")
            for index, item in enumerate(requirements_raw)
            if isinstance(item, dict)
        ]
        if not requirements:
            raise ValueError("empty_requirements_payload")

        return requirements, "ai"
    except Exception as error:
        if STRICT_API_ONLY:
            raise RuntimeError(f"requirements_api_failed: {error}") from error
        return golden_flow_requirements(), "stub"


def deduplicate_requirements(requirements: list[RequirementItem]) -> list[RequirementItem]:
    deduped: list[RequirementItem] = []
    index_by_key: dict[tuple[str, str, str], int] = {}

    def canonical_sentence(text: str) -> str:
        lowered = (text or "").lower()
        lowered = lowered.replace("\u2019", "'").replace("\u2018", "'").replace("\u201c", '"').replace("\u201d", '"')
        lowered = re.sub(r"[^a-z0-9\s]", " ", lowered)
        return re.sub(r"\s+", " ", lowered).strip()

    for item in requirements:
        key = (
            item.service_type.strip().upper(),
            canonical_sentence(item.source_sentence or ""),
            (item.api_action or "").strip().lower(),
        )
        existing_index = index_by_key.get(key)
        if existing_index is None:
            index_by_key[key] = len(deduped)
            deduped.append(item)
            continue

        existing = deduped[existing_index]
        merged_conditions = {**existing.conditions, **item.conditions}
        deduped[existing_index] = RequirementItem(
            requirement_id=existing.requirement_id,
            service_type=existing.service_type,
            mandatory=existing.mandatory or item.mandatory,
            confidence=max(existing.confidence, item.confidence),
            source_sentence=existing.source_sentence,
            api_action=existing.api_action,
            conditions=merged_conditions,
        )

    # Reassign sequential ids to keep DAG keys deterministic after deduplication.
    return [
        RequirementItem(
            requirement_id=f"req_{idx + 1}",
            service_type=item.service_type,
            mandatory=item.mandatory,
            confidence=item.confidence,
            source_sentence=item.source_sentence,
            api_action=item.api_action,
            conditions=item.conditions,
        )
        for idx, item in enumerate(deduped)
    ]


def sentence_for_keyword(text: str, keywords: list[str], fallback: str) -> str:
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    for line in lines:
        lowered = line.lower()
        if any(keyword in lowered for keyword in keywords):
            return line
    return fallback


def ensure_requirement_coverage(redacted_text: str, requirements: list[RequirementItem]) -> list[RequirementItem]:
    sentence = (redacted_text or "").lower()
    enriched = list(requirements)

    def has_requirement(predicate: Any) -> bool:
        return any(predicate(item) for item in enriched)

    if any(token in sentence for token in ["sanction", "watchlist", "complyadvantage"]) and not has_requirement(
        lambda item: item.service_type == "FRAUD" and item.api_action in {"screen_sanctions", "kill_switch"}
    ):
        enriched.append(
            RequirementItem(
                requirement_id="req_auto_sanctions",
                service_type="FRAUD",
                mandatory=True,
                confidence=0.75,
                source_sentence=sentence_for_keyword(
                    redacted_text,
                    ["sanction", "watchlist", "complyadvantage"],
                    "Screen each transaction against sanctions lists before payout.",
                ),
                api_action="screen_sanctions",
                conditions={},
            )
        )

    if any(token in sentence for token in ["onfido", "passport", "international users"]) and not has_requirement(
        lambda item: item.service_type == "KYC" and item.api_action == "verify_passport"
    ):
        enriched.append(
            RequirementItem(
                requirement_id="req_auto_passport",
                service_type="KYC",
                mandatory=True,
                confidence=0.75,
                source_sentence=sentence_for_keyword(
                    redacted_text,
                    ["onfido", "passport", "international users"],
                    "International users require passport identity verification.",
                ),
                api_action="verify_passport",
                conditions={},
            )
        )

    if any(token in sentence for token in ["sahamati", "enhanced due diligence", "source of funds"]) and not has_requirement(
        lambda item: item.service_type == "OPEN_BANKING" and item.api_action == "verify_source_of_funds"
    ):
        enriched.append(
            RequirementItem(
                requirement_id="req_auto_edd",
                service_type="OPEN_BANKING",
                mandatory=True,
                confidence=0.75,
                source_sentence=sentence_for_keyword(
                    redacted_text,
                    ["sahamati", "enhanced due diligence", "source of funds"],
                    "Run enhanced due diligence for high-value transfers.",
                ),
                api_action="verify_source_of_funds",
                conditions={"depends_on": "req_fraud_id", "threshold_amount_usd": 10000},
            )
        )

    if any(token in sentence for token in ["wise", "transferwise", "payout", "beneficiary_iban", "swift_code"]) and not has_requirement(
        lambda item: item.service_type == "PAYMENT" and item.api_action == "process_payout"
    ):
        enriched.append(
            RequirementItem(
                requirement_id="req_auto_payout",
                service_type="PAYMENT",
                mandatory=True,
                confidence=0.75,
                source_sentence=sentence_for_keyword(
                    redacted_text,
                    ["wise", "transferwise", "payout", "beneficiary_iban", "swift_code"],
                    "Use payout rails after compliance checks are clear.",
                ),
                api_action="process_payout",
                conditions={"depends_on": "req_fraud_id"},
            )
        )

    return enriched


def save_requirements(connection: Any, document_id: str, tenant_id: str, requirements: list[RequirementItem]) -> None:
    with connection.cursor() as cursor:
        cursor.execute("DELETE FROM requirements WHERE document_id = %s", (document_id,))
        for requirement in requirements:
            cursor.execute(
                """
                INSERT INTO requirements (
                    document_id,
                    tenant_id,
                    service_type,
                    mandatory,
                    confidence,
                    source_sentence,
                    conditions,
                    api_action
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s)
                """,
                (
                    document_id,
                    tenant_id,
                    requirement.service_type,
                    requirement.mandatory,
                    requirement.confidence,
                    requirement.source_sentence,
                    json.dumps({**requirement.conditions, "requirement_id": requirement.requirement_id}),
                    requirement.api_action,
                ),
            )


def normalize_requirement_category(service_type: str, source_sentence: str) -> str | None:
    normalized = (service_type or "").strip().upper()
    if normalized in {"KYC", "BUREAU", "FRAUD", "PAYMENT", "GST", "OPEN_BANKING"}:
        return normalized
    if normalized == "ACCOUNT":
        return "OPEN_BANKING"

    sentence = (source_sentence or "").lower()
    if "sanction" in sentence or "watchlist" in sentence or "terrorist" in sentence or "money laundering" in sentence:
        return "FRAUD"
    if "enhanced due diligence" in sentence or "source of funds" in sentence or "sahamati" in sentence:
        return "OPEN_BANKING"
    if "gst" in sentence:
        return "GST"
    if "aadhaar" in sentence or "kyc" in sentence or "onfido" in sentence or "passport" in sentence:
        return "KYC"
    if "bureau" in sentence or "credit score" in sentence or "cibil" in sentence:
        return "BUREAU"
    if "fraud" in sentence:
        return "FRAUD"
    if "payment" in sentence or "disburs" in sentence or "wise" in sentence or "transferwise" in sentence or "swift" in sentence or "iban" in sentence:
        return "PAYMENT"
    if "account aggregator" in sentence or "bank statement" in sentence:
        return "OPEN_BANKING"
    return None


def preferred_provider_hint(source_sentence: str, target_category: str) -> str | None:
    sentence = (source_sentence or "").lower()

    if target_category == "FRAUD":
        if any(token in sentence for token in ["sanction", "watchlist", "terrorist", "money laundering", "complyadvantage"]):
            return "complyadvantage"
    if target_category == "KYC":
        if any(token in sentence for token in ["passport", "onfido", "international", "digital nomad"]):
            return "onfido"
        if "aadhaar" in sentence:
            return "uidai"
    if target_category == "OPEN_BANKING":
        if any(token in sentence for token in ["sahamati", "account aggregator", "source of funds", "enhanced due diligence"]):
            return "sahamati"
    if target_category == "PAYMENT":
        if any(token in sentence for token in ["wise", "transferwise", "iban", "swift"]):
            return "wise"

    return None


def ensure_category_embeddings(connection: Any, category: str) -> None:
    with connection.cursor(cursor_factory=RealDictCursor) as cursor:
        cursor.execute(
            """
            SELECT av.id AS adapter_version_id,
                   a.name,
                   a.provider,
                   a.category,
                   av.request_schema,
                   av.embedding
            FROM adapter_versions av
            JOIN adapters a ON a.id = av.adapter_id
            WHERE a.category = %s
            """,
            (category,),
        )
        rows = cursor.fetchall()

    for row in rows:
        if row.get("embedding") is not None:
            continue

        schema = row.get("request_schema")
        schema_fields = []
        if isinstance(schema, dict):
            schema_fields = [str(key) for key in schema.keys()]

        embedding_text = " ".join(
            [
                str(row.get("name") or ""),
                str(row.get("provider") or ""),
                str(row.get("category") or ""),
                " ".join(schema_fields),
            ]
        ).strip()
        if not embedding_text:
            continue

        try:
            embedding = generate_embedding(embedding_text, input_type="passage")
            vector_literal = to_vector_literal(embedding)
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE adapter_versions SET embedding = %s::vector WHERE id = %s",
                    (vector_literal, row["adapter_version_id"]),
                )
        except Exception:
            # Leave embedding null and allow provider-aware fallback.
            continue


def fallback_match_adapter(connection: Any, target_category: str, source_sentence: str) -> dict[str, Any] | None:
    with connection.cursor(cursor_factory=RealDictCursor) as cursor:
        cursor.execute(
            """
            SELECT av.id AS adapter_version_id,
                   a.name,
                   a.category,
                   a.provider
            FROM adapter_versions av
            JOIN adapters a ON a.id = av.adapter_id
            WHERE a.category = %s
            ORDER BY a.name ASC
            """,
            (target_category,),
        )
        candidates = cursor.fetchall()

    if not candidates:
        return None

    preferred_provider = preferred_provider_hint(source_sentence, target_category)
    if preferred_provider:
        for candidate in candidates:
            provider = str(candidate.get("provider") or "").lower()
            name = str(candidate.get("name") or "").lower()
            if preferred_provider in provider or preferred_provider in name:
                return candidate

    return candidates[0]


def match_requirements_to_adapters(connection: Any, document_id: str) -> None:
    hydrated_categories: set[str] = set()

    with connection.cursor(cursor_factory=RealDictCursor) as cursor:
        cursor.execute(
            "SELECT id, service_type, source_sentence FROM requirements WHERE document_id = %s ORDER BY id",
            (document_id,),
        )
        requirements = cursor.fetchall()

    for requirement in requirements:
        requirement_id = requirement["id"]
        service_type = str(requirement.get("service_type") or "").upper()
        source_sentence = str(requirement.get("source_sentence") or "").strip()
        if not source_sentence:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE requirements SET matched_adapter_version_id = NULL, match_explanation = %s WHERE id = %s",
                    ("Requirement source sentence is empty; adapter matching skipped", requirement_id),
                )
            continue

        try:
            target_category = normalize_requirement_category(service_type, source_sentence)
            if not target_category:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "UPDATE requirements SET matched_adapter_version_id = NULL, match_explanation = %s WHERE id = %s",
                        (
                            f"No compatible adapter category for requirement type {service_type}; semantic fallback disabled to avoid cross-category mismatch",
                            requirement_id,
                        ),
                    )
                continue

            if target_category not in hydrated_categories:
                ensure_category_embeddings(connection, target_category)
                hydrated_categories.add(target_category)

            query_embedding = generate_embedding(source_sentence, input_type="query")
            vector_literal = to_vector_literal(query_embedding)

            with connection.cursor(cursor_factory=RealDictCursor) as cursor:
                cursor.execute(
                    """
                    SELECT av.id AS adapter_version_id, a.name, a.category
                    FROM adapter_versions av
                    JOIN adapters a ON a.id = av.adapter_id
                    WHERE av.embedding IS NOT NULL
                      AND a.category = %s
                    ORDER BY av.embedding <=> %s::vector
                    LIMIT 1
                    """,
                    (target_category, vector_literal),
                )
                best_match = cursor.fetchone()

                if best_match:
                    adapter_name = str(best_match['name'] or "Unknown Adapter").strip()
                    category = str(best_match['category'] or "").strip()
                    
                    # Build adapter-specific explanation
                    if "complyadvantage" in adapter_name.lower() or "comply" in adapter_name.lower():
                        explanation = f"Matched to {adapter_name} Sanctions Engine via semantic similarity."
                    elif "onfido" in adapter_name.lower():
                        explanation = f"Matched to {adapter_name} Global Identity Verification based on document requirements."
                    elif "aadhaar" in adapter_name.lower() or "aadhar" in adapter_name.lower():
                        explanation = f"Matched to {adapter_name} eKYC for Indian identity verification."
                    elif "sahamati" in adapter_name.lower() or "aa" in adapter_name.lower():
                        explanation = f"Matched to {adapter_name} Account Aggregator for source of funds verification."
                    elif "wise" in adapter_name.lower():
                        explanation = f"Matched to {adapter_name} for international payout processing."
                    else:
                        explanation = f"Matched to {adapter_name} ({category}) via semantic similarity to requirement type {service_type}."
                    
                    cursor.execute(
                        """
                        UPDATE requirements
                        SET matched_adapter_version_id = %s,
                            match_explanation = %s
                        WHERE id = %s
                        """,
                        (best_match["adapter_version_id"], explanation, requirement_id),
                    )
                else:
                    fallback_match = fallback_match_adapter(connection, target_category, source_sentence)
                    if fallback_match:
                        preferred_provider = preferred_provider_hint(source_sentence, target_category)
                        strategy = "category fallback"
                        if preferred_provider:
                            strategy = f"provider-aware category fallback ({preferred_provider})"
                        cursor.execute(
                            """
                            UPDATE requirements
                            SET matched_adapter_version_id = %s,
                                match_explanation = %s
                            WHERE id = %s
                            """,
                            (
                                fallback_match["adapter_version_id"],
                                f"Matched using {strategy} to {fallback_match['name']} ({fallback_match['category']}) because embeddings were unavailable for category {target_category}",
                                requirement_id,
                            ),
                        )
                        continue

                    cursor.execute(
                        "UPDATE requirements SET matched_adapter_version_id = NULL, match_explanation = %s WHERE id = %s",
                        (
                            f"No embedded adapters found for category {target_category}; semantic fallback disabled to avoid cross-category mismatch",
                            requirement_id,
                        ),
                    )
        except Exception as error:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE requirements SET matched_adapter_version_id = NULL, match_explanation = %s WHERE id = %s",
                    (f"Semantic matching failed: {error}", requirement_id),
                )


@app.on_event("startup")
def startup() -> None:
    ensure_document_columns()
    ensure_bucket()


@app.post("/process/{document_id}")
def process_document(document_id: str) -> dict[str, Any]:
    with get_connection() as connection:
        with connection.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute(
                "SELECT id, tenant_id, filename, storage_path, parse_status FROM documents WHERE id = %s LIMIT 1",
                (document_id,),
            )
            document = cursor.fetchone()

        if not document:
            raise HTTPException(status_code=404, detail="document_not_found")

        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE documents
                SET parse_status = 'processing'
                WHERE id = %s
                  AND parse_status <> 'processing'
                """,
                (document_id,),
            )
            updated_rows = cursor.rowcount
        connection.commit()

        if updated_rows == 0:
            return {
                "document_id": document_id,
                "status": "already_processing",
                "message": "Document processing is already in progress",
            }

        object_name = str(document["storage_path"])
        try:
            response = minio_client.get_object(MINIO_BUCKET, object_name)
            payload = response.read()
            response.close()
            response.release_conn()
        except Exception as error:
            with connection.cursor() as cursor:
                cursor.execute("UPDATE documents SET parse_status = 'failed' WHERE id = %s", (document_id,))
            connection.commit()
            raise HTTPException(status_code=500, detail=f"minio_fetch_failed: {error}") from error

        try:
            raw_text = extract_text(str(document["filename"]), payload)
            redacted_text, entities = nvidia_redact(raw_text)
            requirements, extraction_method = extract_requirements_with_ai(redacted_text)
            requirements = ensure_requirement_coverage(raw_text, requirements)
            requirements = deduplicate_requirements(requirements)

            save_requirements(connection, str(document["id"]), str(document["tenant_id"]), requirements)
            match_requirements_to_adapters(connection, str(document["id"]))
            config_build = build_execution_dag(connection, str(document["id"]), str(document["tenant_id"]))

            write_audit_event(
                connection,
                str(document["tenant_id"]),
                "document",
                str(document["id"]),
                "pii_redacted",
                "ai_service",
                {
                    "entity_count": len(entities),
                },
            )
            write_audit_event(
                connection,
                str(document["tenant_id"]),
                "document",
                str(document["id"]),
                "requirements_extracted",
                "ai_service",
                {
                    "extraction_method": extraction_method,
                    "requirement_count": len(requirements),
                },
            )
            write_audit_event(
                connection,
                str(document["tenant_id"]),
                "tenant_config_version",
                str(config_build["tenant_config_version_id"]),
                "config_generated",
                "ai_service",
                {
                    "document_id": str(document["id"]),
                    "version_number": config_build["version_number"],
                    "dag_node_count": len(config_build["config_json"].get("dag", {}).get("nodes", [])),
                    "dag_edge_count": len(config_build["config_json"].get("dag", {}).get("edges", [])),
                },
            )

            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE documents
                    SET raw_text = %s,
                        redacted_content = %s::jsonb
                    WHERE id = %s
                    """,
                    (
                        raw_text,
                        json.dumps({"redacted_text": redacted_text, "entities": entities}),
                        document_id,
                    ),
                )
            connection.commit()
        except Exception as error:
            with connection.cursor() as cursor:
                cursor.execute("UPDATE documents SET parse_status = 'failed' WHERE id = %s", (document_id,))
            connection.commit()
            raise HTTPException(status_code=500, detail=f"processing_failed: {error}") from error

    return {
        "document_id": document_id,
        "status": "config_generated",
        "extraction_method": extraction_method,
        "redacted_text": redacted_text,
        "entities": entities,
        "tenant_config_version_id": config_build["tenant_config_version_id"],
        "config_version_number": config_build["version_number"],
        "dag_node_count": len(config_build["config_json"].get("dag", {}).get("nodes", [])),
        "dag_edge_count": len(config_build["config_json"].get("dag", {}).get("edges", [])),
        "requirements": [
            {
                "requirement_id": requirement.requirement_id,
                "service_type": requirement.service_type,
                "mandatory": requirement.mandatory,
                "confidence": requirement.confidence,
                "source_sentence": requirement.source_sentence,
                "api_action": requirement.api_action,
                "conditions": requirement.conditions,
            }
            for requirement in requirements
        ],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8002)
    args = parser.parse_args()

    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=args.port, reload=False)
