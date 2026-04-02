import io
import json
import os
from typing import Any

import fitz
import httpx
from docx import Document


def extract_plain_text(filename: str, payload: bytes) -> str:
    lower_name = filename.lower()
    if lower_name.endswith(".txt"):
        return payload.decode("utf-8", errors="ignore")

    if lower_name.endswith(".pdf"):
        chunks: list[str] = []
        pdf_doc = fitz.open(stream=payload, filetype="pdf")
        for page in pdf_doc:
            chunks.append(page.get_text())
        pdf_doc.close()
        return "\n".join(chunks)

    if lower_name.endswith(".docx"):
        doc = Document(io.BytesIO(payload))
        return "\n".join(paragraph.text for paragraph in doc.paragraphs)

    raise ValueError("Unsupported file extension")


def _heuristic_structure(filename: str, payload: bytes) -> dict[str, Any]:
    text = extract_plain_text(filename, payload)
    lines = [line.strip() for line in text.splitlines() if line.strip()]

    headers = [line for line in lines if len(line) < 120 and line.endswith(":")]
    sections = [{"title": h.rstrip(":"), "content": ""} for h in headers]

    table_like_rows = []
    for line in lines:
        if "|" in line:
            cols = [c.strip() for c in line.split("|")]
            if len(cols) >= 2:
                table_like_rows.append(cols)

    tables = []
    if table_like_rows:
        tables.append({"rows": table_like_rows})

    return {
        "sections": sections,
        "tables": tables,
        "headers": headers,
        "raw_text": text,
        "source": "heuristic_extraction",
    }


def extract_structure(filename: str, payload: bytes, mime_type: str) -> dict[str, Any]:
    endpoint = os.getenv("NVIDIA_OCR_ENDPOINT", "https://integrate.api.nvidia.com/v1/ocdrnet")
    api_key = os.getenv("NVIDIA_OCR_API_KEY") or os.getenv("NVIDIA_API_KEY", "")
    api_key = api_key.strip()

    if not api_key:
        return _heuristic_structure(filename, payload)

    files = {
        "file": (filename, payload, mime_type or "application/octet-stream"),
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
    }

    try:
        with httpx.Client(timeout=60.0) as client:
            response = client.post(endpoint, headers=headers, files=files)
            response.raise_for_status()
            data = response.json()
    except Exception:
        return _heuristic_structure(filename, payload)

    def _safe_value(obj: Any, key: str, default: Any) -> Any:
        if isinstance(obj, dict) and key in obj:
            return obj[key]
        return default

    full_text = _safe_value(data, "full_text", _safe_value(data, "text", ""))

    return {
        "sections": _safe_value(data, "sections", []),
        "tables": _safe_value(data, "tables", []),
        "headers": _safe_value(data, "headers", []),
        "raw_text": full_text,
        "source": "nvidia_ocdrnet",
        "provider_response": data if isinstance(data, dict) else json.loads(json.dumps(data)),
    }
