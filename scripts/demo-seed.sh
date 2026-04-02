#!/usr/bin/env bash
set -euo pipefail

npm run seed
node scripts/demo-seed.mjs

echo "Demo seed complete."
