import json
import os
import re
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field, ValidationError
from psycopg import Connection


class RequirementCondition(BaseModel):
    depends_on: str | None
    condition_type: Literal["prerequisite", "parallel", "optional_if"]
    expression: str


class RequirementItem(BaseModel):
    requirement_id: str
    service_type: Literal["bureau", "kyc", "gst", "payment", "fraud", "open_banking"]
    provider_hint: str | None = None
    mandatory: bool
    confidence: float = Field(ge=0.0, le=1.0)
    source_sentence: str
    fields_needed: list[str] = Field(default_factory=list)
    conditions: list[RequirementCondition] = Field(default_factory=list)
    api_action: Literal["fetch", "verify", "submit", "poll"]
    notes: str



class RequirementExtraction(BaseModel):
    requirements: list[RequirementItem]
    extraction_confidence: float = Field(ge=0.0, le=1.0)
    ambiguous_requirements: list[str]
    missing_information: list[str]


EXTRACTION_PROMPT = """
You are an enterprise integration analyst.
Analyze the following BRD/SOW document and extract all integration requirements.

Return ONLY valid JSON matching this exact schema. No preamble, no markdown:

{
  "requirements": [
    {
      "requirement_id": "req_001",
      "service_type": "bureau | kyc | gst | payment | fraud | open_banking",
      "provider_hint": "string or null",
      "mandatory": true,
      "confidence": 0.85,
      "source_sentence": "exact sentence from document that indicates this",
      "fields_needed": ["field1", "field2"],
      "conditions": [
        {
          "depends_on": "requirement_id or null",
          "condition_type": "prerequisite | parallel | optional_if",
          "expression": "human readable condition"
        }
      ],
      "api_action": "fetch | verify | submit | poll",
      "notes": "any ambiguity or additional context"
    }
  ],
  "extraction_confidence": 0.80,
  "ambiguous_requirements": ["sentences that were unclear"],
  "missing_information": ["what additional info would improve extraction"]
}

IMPORTANT RULES FOR CONDITIONS:
- depends_on MUST reference another requirement_id (example: req_001).
- Do NOT use service names like "kyc" or "bureau" in depends_on.
- Typical lending dependency chain:
    - bureau depends on kyc
    - fraud depends on bureau
    - payment depends on fraud
- Only the first prerequisite in the chain should use an empty conditions array.

Document:
__DOCUMENT_TEXT__
"""


def structured_to_text(structured_content: dict[str, Any]) -> str:
    headers = structured_content.get("headers", [])
    sections = structured_content.get("sections", [])
    tables = structured_content.get("tables", [])
    raw_text = structured_content.get("raw_text", "")

    lines: list[str] = []
    if isinstance(headers, list):
        lines.extend([str(h) for h in headers])

    if isinstance(sections, list):
        for section in sections:
            if isinstance(section, dict):
                title = section.get("title")
                content = section.get("content")
                if title:
                    lines.append(f"Section: {title}")
                if content:
                    lines.append(str(content))

    if isinstance(tables, list):
        for table in tables:
            if isinstance(table, dict) and isinstance(table.get("rows"), list):
                for row in table["rows"]:
                    if isinstance(row, list):
                        lines.append(" | ".join(str(cell) for cell in row))

    if raw_text:
        lines.append(str(raw_text))

    return "\n".join(lines)


def _extract_json_content(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    return json.loads(text)


def _call_extractor_llm(document_text: str) -> dict[str, Any]:
    api_key = os.getenv("NVIDIA_REQUIREMENTS_API_KEY") or os.getenv("NVIDIA_MAIN_LLM_API_KEY") or os.getenv("NVIDIA_API_KEY", "")
    api_key = api_key.strip()
    if not api_key:
        raise RuntimeError("NVIDIA_API_KEY is required for requirement extraction")

    endpoint = os.getenv("NVIDIA_CHAT_ENDPOINT", "https://integrate.api.nvidia.com/v1/chat/completions")
    model = os.getenv(
        "NVIDIA_REQUIREMENTS_MODEL",
        "mistralai/mistral-small-3.1-24b-instruct-2503",
    )

    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": EXTRACTION_PROMPT.replace("__DOCUMENT_TEXT__", document_text),
            }
        ],
        "max_tokens": 2000,
        "temperature": 0.1,
    }

    with httpx.Client(timeout=90.0) as client:
        try:
            response = client.post(
                endpoint,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
            )
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPStatusError, httpx.RequestError, ValueError, KeyError):
            raise RuntimeError("llm_extraction_failed")

    content = data["choices"][0]["message"]["content"]
    return _extract_json_content(content)


def stub_extractor(text: str, document_id: str, tenant_id: str) -> RequirementExtraction:
    sentences = [sentence.strip() for sentence in re.split(r"[\n\.]+", text) if sentence.strip()]
    requirements: list[RequirementItem] = []

    service_map = [
        ("bureau", ["cibil", "bureau", "equifax", "experian", "credit"]),
        ("kyc", ["kyc", "aadhaar", "pan", "identity", "verification"]),
        ("gst", ["gst", "gstr", "tax"]),
        ("payment", ["payment", "gateway", "razorpay", "stripe", "disbursal"]),
        ("fraud", ["fraud", "risk", "device", "threat", "screening"]),
        ("open_banking", ["account aggregator", "aa", "open banking", "consent"]),
    ]

    requirement_counter = 1
    for sentence in sentences:
        lowered = sentence.lower()
        if not any(keyword in lowered for _, keywords in service_map for keyword in keywords):
            continue

        # Pick service type by earliest keyword occurrence to avoid biased ordering.
        best_match: tuple[int, str] | None = None
        for candidate_service, keywords in service_map:
            for keyword in keywords:
                pos = lowered.find(keyword)
                if pos == -1:
                    continue
                if best_match is None or pos < best_match[0]:
                    best_match = (pos, candidate_service)
        service_type = best_match[1] if best_match else "bureau"

        mandatory = any(word in lowered for word in ["must", "shall", "required", "mandatory"])
        api_action = "fetch" if any(word in lowered for word in ["fetch", "pull", "get"]) else "verify"
        if any(word in lowered for word in ["submit", "upload"]):
            api_action = "submit"
        if any(word in lowered for word in ["poll", "check status", "status"]):
            api_action = "poll"

        provider_hint = None
        for provider in ["cibil", "experian", "equifax", "aadhaar", "pan", "razorpay", "stripe"]:
            if provider in lowered:
                provider_hint = provider.title()
                break

        requirements.append(
            RequirementItem(
                requirement_id=f"req_{requirement_counter:03d}",
                service_type=service_type,  # type: ignore[arg-type]
                provider_hint=provider_hint,
                mandatory=mandatory,
                confidence=0.55,
                source_sentence=sentence,
                fields_needed=[],
                conditions=[],
                api_action=api_action,  # type: ignore[arg-type]
                notes="Fallback stub extraction used because the LLM response was unavailable.",
            )
        )
        requirement_counter += 1

    # Ensure fallback extraction still models dependency intent for DAG generation.
    if requirements:
        first_req_by_service: dict[str, str] = {}
        for req in requirements:
            if req.service_type not in first_req_by_service:
                first_req_by_service[req.service_type] = req.requirement_id

        service_dependencies = {
            "bureau": "kyc",
            "fraud": "bureau",
            "payment": "fraud",
        }

        for req in requirements:
            dependency_service = service_dependencies.get(req.service_type)
            if not dependency_service:
                continue
            depends_on_req_id = first_req_by_service.get(dependency_service)
            if not depends_on_req_id or depends_on_req_id == req.requirement_id:
                continue
            req.conditions = [
                RequirementCondition(
                    depends_on=depends_on_req_id,
                    condition_type="prerequisite",
                    expression=f"{req.service_type} requires successful {dependency_service}",
                )
            ]

    return RequirementExtraction(
        requirements=requirements,
        extraction_confidence=0.35 if requirements else 0.0,
        ambiguous_requirements=[] if requirements else ["No extractable integration requirement found."],
        missing_information=["LLM extraction unavailable; review fallback results manually."],
    )


def extract_requirements(
    conn: Connection[Any],
    structured_content: dict[str, Any],
    document_id: str,
    tenant_id: str,
) -> RequirementExtraction:
    text = structured_to_text(structured_content)

    last_error: Exception | None = None
    validated: RequirementExtraction | None = None
    attempt_used = 0

    for attempt in range(1, 4):
        attempt_used = attempt
        try:
            parsed = _call_extractor_llm(text)
            validated = RequirementExtraction.model_validate(parsed)
            break
        except (json.JSONDecodeError, ValidationError, httpx.HTTPError, RuntimeError) as exc:
            last_error = exc

    if validated is None:
        validated = stub_extractor(text, document_id, tenant_id)
        if not validated.requirements:
            raise RuntimeError(f"requirement_extraction_failed_after_retries: {last_error}")

    with conn.cursor() as cur:
        for req in validated.requirements:
            cur.execute(
                """
                INSERT INTO requirements
                  (
                    document_id,
                    tenant_id,
                    requirement_id,
                    service_type,
                    provider_hint,
                    mandatory,
                    confidence,
                    source_sentence,
                    fields_needed,
                    conditions,
                    api_action,
                    notes,
                    extraction_attempt,
                    status
                  )
                VALUES
                  (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s, 'extracted')
                """,
                (
                    document_id,
                    tenant_id,
                    req.requirement_id,
                    req.service_type,
                    req.provider_hint,
                    req.mandatory,
                    req.confidence,
                    req.source_sentence,
                    json.dumps(req.fields_needed),
                    json.dumps([c.model_dump() for c in req.conditions]),
                    req.api_action,
                    req.notes,
                    attempt_used,
                ),
            )

    return validated
