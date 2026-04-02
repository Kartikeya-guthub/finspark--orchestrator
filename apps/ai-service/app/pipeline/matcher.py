import hashlib
import json
import math
import os
import re
from typing import Any

import httpx
from psycopg import Connection


def _local_embedding(text: str, dimensions: int = 256) -> list[float]:
    vector = [0.0] * dimensions
    tokens = re.findall(r"[a-z0-9]+", text.lower())

    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        index = int.from_bytes(digest[:4], "big") % dimensions
        sign = 1.0 if digest[4] % 2 else -1.0
        magnitude = int.from_bytes(digest[5:9], "big") / 2**32
        vector[index] += sign * (0.25 + magnitude)

    norm = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / norm for value in vector]


def cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or not right:
        return 0.0
    length = min(len(left), len(right))
    dot = sum(left[index] * right[index] for index in range(length))
    left_norm = math.sqrt(sum(value * value for value in left[:length])) or 1.0
    right_norm = math.sqrt(sum(value * value for value in right[:length])) or 1.0
    return dot / (left_norm * right_norm)


def _parse_embedding_response(data: dict[str, Any]) -> list[float]:
    if isinstance(data.get("data"), list) and data["data"]:
        first = data["data"][0]
        if isinstance(first, dict) and isinstance(first.get("embedding"), list):
            return [float(value) for value in first["embedding"]]
    if isinstance(data.get("embedding"), list):
        return [float(value) for value in data["embedding"]]
    raise ValueError("Embedding response did not contain a vector")


def embed_text(text: str, input_type: str = "query") -> list[float]:
    api_key = os.getenv("NVIDIA_EMBEDDINGS_API_KEY") or os.getenv("NVIDIA_API_KEY", "")
    api_key = api_key.strip()
    if not api_key:
        return _local_embedding(text)

    endpoint = os.getenv("NVIDIA_EMBEDDINGS_ENDPOINT", "https://integrate.api.nvidia.com/v1/embeddings")
    model = os.getenv("NVIDIA_EMBEDDINGS_MODEL", "nvidia/llama-3.2-nv-embedqa-1b-v2")

    try:
        with httpx.Client(timeout=60.0) as client:
            response = client.post(
                endpoint,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={"model": model, "input": text, "input_type": input_type},
            )
            response.raise_for_status()
            return _parse_embedding_response(response.json())
    except Exception:
        return _local_embedding(text)


def _get_latest_adapter_versions(conn: Connection[Any], category: str, provider_hint: str | None = None) -> list[dict[str, Any]]:
    params: list[Any] = [category]
    provider_clause = ""
    if provider_hint:
        provider_clause = "AND a.provider ILIKE %s"
        params.append(f"%{provider_hint}%")

    query = f"""
        SELECT
          a.id,
          a.name,
          a.category,
          a.provider,
          a.description,
          a.capability_tags,
          a.auth_type,
          ae.embedding,
          av.id AS selected_version_id,
          av.api_version,
          av.schema_def,
          av.lifecycle_status
        FROM adapters a
        LEFT JOIN adapter_embeddings ae ON ae.adapter_id = a.id
        LEFT JOIN LATERAL (
          SELECT id, api_version, schema_def, lifecycle_status
          FROM adapter_versions
          WHERE adapter_id = a.id
          ORDER BY CASE WHEN lifecycle_status = 'active' THEN 0 ELSE 1 END, api_version DESC
          LIMIT 1
        ) av ON TRUE
        WHERE a.category = %s
        {provider_clause}
        ORDER BY a.name
    """
    with conn.cursor() as cur:
        cur.execute(query, params)
        rows = cur.fetchall()
    return list(rows)


def _rerank_candidates(requirement_sentence: str, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    api_key = os.getenv("NVIDIA_RERANK_API_KEY") or os.getenv("NVIDIA_API_KEY", "")
    api_key = api_key.strip()
    if not api_key or not candidates:
        return candidates

    endpoint = os.getenv("NVIDIA_RERANK_ENDPOINT", "https://ai.api.nvidia.com/v1/retrieval/nvidia/reranking")
    model = os.getenv("NVIDIA_RERANK_MODEL", "nvidia/rerank-qa-mistral-4b")
    passages = [
        {
            "text": f"{candidate['name']}: {candidate['description']} supports {candidate['capability_tags']}"
        }
        for candidate in candidates
    ]

    try:
        with httpx.Client(timeout=60.0) as client:
            response = client.post(
                endpoint,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={"model": model, "query": requirement_sentence, "passages": passages},
            )
            response.raise_for_status()
            data = response.json()
    except Exception:
        return candidates

    rankings = data.get("rankings") or data.get("results") or data.get("data") or []
    order: list[int] = []
    for index, item in enumerate(rankings):
        if isinstance(item, dict):
            candidate_index = item.get("index", item.get("document_index", item.get("position", index)))
        else:
            candidate_index = index
        try:
            candidate_index = int(candidate_index)
        except (TypeError, ValueError):
            continue
        if 0 <= candidate_index < len(candidates):
            order.append(candidate_index)

    if not order:
        return candidates

    seen = set(order)
    for index in range(len(candidates)):
        if index not in seen:
            order.append(index)

    return [candidates[index] for index in order]


def match_adapters(conn: Connection[Any], requirement: dict[str, Any]) -> list[dict[str, Any]]:
    category = str(requirement.get("service_type", "")).strip()
    provider_hint = requirement.get("provider_hint")
    source_sentence = str(requirement.get("source_sentence", ""))

    exact_candidates = _get_latest_adapter_versions(conn, category, provider_hint)
    if len(exact_candidates) == 1:
        exact = dict(exact_candidates[0])
        exact["match_confidence"] = 1.0
        exact["match_method"] = "exact"
        exact["match_explanation"] = f"Direct category/provider match on '{category}'"
        return [exact]

    semantic_candidates = _get_latest_adapter_versions(conn, category)
    if not semantic_candidates:
        return []

    requirement_embedding = embed_text(source_sentence, "query")
    scored: list[dict[str, Any]] = []
    for candidate in semantic_candidates:
        candidate_embedding = candidate.get("embedding") or _local_embedding(
            f"{candidate['name']} {candidate['description']} {' '.join(candidate['capability_tags'] or [])}",
            256,
        )
        similarity = cosine_similarity(requirement_embedding, [float(value) for value in candidate_embedding])
        scored.append({**candidate, "similarity": similarity})

    top_candidates = sorted(scored, key=lambda item: item["similarity"], reverse=True)[:5]
    reranked = _rerank_candidates(source_sentence, top_candidates)

    matched: list[dict[str, Any]] = []
    top_count = max(len(reranked) - 1, 1)
    for index, candidate in enumerate(reranked):
        rerank_bonus = 1.0 - (index / top_count)
        match_confidence = round((candidate["similarity"] * 0.7) + (rerank_bonus * 0.3), 4)
        matched.append(
            {
                **candidate,
                "match_confidence": match_confidence,
                "match_method": "semantic+rerank",
                "match_explanation": (
                    f"Matched on semantic similarity to '{source_sentence}' in adapter capability description."
                ),
            }
        )

    return matched
