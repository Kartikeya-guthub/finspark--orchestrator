#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:8000}"

for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd"
    exit 1
  fi
done

echo "=== FINSPARK DEMO RUN ==="

TENANT_NAME="DemoRun-$(date +%Y%m%d%H%M%S)"
BOOTSTRAP_PAYLOAD=$(jq -nc --arg name "$TENANT_NAME" '{tenant_name:$name,created_by:"demo-run"}')
BOOTSTRAP_RESP=$(curl -s -X POST "$API_URL/api/tenants/bootstrap" \
  -H "Content-Type: application/json" \
  -d "$BOOTSTRAP_PAYLOAD")

API_KEY=$(echo "$BOOTSTRAP_RESP" | jq -r '.credentials.api_key')
TENANT_ID=$(echo "$BOOTSTRAP_RESP" | jq -r '.tenant.id')

if [[ -z "$API_KEY" || "$API_KEY" == "null" ]]; then
  echo "Tenant bootstrap failed"
  echo "$BOOTSTRAP_RESP"
  exit 1
fi

echo "Tenant: $TENANT_NAME ($TENANT_ID)"

WORK_FILE="$(pwd)/live_demo_input.txt"
cat > "$WORK_FILE" << 'EOF'
Customer Aadhaar 1234 5678 9012 and PAN ABCDE1234F must be verified.
Run KYC before bureau pull.
Run fraud screening after bureau.
Payment can proceed only if fraud screening passes.
EOF

UPLOAD_RESP=$(curl -s -X POST "$API_URL/api/documents/upload" \
  -H "x-api-key: $API_KEY" \
  -F "file=@$WORK_FILE")
DOC_ID=$(echo "$UPLOAD_RESP" | jq -r '.document_id')

if [[ -z "$DOC_ID" || "$DOC_ID" == "null" ]]; then
  echo "Document upload failed"
  echo "$UPLOAD_RESP"
  exit 1
fi

echo "Uploaded document: $DOC_ID"

STATUS=""
for _ in $(seq 1 80); do
  DOC_RESP=$(curl -s "$API_URL/api/documents/$DOC_ID" -H "x-api-key: $API_KEY")
  STATUS=$(echo "$DOC_RESP" | jq -r '.parse_status')
  echo "Status: $STATUS"
  if [[ "$STATUS" == "config_generated" || "$STATUS" == "requirements_extracted" || "$STATUS" == "failed" || "$STATUS" == "error" ]]; then
    break
  fi
  sleep 2
done

REQ_COUNT=$(curl -s "$API_URL/api/requirements?document_id=$DOC_ID" -H "x-api-key: $API_KEY" | jq '.count')
echo "Requirements extracted: $REQ_COUNT"

VERSION_RESP=$(curl -s "$API_URL/api/tenants/$TENANT_ID/config/versions" -H "x-api-key: $API_KEY")
VERSION_ID=$(echo "$VERSION_RESP" | jq -r '.items[0].id')

if [[ -n "$VERSION_ID" && "$VERSION_ID" != "null" ]]; then
  APPROVE_RESP=$(curl -s -X POST "$API_URL/api/configs/$VERSION_ID/approve" \
    -H "x-api-key: $API_KEY" \
    -H "x-user-role: architect" \
    -H "x-user-id: demo-run" \
    -H "Content-Type: application/json" \
    -d '{"scope":"full","comment":"demo-run approval"}')
  echo "Approve: $APPROVE_RESP"

  SIM_RESP=$(curl -s -X POST "$API_URL/api/simulations/run" \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"tenant_config_version_id\":\"$VERSION_ID\",\"mode\":\"mock\",\"scenario\":\"success\"}")
  echo "Simulation: $SIM_RESP"
fi

AUDIT_COUNT=$(curl -s "$API_URL/api/audit/$TENANT_ID" -H "x-api-key: $API_KEY" | jq '.count')

echo "=== SUMMARY ==="
echo "Tenant ID: $TENANT_ID"
echo "Document ID: $DOC_ID"
echo "Final Status: $STATUS"
echo "Requirements: $REQ_COUNT"
echo "Audit Events: $AUDIT_COUNT"

echo "=== DEMO RUN COMPLETE ==="
