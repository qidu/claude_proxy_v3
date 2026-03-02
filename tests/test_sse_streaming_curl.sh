#!/bin/bash

cd /home/teric/win/e/dev/bot/model_proxy_v3

echo "Starting server..."
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_streaming.log 2>&1 &
SERVER_PID=$!
sleep 3

PASS=0
FAIL=0

test_sse_endpoint() {
  local name=$1
  local url=$2
  local data=$3
  
  RESP=$(timeout 10 curl -s -N "$url" \
    -H "Content-Type: application/json" \
    -d "$data" | head -20)
  
  echo $RESP
  echo ""
  if echo "$RESP" | grep -qE "^(event:|data:)"; then
    EVENT_COUNT=$(echo "$RESP" | grep -cE "^(event:|data:)")
    echo "✅ $name: SSE streaming works ($EVENT_COUNT events)"
    ((PASS++))
  else
    echo "❌ $name: No SSE events detected"
    ((FAIL++))
  fi
}

BASE="http://localhost:8788"

MODELS=(
  "deepseek/deepseek-v3.2"
  "gemini-2.5-flash"
  "claude-4.6-sonnet"
  "qwen-max-2025-01-25"
)

echo "SSE Streaming Test Suite"
echo "========================="
echo "Testing ${#MODELS[@]} models on all streaming endpoints"
echo

for MODEL in "${MODELS[@]}"; do
  echo "Model: $MODEL"
  echo "---"
  
  test_sse_endpoint "  /v1/messages" \
    "$BASE/v1/messages" \
    "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"What is 4 + 5 =\"}],\"max_tokens\":100,\"stream\":true}"
  
  test_sse_endpoint "  /v1/interactions" \
    "$BASE/v1/interactions" \
    "{\"model\":\"$MODEL\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"What is 4 + 5 =\"}]},\"stream\":true}"
  
  test_sse_endpoint "  streamGenerateContent" \
    "$BASE/v1beta/models/$MODEL:streamGenerateContent" \
    "{\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"What is 4 + 5 =\"}]}]}"
  
  echo
done

echo "=========================================="
echo "Results: $PASS passed, $FAIL failed out of $(( ${#MODELS[@]} * 3 )) tests"
echo "Success rate: $(awk "BEGIN {printf \"%.1f\", ($PASS/($PASS+$FAIL))*100}")%"

kill $SERVER_PID 2>/dev/null
