#!/usr/bin/env bash
set -euo pipefail

docker compose down -v
docker compose up -d
sleep 10
npm run migrate
npm run demo:seed

echo "Demo reset complete."
