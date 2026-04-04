#!/usr/bin/env bash
set -euo pipefail

echo "=== FINSPARK HEALTH CHECK ==="

check() {
  local name="$1"
  local url="$2"
  if curl -sf "$url" > /dev/null; then
    echo "[OK] $name: $url"
  else
    echo "[FAIL] $name: $url"
    return 1
  fi
}

check "API" "http://localhost:8000/health"
check "AI" "http://localhost:8002/health"
check "Simulator" "http://localhost:8003/health"
check "Web" "http://localhost:3000"

echo "=== HEALTH CHECK PASSED ==="
