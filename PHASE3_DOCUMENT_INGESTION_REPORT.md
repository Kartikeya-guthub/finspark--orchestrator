# Phase 3 Document Ingestion Report

## Scope Completed

Phase 3 implemented the Data Intake Layer in `apps/api/index.ts`:

1. MinIO integration (`localhost:9000`, `minioadmin:minioadmin`).
2. Bucket bootstrap on startup (`documents`).
3. Temporary tenant bootstrap route (`GET /api/tenants/bootstrap`) for `DemoBank`.
4. Multipart upload route (`POST /api/documents/upload`) with SHA-256 fingerprinting.
5. Idempotency check against `documents` table by `(tenant_id, fingerprint)`.
6. MinIO path convention: `tenants/{tenant_id}/{fingerprint}.pdf|.docx`.

## Files Updated

```text
apps/api/index.ts
apps/api/package.json
```

## Verification Performed

### 1) Tenant bootstrap

Request:

```bash
curl http://localhost:8000/api/tenants/bootstrap
```

Response observed:

```json
{"tenant_id":"fbc739a0-b53a-46b1-a96b-e9876b64fd59","name":"DemoBank","status":"active"}
```

### 2) Upload same file twice

Command flow used:

```bash
curl -F "file=@test-upload.pdf" "http://localhost:8000/api/documents/upload?tenant_id=fbc739a0-b53a-46b1-a96b-e9876b64fd59"
curl -F "file=@test-upload.pdf" "http://localhost:8000/api/documents/upload?tenant_id=fbc739a0-b53a-46b1-a96b-e9876b64fd59"
```

First response:

```json
{"idempotent":false,"document":{"id":"b69b010d-5dc8-4649-845b-30f71ff6908a","tenant_id":"fbc739a0-b53a-46b1-a96b-e9876b64fd59","filename":"test-upload.pdf","storage_path":"tenants/fbc739a0-b53a-46b1-a96b-e9876b64fd59/37806df04831d054fdffbb3102f68b8d7eff596c359102f3b8ce42fa10437e93.pdf","fingerprint":"37806df04831d054fdffbb3102f68b8d7eff596c359102f3b8ce42fa10437e93","parse_status":"uploaded"}}
```

Second response:

```json
{"idempotent":true,"document":{"id":"b69b010d-5dc8-4649-845b-30f71ff6908a","tenant_id":"fbc739a0-b53a-46b1-a96b-e9876b64fd59","filename":"test-upload.pdf","storage_path":"tenants/fbc739a0-b53a-46b1-a96b-e9876b64fd59/37806df04831d054fdffbb3102f68b8d7eff596c359102f3b8ce42fa10437e93.pdf","fingerprint":"37806df04831d054fdffbb3102f68b8d7eff596c359102f3b8ce42fa10437e93","parse_status":"uploaded"}}
```

Result: idempotency is working (same `document.id`, second call `idempotent: true`, no duplicate upload path).