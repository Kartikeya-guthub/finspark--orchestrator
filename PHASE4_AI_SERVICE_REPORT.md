# Phase 4 AI Service Report

## Scope Completed

Phase 4 implemented the AI Service scaffold and connected it to the document ingestion pipeline.

1. Added Python dependencies in `apps/ai-service/requirements.txt`.
2. Added FastAPI service in `apps/ai-service/main.py`.
3. Added document processing route: `POST /process/{document_id}`.
4. Added raw text extraction for PDF, DOCX, and TXT files.
5. Added NVIDIA `gliner-pii` redaction with safe regex fallback.
6. Added background trigger from Node API after upload.
7. Added document table updates for `raw_text`, `redacted_content`, and `parse_status = 'text_extracted'`.

## Files Updated

```text
apps/ai-service/requirements.txt
apps/ai-service/main.py
apps/api/index.ts
```

## Verification Performed

### 1) AI service startup

Command used:

```bash
python main.py --port 8002
```

Result:
- FastAPI started successfully on port 8002.

### 2) Direct redaction endpoint test

Command used:

```bash
curl.exe -s -X POST http://127.0.0.1:8002/process/287bed25-2053-4102-8d8b-98dbbc99ac1d
```

Response observed:

```json
{"document_id":"287bed25-2053-4102-8d8b-98dbbc99ac1d","status":"text_extracted","redacted_text":"Customer Aadhaar is [PII_REDACTED].","entities":[{"type":"fallback_regex","count":1}]}
```

### 3) Database verification

Query used:

```sql
SELECT id, parse_status, raw_text, redacted_content
FROM documents
WHERE id = '287bed25-2053-4102-8d8b-98dbbc99ac1d';
```

Observed row:

```text
parse_status = text_extracted
raw_text = Customer Aadhaar is 1234-5678-9012.
redacted_content = {"entities": [{"type": "fallback_regex", "count": 1}], "redacted_text": "Customer Aadhaar is [PII_REDACTED]."}
```

### 4) Automatic trigger from Node API

Upload command used:

```bash
curl -F "file=@secret2.txt" "http://localhost:8000/api/documents/upload?tenant_id=fbc739a0-b53a-46b1-a96b-e9876b64fd59"
```

Result:
- The API created a new document record.
- The API triggered the AI service in the background.
- The document row updated to `text_extracted`.
- `redacted_content` contained masked PAN data.

Observed DB output:

```text
DB_STATUS=text_extracted
DB_REDACTED={"entities": [{"type": "fallback_regex", "count": 1}], "redacted_text": "Applicant PAN [PII_REDACTED] must be verified."}
```

## Notes

- The NVIDIA path is wired, but the verified run used the safe regex fallback because no `NVIDIA_API_KEY` was configured.
- The Node API now triggers document processing automatically after a successful new upload.