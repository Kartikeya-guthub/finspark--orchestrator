from __future__ import annotations

import json
import os
from typing import Any

import psycopg2
import requests
from psycopg2.extras import RealDictCursor

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://finspark:finspark@localhost:5432/finspark")
EMBEDDING_API_KEY = os.getenv("EMBEDDING_API_KEY", os.getenv("EXTRACTION_API_KEY", os.getenv("NVIDIA_API_KEY", ""))).strip()
EMBEDDING_ENDPOINT = os.getenv("EMBEDDING_ENDPOINT", os.getenv("NVIDIA_EMBEDDINGS_ENDPOINT", "https://integrate.api.nvidia.com/v1/embeddings"))
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", os.getenv("NVIDIA_EMBEDDINGS_MODEL", "nvidia/llama-3.2-nv-embedqa-1b-v2"))


def get_connection() -> psycopg2.extensions.connection:
    return psycopg2.connect(DATABASE_URL)


def to_vector_literal(embedding: list[float]) -> str:
    return "[" + ",".join(f"{value:.8f}" for value in embedding) + "]"


def request_embedding(text: str) -> list[float]:
    if not EMBEDDING_API_KEY:
        raise RuntimeError("EMBEDDING_API_KEY (or EXTRACTION_API_KEY/NVIDIA_API_KEY) is required")

    headers = {
        "Authorization": f"Bearer {EMBEDDING_API_KEY}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    payload = {
        "model": EMBEDDING_MODEL,
        "input": text,
        "input_type": "passage",
    }

    response = requests.post(EMBEDDING_ENDPOINT, headers=headers, json=payload, timeout=60)
    response.raise_for_status()
    data = response.json()
    rows = data.get("data", [])
    if not rows or not isinstance(rows, list):
        raise RuntimeError("Embedding response missing data")
    embedding = rows[0].get("embedding", [])
    if not embedding or not isinstance(embedding, list):
        raise RuntimeError("Embedding vector missing in response")
    return [float(value) for value in embedding]


def schema_keys(schema_json: Any) -> list[str]:
    if isinstance(schema_json, dict):
        return sorted(str(key) for key in schema_json.keys())
    return []


def build_search_string(row: dict[str, Any]) -> str:
    keys = schema_keys(row.get("request_schema"))
    key_text = ", ".join(keys) if keys else "none"
    return (
        f"Adapter: {row.get('adapter_name', '')}; "
        f"Category: {row.get('category', '')}; "
        f"Request schema keys: {key_text}"
    )


def main() -> None:
    with get_connection() as connection:
        with connection.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute(
                """
                SELECT av.id, av.request_schema, a.name AS adapter_name, a.category
                FROM adapter_versions av
                JOIN adapters a ON a.id = av.adapter_id
                ORDER BY a.name ASC
                """
            )
            rows = cursor.fetchall()

        if not rows:
            print("No adapter_versions found; nothing to embed")
            return

        updated = 0
        for row in rows:
            search_text = build_search_string(row)
            embedding = request_embedding(search_text)
            vector_literal = to_vector_literal(embedding)

            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE adapter_versions SET embedding = %s::vector WHERE id = %s",
                    (vector_literal, row["id"]),
                )
            updated += 1

        connection.commit()

    print(f"Embedded {updated} adapter_versions using model {EMBEDDING_MODEL}")


if __name__ == "__main__":
    main()
