#!/bin/bash

cd /home/teric/win/e/dev/bot/claude_proxy_v3

echo "Starting server..."
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_sse_test.log 2>&1 &
SERVER_PID=$!
sleep 3

PASS=0
FAIL=0

test_sse_endpoint() {
  local name=$1
  local url=$2
  local data=$3
  
  # Test SSE streaming - capture first few events
  RESP=$(curl -s -N "$url" \
    -H "Content-Type: application/json" \
    -d "$data" | head -20)
  
  # Check if response contains SSE format (event: or data:)
  echo "$RESP"

  if echo "$RESP" | grep -q "event:\|data:"; then
    # Count events
    EVENT_COUNT=$(echo "$RESP" | grep -c "^event:\|^data:")
    echo "✅ $name: SSE streaming works ($EVENT_COUNT events)"
    ((PASS++))
  else
    echo "❌ $name: No SSE events detected"
    echo "   Response: $(echo "$RESP" | head -c 100)"
    ((FAIL++))
  fi
  echo ""
}

BASE="http://localhost:8788"

#MODEL="qwen3-32b"
MODEL="gemini-2.5-flash"
MODEL="claude-4.6-sonnet"
MODEL="deepseek/deepseek-v3.2-251201"


echo "Testing SSE streaming on all 3 endpoints"
echo "=========================================="
echo "Model: $MODEL"
echo

test_sse_endpoint "1. /v1/messages" \
  "$BASE/v1/messages" \
  "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"What is 4 + 5 =\"}],\"max_tokens\":100,\"stream\":true}"

test_sse_endpoint "2. /v1/interactions" \
  "$BASE/v1/interactions" \
  "{\"model\":\"$MODEL\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"What is 4 + 5 =\"}]},\"stream\":true}"

test_sse_endpoint "3. streamGenerateContent" \
  "$BASE/v1beta/models/$MODEL:streamGenerateContent" \
  "{\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"What is 4 + 5 =\"}]}]}"

echo
echo "test $MODEL with gemini cli"
gemini -y -m "$MODEL" -p "hi, what is 4 + 5 =? "

echo
echo "=========================================="
echo "Results: $PASS passed, $FAIL failed out of 3 tests"
echo "Success rate: $(( PASS * 100 / 3 ))%"

kill $SERVER_PID 2>/dev/null
