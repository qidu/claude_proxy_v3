#!/bin/bash

cd /home/teric/win/e/dev/bot/claude_proxy_v3

BASE="http://localhost:8788"

echo "Starting server..."
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_all_models.log 2>&1 &
SERVER_PID=$!
sleep 4

echo "Fetching model list..."
MODELS=$(curl -s "$BASE/v1/models" 2>/dev/null | jq -r '.data[].id' | head -30)

if [ -z "$MODELS" ]; then
  echo "❌ Failed to fetch models"
  kill $SERVER_PID 2>/dev/null
  exit 1
fi

echo "Testing $(echo "$MODELS" | wc -l) models..."
echo

TOTAL_PASS=0
TOTAL_FAIL=0

test_model() {
  local model=$1
  local pass=0
  local fail=0
  
  echo "Testing: $model"
  
  # Non-streaming /v1/messages
  RESP=$(timeout 10 curl -s "$BASE/v1/messages" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"max_tokens\":20}" 2>/dev/null)
  if echo "$RESP" | jq -e '.id' > /dev/null 2>&1; then
    ((pass++))
  else
    ((fail++))
  fi
  
  # Streaming /v1/messages
  RESP=$(timeout 10 curl -s -N "$BASE/v1/messages" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"max_tokens\":20,\"stream\":true}" 2>/dev/null | head -1)
  if echo "$RESP" | grep -qE "^(event:|data:)"; then
    ((pass++))
  else
    ((fail++))
  fi
  
  local total=$((pass + fail))
  if [ $pass -eq $total ]; then
    echo "  ✅ $pass/$total"
  else
    echo "  ⚠️  $pass/$total"
  fi
  
  TOTAL_PASS=$((TOTAL_PASS + pass))
  TOTAL_FAIL=$((TOTAL_FAIL + fail))
}

while IFS= read -r model; do
  test_model "$model"
done <<< "$MODELS"

echo
echo "=========================================="
echo "Summary"
echo "=========================================="
TOTAL_TESTS=$((TOTAL_PASS + TOTAL_FAIL))
echo "Total: $TOTAL_PASS passed, $TOTAL_FAIL failed out of $TOTAL_TESTS tests"
echo "Success rate: $(awk "BEGIN {printf \"%.1f\", ($TOTAL_PASS/$TOTAL_TESTS)*100}")%"

kill $SERVER_PID 2>/dev/null
