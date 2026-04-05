# Phase 8 Simulation Engine Report

## Scope Completed

Phase 8 implemented a three-level simulation framework in `apps/simulator` with schema validation, DAG execution, AI-generated mock responses, and persisted run traces.

1. Created simulator service in `apps/simulator` using Fastify + Postgres.
2. Added `POST /api/simulate/:config_version_id` to execute simulation runs.
3. Implemented Level 1 static schema validation (`validateSchema`).
4. Implemented DAG traversal and execution trace generator (`runMockSimulation`).
5. Integrated NVIDIA Mistral chat endpoint for realistic mock response generation.
6. Implemented upstream-failure skip behavior for downstream DAG nodes.
7. Added persistence to `simulation_runs` table with final JSON results and status.
8. Added `GET /api/simulations/:id` for run retrieval.
9. Added CLI port support (`npm run dev -- --port 8003`).

## Files Added / Updated

- `apps/simulator/package.json`
- `apps/simulator/tsconfig.json`
- `apps/simulator/src/index.ts`

## Implementation Details

### 1) Simulator Service Setup

- Service stack: Fastify + `pg` + `axios`.
- DB connection: same `DATABASE_URL` as other services.
- Main route:
  - `POST /api/simulate/:config_version_id`
- Utility route:
  - `GET /api/simulations/:id`
- Startup ensures persistence table exists:
  - `simulation_runs`

### 2) Level 1 Schema Validation

Function: `validateSchema(config, adapterVersions)`

- For each DAG node, loads adapter `request_schema`.
- Computes required fields from:
  - `request_schema.required` (preferred)
  - fallback to request schema property keys.
- Compares required target fields against `config.field_mappings`.
- Emits `ERROR` issues when required adapter fields are unmapped.

### 3) Level 3 Mock Simulation (AI-Powered)

Function: `runMockSimulation(config, adapterVersions)`

- Performs deterministic topological DAG walk (`topoSort`) using edges.
- Builds per-node input payload from `field_mappings`.
- Calls NVIDIA Mistral endpoint to generate realistic mock JSON output for each node response schema.
- Records trace per node:
  - input
  - output
  - status (`success` | `failed` | `skipped`)
  - latency (randomized 50ms-200ms)
- If any node fails, downstream nodes are marked `skipped`.

### 4) Persistence

- Inserts completed runs into `simulation_runs`:
  - `tenant_id`
  - `config_version_id`
  - `status`
  - `result_json`
  - timestamps

## Verification Steps Executed

1. Installed simulator dependencies:
   - `cd apps/simulator && npm install fastify pg axios`
2. Started simulator:
   - `npm --workspace @finspark/simulator run dev -- --port 8003`
3. Triggered simulation using latest config version from Phase 7:
   - `POST http://127.0.0.1:8003/api/simulate/aadd12fb-37ed-4edc-9643-bd493994ee6a`
4. Fetched persisted run:
   - `GET http://127.0.0.1:8003/api/simulations/198a9c7c-46c0-4684-9eb5-906aa4e8a1d7`
5. Queried `simulation_runs` in Postgres for final confirmation.

## Live Result Snapshot

- `config_version_id`: `aadd12fb-37ed-4edc-9643-bd493994ee6a`
- `simulation_run_id`: `198a9c7c-46c0-4684-9eb5-906aa4e8a1d7`
- Run status: `completed`
- Trace steps: `4`
- Summary:
  - `success_count: 4`
  - `failed_count: 0`
  - `skipped_count: 0`

### Believable Bureau/CIBIL Mock Output

From BUREAU trace step:

```json
{
  "data": {
    "pan": "ABCDE1234F",
    "name": "Ravi Kumar",
    "consent": true,
    "credit_score": 742
  },
  "status": "SUCCESS"
}
```

This confirms realistic AI-generated simulation output (credit score is numeric and believable, not a placeholder string).

## Outcome

Phase 8 simulator is live and working end-to-end:

- Static schema validation is enforced.
- Dynamic DAG dry-run executes with AI-driven mock outputs.
- Per-node trace and summary are persisted in `simulation_runs`.
- Bureau simulation includes realistic CIBIL-like score (`742`).
