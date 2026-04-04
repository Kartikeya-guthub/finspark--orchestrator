# Finspark Live System Verification Report
Date: April 4, 2026
Mode: Real service and HTTP endpoint verification (not DB-only)

## Scope executed from runtime
- Started and used real services:
  - API: http://localhost:8000
  - AI service: http://localhost:8002
  - Simulator: http://localhost:8003
  - Web UI (Vite): http://localhost:3000
- Used live API calls with tenant auth.
- Uploaded real text documents through multipart endpoint.
- Polled parse status progression.
- Verified requirements extraction output, config generation, approval transition, simulation modes, and audit trail.

## Critical fixes applied during live test
1. Structured PII hard-fail without NVIDIA key
- File: apps/ai-service/app/pipeline/pii.py
- Fix: when NVIDIA_API_KEY is missing, structured redaction now falls back to regex redaction instead of raising RuntimeError.
- Result: pipeline no longer crashes at structured redaction due to missing NVIDIA key.

2. Config versions endpoint SQL bug
- File: apps/api/src/index.ts
- Fix: changed json_array_length(tcv.match_results) to jsonb_array_length(tcv.match_results).
- Result: GET /api/tenants/:tenantId/config/versions now returns 200 instead of 500.

3. Migration 009 parser failure (BOM issue)
- File: infra/postgres/migrations/009_fix_simulation_mode_constraint.sql
- Fix: rewrote file as UTF-8 without BOM.
- Result: npm run migrate successfully applied migration 009.

4. Missing approval columns in DB schema
- Action: ran migrations; migration 008 applied and added approvals scope/approver_id columns expected by API.
- Result: POST /api/configs/:versionId/approve moved from 500 to success.

## Health and infrastructure status
- API health: 200 at /health on port 8000
- AI health: 200 at /health on port 8002
- Simulator health: 200 at /health on port 8003
- Web UI: HTML served on port 3000 (Vite dev page, title Finspark Web)
- pgvector: installed and verified
  - extname=vector, version=0.8.2

## Live tenant + document test evidence
Tenant created via bootstrap:
- tenant_id: f5f2106e-81f3-4f0f-bf46-027bd4e76008

Documents uploaded via live API:
- 99828520-867d-4bf5-b52a-aaeaa4ad0114 -> status uploaded (older run before fix)
- b83daabe-064c-4e50-aff3-41e965dfab51 -> status structure_extracted (older run before fix completion)
- 2a7e1931-6f63-479e-a638-5e16b141d5b5 -> status config_generated (successful end-to-end run)

Observed successful progression in fixed path:
- uploaded -> structure_extracted -> config_generated
- Requirements for successful live document: count=3
- Source sentence null count: 0
- Example requirements include masked PII in source text.

## Config generation and approval verification
- Config versions endpoint returned:
  - version 2, status pending_review, source_document_id=2a7e1931-6f63-479e-a638-5e16b141d5b5, match_count=3
- Approval call succeeded:
  - POST /api/configs/d07355e4-5126-4f97-83f5-9d6a73799ac7/approve
  - Response: status approved, all_approved true
- Status confirmed after approval:
  - approved

## Simulation verification
Executed through API endpoint /api/simulations/run against approved version:
- Schema mode: completed, valid=true, checked_nodes=3
- Mock success mode: completed, executed_nodes=3, realistic numeric fields present (example score 742)
- Mock partial_failure mode: completed, per-node errors returned as expected
- Dryrun mode: completed, executed_nodes=3 with dryrun_result ok traces
- Simulations persisted:
  - /api/simulations returned 5 completed runs for this tenant

## Audit trail verification
- /api/audit/:tenantId returned 23 events for live tenant.
- Includes key actions from live flow:
  - pii_redaction
  - structure_extraction
  - pii_redaction_structured
  - full_pipeline_executed
  - approved
  - simulation_run_completed

## Remaining issues and gaps
1. NVIDIA API key not configured in environment
- Check result: NVIDIA_API_KEY_MISSING
- Current behavior: pipeline works with regex fallback, but true NVIDIA-backed structured PII/LLM path is not validated in this run.

2. Legacy documents in older tenant history
- Some previously uploaded docs from pre-fix runs remain in non-final states.
- Mitigation: use a clean tenant for demo flow.

3. Clean tenant verification now passes DAG dependency expectation
- Clean tenant run result:
  - tenant_id: 5eb09188-1c7e-4ac1-8b08-30e90c1fbd83
  - document_id: 78f0df1e-8c64-458a-a544-5a4f5ec71c12
  - config_version_id: ec2c14f6-a396-4f6f-ba9a-e820cab79259
  - status progression: uploaded -> config_generated
  - dag_nodes=4
  - dag_edges=3

4. Script/port consistency implemented
- Added scripts for real runtime ports:
  - npm run health:check
  - npm run demo:run
  - npm run demo:ready:check
- Runtime ports used consistently: API 8000, AI 8002, Simulator 8003, Web 3000.

## Honest final status
What is now genuinely verified live:
- Services start and answer health endpoints
- Auth/bootstrap works
- Real upload endpoint works
- Pipeline can reach config_generated on live document
- Requirements are produced with non-null source_sentence
- Config approval path works after schema/migration fixes
- Schema/mock/dryrun simulations run and persist
- Audit trail captures live flow events
- pgvector is installed

What is still not fully verified for final demo confidence:
- NVIDIA-backed extraction path with a valid API key
- Legacy pre-fix docs in old tenant history (mitigated by clean tenant demo path)

## Recommended next actions before demo
1. Set NVIDIA_API_KEY in runtime env and rerun one full document to confirm real model path.
2. Keep using the clean tenant IDs from this report for demo narrative/evidence.
3. Optionally archive or ignore old pre-fix tenant records to avoid confusion during judging.
4. Keep using the runtime port scripts (health:check, demo:run, demo:ready:check) as the only demo entrypoints.

---
Report artifact generated from live API/simulator/AI calls and runtime logs, not from static DB counts only.
