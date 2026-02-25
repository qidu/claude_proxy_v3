#!/bin/bash

cd /home/teric/win/e/dev/bot/claude_proxy_v3

echo "Starting server with proxy_config.toml..."
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_test.log 2>&1 &
SERVER_PID=$!
sleep 3

PASS=0
FAIL=0

test_endpoint() {
  local name=$1
  local url=$2
  local data=$3
  
  RESP=$(curl -s "$url" -H "Content-Type: application/json" -d "$data")
  
  if echo "$RESP" | jq -e '.id' > /dev/null 2>&1 && ! echo "$RESP" | jq -e '.error' > /dev/null 2>&1; then
    ID=$(echo "$RESP" | jq -r '.id')
    echo "✅ $name: $ID"
    ((PASS++))
  else
    ERROR=$(echo "$RESP" | jq -r '.error.message // .message // "Unknown error"' 2>/dev/null || echo "Connection failed")
    echo "❌ $name: $ERROR"
    ((FAIL++))
  fi
}

BASE="http://localhost:8788"

echo "Testing claude-4.5-sonnet (1 model × 3 endpoints = 3 tests)"
echo "============================================================"
echo
echo "Config: claude-4.5-sonnet uses mode=openai-completions (default upstream)"
echo

# claude-4.5-sonnet (openai-completions mode from config)
echo "Model: claude-4.5-sonnet (openai-completions mode)"
echo "---"
test_endpoint "1. /v1/messages" \
  "$BASE/v1/messages" \
  '{"model":"claude-4.5-sonnet","messages":[{"role":"user","content":"2+2?"}],"max_tokens":50}'

test_endpoint "2. /v1/interactions" \
  "$BASE/v1/interactions" \
  '{"model":"claude-4.5-sonnet","input":{"messages":[{"role":"user","content":"3+3?"}]}}'

test_endpoint "3. /v1beta/models/claude-4.5-sonnet:generateContent" \
  "$BASE/v1beta/models/claude-4.5-sonnet:generateContent" \
  '{"contents":[{"role":"user","parts":[{"text":"4+4?"}]}]}'

echo
echo "============================================================"
echo "Results: $PASS passed, $FAIL failed out of 3 tests"
echo "Success rate: $(( PASS * 100 / 3 ))%"

kill $SERVER_PID 2>/dev/null
