# Phase 9 Governance, Approvals, and Audit Trail Report

## Scope Completed

Phase 9 implemented governance and enterprise auditability for the orchestration flow.

1. Added centralized API audit helper `writeAuditEvent(...)`.
2. Added and initialized governance tables:
   - `audit_events`
   - `approvals`
3. Added scoped approval API:
   - `POST /api/configs/:version_id/approve`
4. Added config version diff API:
   - `GET /api/configs/:version_id/diff`
5. Added tenant audit trail API:
   - `GET /api/tenants/:id/audit`
6. Integrated audit writes across flow events:
   - Document upload (API)
   - PII redaction + requirements extraction + config generation (AI service)
   - Simulation run completion (simulator)
   - Config approvals (API)

## Files Updated

- `apps/api/index.ts`
- `apps/ai-service/main.py`
- `apps/simulator/src/index.ts`

## Implementation Details

### 1) Audit Logger

File: `apps/api/index.ts`

- Added helper:
  - `writeAuditEvent(tenantId, entityType, entityId, action, actor, data)`
- Added startup table creation:
  - `ensureGovernanceTables()` creates `audit_events` and `approvals` if missing.
- Integrated in API actions:
  - `tenant_bootstrap_existing` / `tenant_bootstrap_created`
  - `document_uploaded` / `document_upload_idempotent`
  - `config_approved`

### 2) Scoped Approval API

File: `apps/api/index.ts`

Route: `POST /api/configs/:version_id/approve`

Request body:

- `scope`: `field_mappings` | `dag` | `full`
- `role`: `engineer` | `architect`
- `comment`: string (optional)
- `actor`: string (optional)

Rules enforced:

- `engineer` can approve only `field_mappings`.
- `architect` can approve `dag` or `full`.
- On `architect + full`:
  - `tenant_config_versions.status` is updated to `approved`.

Persistence:

- Inserts approval decision into `approvals`.
- Writes `config_approved` event into `audit_events`.

### 3) Version Diff API

File: `apps/api/index.ts`

Route: `GET /api/configs/:version_id/diff`

- Compares current version against previous version (`version_number - 1`) in same `tenant_config_id`.
- Returns:
  - `added_field_mappings`
  - `removed_field_mappings`
  - `changed_dag_nodes` (added / removed / modified)

### 4) Audit Trail API

File: `apps/api/index.ts`

Route: `GET /api/tenants/:id/audit`

- Returns last 50 tenant events from `audit_events` ordered by newest timestamp.

### 5) AI and Simulator Audit Integration

Files:

- `apps/ai-service/main.py`
- `apps/simulator/src/index.ts`

Added audit writes for non-API workflow completion events:

- AI service:
  - `pii_redacted`
  - `requirements_extracted`
  - `config_generated`
- Simulator:
  - `simulation_run`

This ensures the full timeline is captured even when action originates outside API process.

## Verification (Pro Workflow)

Services used:

- API: `http://127.0.0.1:8010`
- AI service: `http://127.0.0.1:8011`
- Simulator: `http://127.0.0.1:8003`

Workflow executed:

1. Uploaded fresh BRD: `test_phase9_flow.txt`
2. Processed document via AI service (`status=config_generated`, 4 nodes, 3 edges)
3. Ran simulation for latest config version
4. Approved field mappings as engineer
5. Approved full config as architect
6. Queried config diff
7. Queried tenant audit trail

### Live Result Snapshot

- `tenant_id`: `fbc739a0-b53a-46b1-a96b-e9876b64fd59`
- `document_id`: `4b78be29-9938-4ddb-bb80-2a25c0271252`
- `config_version_id`: `0b519f2f-de58-4592-84a8-13bff20032cd`
- `simulation_run_id`: `2e44bfde-5b38-4680-83d6-2244696aa249`

Approvals:

- Engineer approval (`field_mappings`): success (`HTTP 200`)
- Architect approval (`full`): success (`HTTP 200`)
- Final config status after architect full approval: `approved`

Audit trail check:

- `GET /api/tenants/:id/audit`: `HTTP 200`
- Events found in timeline:
  - `document_uploaded`
  - `pii_redacted`
  - `requirements_extracted`
  - `config_generated`
  - `simulation_run`
  - `config_approved` (engineer)
  - `config_approved` (architect)

## Outcome

Phase 9 governance layer is live and verified:

- Scoped approvals are enforced by role and scope.
- Config status transitions to `approved` only under architect full approval.
- Version diffs are available for governance review.
- Audit events are captured with actors and timestamps across upload, AI processing, simulation, and approvals.
