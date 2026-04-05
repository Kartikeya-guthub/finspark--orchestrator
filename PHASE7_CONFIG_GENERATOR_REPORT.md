# Phase 7 Configuration & DAG Generator Report

## Scope Completed

Phase 7 implemented production-ready config generation from matched requirements, including AI field mappings, deterministic DAG construction, and versioned tenant config output.

1. Added `MAPPING_PROMPT` to produce strict JSON `field_mappings`.
2. Added AI mapping generation that takes:
   - requirement context,
   - inferred bank fields,
   - matched adapter request schema.
3. Added deterministic DAG builder `build_execution_dag(document_id, tenant_id)`.
4. Ensured deterministic edge creation for dependency chains (`depends_on`) using alias resolution (for example `req_kyc_id` -> KYC node).
5. Consolidated output into a single `config_json` object containing:
   - `field_mappings`
   - `dag.nodes`
   - `dag.edges`
6. Versioned config creation in `tenant_config_versions` with status `draft`.
7. Updated `tenant_configs.current_version_id` to latest generated version.
8. Updated `documents.parse_status` to `config_generated`.
9. Added API route `GET /api/tenants/:id/config/latest`.

## Files Updated

- `apps/ai-service/main.py`
- `apps/api/index.ts`

## Implementation Details

### 1) Mapping Prompt & Mapping Logic (AI Service)

File: `apps/ai-service/main.py`

- Added `MAPPING_PROMPT` for strict JSON output:
  - `source_field`
  - `target_field`
  - `confidence`
- Added helpers:
  - `call_chat_completion(...)`
  - `infer_bank_fields(...)`
  - `extract_schema_fields(...)`
  - `generate_field_mappings(...)`
- Mapping generation behavior:
  - Uses live extraction model endpoint and credentials from env.
  - Parses model output from JSON/fenced JSON.
  - Falls back to deterministic mapping only when AI mapping fails.

### 2) Deterministic DAG Builder

File: `apps/ai-service/main.py`

- Added `build_execution_dag(connection, document_id, tenant_id)`.
- Deterministic pass 1:
  - Creates one `dag_nodes` row per matched requirement in stable order.
  - Creates `field_mappings` rows for each requirement.
- Deterministic pass 2:
  - Creates `dag_edges` from `depends_on` using a strict loop.
  - Resolves dependency aliases (`req_kyc_id`, `req_bureau_id`, `req_fraud_id`) to generated node IDs.
- Consolidates all nodes, edges, and mappings into `config_json`.

### 3) Versioned Config Output

File: `apps/ai-service/main.py`

- Creates/increments `tenant_config_versions.version_number`.
- Persists `config_json` and sets `status='draft'`.
- Updates `tenant_configs.current_version_id` to latest version.
- Updates `documents.parse_status='config_generated'`.

### 4) API Update

File: `apps/api/index.ts`

- Added `GET /api/tenants/:id/config/latest`.
- Returns latest config version for a tenant:
  - `id`
  - `tenant_config_id`
  - `version_number`
  - `config_json`
  - `status`

## Live Verification (Completed)

Services used for verification:

- API: `http://127.0.0.1:8010`
- AI service: `http://127.0.0.1:8011`

Verification flow executed:

1. `python scripts/embed_adapters.py`
2. Uploaded multi-step BRD `test_dag_flow.txt`:
   - KYC -> Bureau -> Fraud -> Payment
3. Processed document via AI service `POST /process/{document_id}`
4. Queried latest config via API `GET /api/tenants/:id/config/latest`
5. Verified DB counters (`dag_nodes`, `dag_edges`, `field_mappings`) and `documents.parse_status`

### Result Snapshot

- `process` status: `config_generated`
- Latest config version: `version_number=3`
- `documents.parse_status`: `config_generated`
- DAG nodes: `4`
- DAG edges: `3`
- Field mappings stored: `7`
- API `/api/tenants/:id/config/latest`: `HTTP 200`

### Example verified edges

- `req_2` depends on `req_kyc_id` -> edge KYC -> Bureau
- `req_3` depends on `req_bureau_id` -> edge Bureau -> Fraud
- `req_4` depends on `req_fraud_id` -> edge Fraud -> Payment

### Example verified mappings

- `applicant_aadhaar` -> `aadhaar_no`
- `applicant_pan` -> `pan`
- `applicant_name` -> `name`
- `beneficiary_account` -> `account_no`
- `ifsc_code` -> `ifsc`
- `amount` -> `amount`

## Outcome

Phase 7 is live and functioning end-to-end:

- Requirements are transformed into versioned, draft tenant configuration.
- Field mappings are generated with AI against matched adapter schemas.
- Deterministic DAG now creates the expected dependency edges (no 0-edge bug for chained requirements).
- Latest config is retrievable via API for downstream simulation and governance workflows.
