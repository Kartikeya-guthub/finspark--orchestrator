# Phase 5 Requirement Extraction Report

## Scope Completed

Phase 5 implemented the Requirement Extraction engine and connected it to document processing after redaction.

1. Added an `EXTRACTION_PROMPT` in `apps/ai-service/main.py` for enterprise integration requirement extraction.
2. Added extraction execution after redaction in `POST /process/{document_id}`.
3. Implemented AI-first extraction with strict fallback to a Golden Flow (`KYC -> Bureau -> Fraud -> Payment`).
4. Added requirement persistence into the `requirements` table.
5. Updated document `parse_status` to `requirements_extracted` on successful phase completion.
6. Added API route `GET /api/documents/:id/requirements` in `apps/api/index.ts`.
7. Integrated extraction API call style using `requests.post(...)` to NVIDIA OpenAI-compatible chat completions endpoint.

## Files Updated

```text
apps/ai-service/main.py
apps/ai-service/requirements.txt
apps/api/index.ts
.env.example
```

## Environment Variables Required

No secrets were hardcoded.

```text
GLINER_API_KEY
GLINER_BASE_URL
GLINER_MODEL
EXTRACTION_API_KEY
EXTRACTION_BASE_URL
EXTRACTION_MODEL
```

## Verification Performed

### 1) GLiNER API check

Check method:
- Direct POST to `https://integrate.api.nvidia.com/v1/chat/completions`
- Model: `nvidia/gliner-pii`

Observed result:
- `HTTP 200`
- Returned entity detection payload for Aadhaar-like identifier.

### 2) Extraction model API check

Check method:
- Direct POST to `https://integrate.api.nvidia.com/v1/chat/completions`
- Working model: `mistralai/mistral-small-3.1-24b-instruct-2503`

Observed result:
- `HTTP 200`
- Returned completion content for extraction prompt.

### 3) Endpoint behavior notes from live checks

- `422` occurred when unsupported parameters were sent in payload (`top_p`, `frequency_penalty`, `presence_penalty`) for the tested GLiNER request shape.
- `404` occurred when non-enabled/incorrect extraction model IDs were used.
- With minimal valid payload and the working extraction model ID, both APIs returned `200`.

## Functional Outcome

- The AI service now attempts extraction using the configured extraction endpoint/model.
- If extraction fails, times out, or JSON is invalid, the service uses deterministic stub requirements.
- Requirements are written to Postgres and exposed via `GET /api/documents/:id/requirements`.

## Demo Safety

- `extraction_method = "ai"` when live model parsing succeeds.
- `extraction_method = "stub"` when fallback is used.
- This guarantees a stable demo path even during external API instability.
