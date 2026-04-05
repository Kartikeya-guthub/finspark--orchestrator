# Phase 6 Semantic Adapter Matching Report

## Scope Completed

Phase 6 implemented semantic matchmaking between extracted requirements and adapter versions using pgvector and NVIDIA embeddings.

1. Added registry embedding script `scripts/embed_adapters.py`.
2. Implemented adapter search-string generation from adapter name, category, and request schema keys.
3. Integrated NVIDIA embedding calls (model: `nvidia/llama-3.2-nv-embedqa-1b-v2`) with `input_type="passage"` for registry data.
4. Added requirement-to-adapter semantic matching logic in `apps/ai-service/main.py`.
5. Added runtime requirement columns: `matched_adapter_version_id` and `match_explanation`.
6. Added pgvector nearest-neighbor query: `ORDER BY embedding <=> %s::vector LIMIT 1`.
7. Integrated matching execution immediately after extraction in `POST /process/{document_id}`.
8. Updated requirements API output to include semantic match fields.

## Files Updated

```text
scripts/embed_adapters.py
apps/ai-service/main.py
apps/api/index.ts
.env.example
```

## Environment Variables Required

No secrets were hardcoded.

```text
DATABASE_URL
EXTRACTION_API_KEY
EXTRACTION_BASE_URL
EXTRACTION_MODEL
EMBEDDING_API_KEY
EMBEDDING_ENDPOINT
EMBEDDING_MODEL
GLINER_API_KEY
GLINER_BASE_URL
GLINER_MODEL
```

## Implementation Details

### 1) Registry Embedding Script

File: `scripts/embed_adapters.py`

- Loads adapter versions joined with adapters from Postgres.
- Builds search string per row:
  - adapter name
  - category
  - request_schema top-level keys
- Calls embedding endpoint using `input_type="passage"`.
- Writes embedding vectors to `adapter_versions.embedding` as pgvector literals.

### 2) Matchmaking Logic in AI Service

File: `apps/ai-service/main.py`

- Added `generate_embedding(text, input_type)` for embedding calls.
- Added `match_requirements_to_adapters(connection, document_id)`:
  - Reads requirements for the document.
  - Embeds each `source_sentence` with `input_type="query"`.
  - Finds nearest adapter version using pgvector distance.
  - Updates `matched_adapter_version_id` and `match_explanation`.
- Matching is triggered right after requirement extraction and persistence.

### 3) API Surface Update

File: `apps/api/index.ts`

- Updated `GET /api/documents/:id/requirements` to return:
  - `matched_adapter_version_id`
  - `match_explanation`

## Validation Status

### Static validation

- `apps/ai-service/main.py`: no errors
- `apps/api/index.ts`: no errors
- `scripts/embed_adapters.py`: no errors

### External API status used for Phase 6

- GLiNER model endpoint: reachable (`HTTP 200` in latest checks)
- Extraction model endpoint (`mistralai/mistral-small-3.1-24b-instruct-2503`): reachable (`HTTP 200` in latest checks)

## Notes

- GLiNER logic was left unchanged, per request.
- `.env.example` now includes explicit placeholders for extraction and embedding credentials/URLs.
- Semantic match explanations are stored with each requirement to support enterprise traceability.
