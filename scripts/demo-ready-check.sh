#!/usr/bin/env bash
set -euo pipefail

echo "=== FINSPARK DEMO READINESS CHECK ==="
echo

echo "--- SERVICES ---"
curl -sf http://localhost:8000/health > /dev/null && echo "OK API 8000" || echo "FAIL API 8000"
curl -sf http://localhost:8002/health > /dev/null && echo "OK AI 8002" || echo "FAIL AI 8002"
curl -sf http://localhost:8003/health > /dev/null && echo "OK Simulator 8003" || echo "FAIL Simulator 8003"
curl -sf http://localhost:3000 > /dev/null && echo "OK Web 3000" || echo "FAIL Web 3000"
echo

echo "--- PGVECTOR ---"
if docker exec finspark-postgres psql -U finspark -d finspark -t -c "SELECT extname FROM pg_extension WHERE extname='vector';" | grep -q vector; then
  echo "OK pgvector installed"
else
  echo "FAIL pgvector missing"
fi
echo

echo "--- NVIDIA API KEY ---"
if [[ -z "${NVIDIA_API_KEY:-}" ]]; then
  echo "WARN NVIDIA_API_KEY not set (fallback mode)"
else
  NVIDIA_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    https://integrate.api.nvidia.com/v1/chat/completions \
    -H "Authorization: Bearer $NVIDIA_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"model":"mistralai/mistral-small-3.1-24b-instruct-2503","messages":[{"role":"user","content":"ok"}],"max_tokens":3}')

  if [[ "$NVIDIA_STATUS" == "200" ]]; then
    echo "OK NVIDIA API key valid"
  else
    echo "WARN NVIDIA API key status: $NVIDIA_STATUS"
  fi
fi
echo

echo "--- CLEAN TENANT FLOW CHECK ---"
TENANT_NAME="DemoCheck-$(date +%Y%m%d%H%M%S)"
BOOTSTRAP_PAYLOAD=$(jq -nc --arg name "$TENANT_NAME" '{tenant_name:$name,created_by:"demo-ready-check"}')
BOOTSTRAP_RESP=$(curl -s -X POST http://localhost:8000/api/tenants/bootstrap -H "Content-Type: application/json" -d "$BOOTSTRAP_PAYLOAD")
API_KEY=$(echo "$BOOTSTRAP_RESP" | jq -r '.credentials.api_key')
TENANT_ID=$(echo "$BOOTSTRAP_RESP" | jq -r '.tenant.id')

if [[ -z "$API_KEY" || "$API_KEY" == "null" ]]; then
  echo "FAIL tenant bootstrap"
  exit 1
fi

echo "OK tenant bootstrap ($TENANT_ID)"

VERSIONS=$(curl -s "http://localhost:8000/api/tenants/$TENANT_ID/config/versions" -H "x-api-key: $API_KEY")
COUNT=$(echo "$VERSIONS" | jq '.count')
echo "Config versions: $COUNT"

echo "=== DONE ==="
