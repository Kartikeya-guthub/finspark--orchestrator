# Finspark Orchestrator

## Phase 1 Scope Statement

This repository is locked to **Phase 1 only**: monorepo scaffolding, technology decisions, baseline infrastructure, and health endpoints.

No product features are included in this phase.

## Stack Lock (Phase 1)

- Monorepo: npm workspaces
- Web app: React + Tailwind CSS
- API app: Node.js + Fastify
- AI service: Python + FastAPI
- Simulator: Node.js
- Shared package: TypeScript + Zod
- Config package: TypeScript env loader + vault pattern abstraction
- Infrastructure: Docker Compose with Postgres, Redis, MinIO

## Repository Layout

- apps/web: React + Tailwind stub with health endpoint script
- apps/api: Fastify service with /health
- apps/ai-service: FastAPI service with /health
- apps/simulator: Node service with /health
- packages/shared: TS types, Zod schemas, constants
- packages/config: env loader and vault abstraction
- infra/docker: Docker-related files
- infra/postgres/migrations: SQL migrations location
- scripts: seed/reset/demo script placeholders
- docs: project documentation

## Phase 1 Outcome Contract

1. `docker compose up` starts Postgres, Redis, and MinIO.
2. Infrastructure containers expose passing health checks.
3. All four apps define a `/health` endpoint returning `{ "status": "ok" }`.
4. No business workflows are implemented yet.

## Getting Started

1. Copy `.env.example` to `.env`.
2. Start infrastructure:
   - `docker compose up`
3. Start each app separately when needed.

## Non-Goals for Phase 1

- Tenant workflows
- Orchestration DAG execution
- Adapter logic
- Requirement processing
- Simulation logic
- UI features
