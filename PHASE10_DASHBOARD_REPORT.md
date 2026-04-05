# Phase 10 Master Demo Dashboard Report

## Scope Completed

Phase 10 turned the backend pipeline into a single-page Golden Path demo dashboard.

1. Built a React + Tailwind frontend in `apps/web`.
2. Added a dashboard API client for the API and simulator services.
3. Implemented a four-column story flow:
   - Intake
   - Intelligence
   - Governance
   - Execution
4. Added upload handling and polling for `parse_status = config_generated`.
5. Displayed redacted text, requirements, matched adapters, explanations, config diff, approvals, simulation traces, and audit events.
6. Added a terminal-style execution trace panel with believable CIBIL output.
7. Added a root demo reset script for the full dress rehearsal.
8. Added a Windows PowerShell wrapper for the same reset flow.

## Files Added / Updated

- `apps/web/package.json`
- `apps/web/index.html`
- `apps/web/vite.config.ts`
- `apps/web/tsconfig.json`
- `apps/web/postcss.config.js`
- `apps/web/tailwind.config.js`
- `apps/web/src/main.tsx`
- `apps/web/src/index.css`
- `apps/web/src/api.ts`
- `apps/web/src/Dashboard.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/vite-env.d.ts`
- `scripts/run-demo.sh`
- `scripts/run-demo.ps1`
- `scripts/reset-demo-db.mjs`
- `scripts/bootstrap-demo-tenant.mjs`
- `package.json` (demo script updated to point at `scripts/run-demo.sh`)
- `apps/api/index.ts` (document polling route)

## Implementation Details

### 1) Dashboard UI

File: `apps/web/src/Dashboard.tsx`

- Intake column:
  - file upload zone
  - redacted text preview
  - status badge and refresh control
- Intelligence column:
  - requirements list
  - matched adapter and explanation
- Governance column:
  - config diff view
  - engineer and architect approval buttons
- Execution column:
  - run simulation button
  - terminal-style trace output
  - CIBIL score callout
- Audit sidebar:
  - last 50 audit events
  - timestamped compliance timeline

### 2) API Client

File: `apps/web/src/api.ts`

- Connects to:
  - API: `http://localhost:8000` by default
  - Simulator: `http://localhost:8003` by default
- Supports:
  - bootstrap tenant
  - upload document
  - poll document status
  - fetch requirements
  - fetch latest config
  - fetch diff
  - approve config
  - run simulation
  - fetch audit trail

### 3) Demo Reset Scripts

- `scripts/run-demo.sh`
- `scripts/run-demo.ps1`
- `scripts/reset-demo-db.mjs`
- `scripts/bootstrap-demo-tenant.mjs`

Reset flow:

1. Clear the database.
2. Seed the adapter registry.
3. Bootstrap `DemoBank`.
4. Print the final ready message.

## Verification

### Static validation

- `apps/api/index.ts`: no errors
- `apps/web/src/Dashboard.tsx`: no errors
- `apps/web/src/api.ts`: no errors
- `apps/web/src/main.tsx`: no errors
- `apps/web/src/App.tsx`: no errors

### Runtime verification

- React frontend started successfully at `http://localhost:3000`.
- The dashboard bundle launched through Vite after installing the missing React plugin dependency.

## Notes

- The requested bash reset script was created as `scripts/run-demo.sh`.
- Because this Windows runtime did not have `bash` available, a PowerShell wrapper was also added for local use.
- The dashboard is wired to the live backend endpoints and includes the compliance story the judges need to see.

## Outcome

Phase 10 is in place and ready for the final demo flow:

- Upload on the far left
- Redaction and intent matching in the middle
- Approvals and diffs in governance
- Simulation trace and CIBIL score on the right
- Audit sidebar showing the compliance timeline
