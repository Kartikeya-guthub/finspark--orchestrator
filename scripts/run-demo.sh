#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

node scripts/reset-demo-db.mjs
npx ts-node scripts/seed-registry.ts
node scripts/bootstrap-demo-tenant.mjs

echo "READY FOR STELLARIS 2026. OPEN http://localhost:3000 TO START."