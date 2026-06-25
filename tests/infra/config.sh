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

echo "Testing with proxy_config.toml (2 models × 3 endpoints = 6 tests)"
echo "=================================================================="
echo
echo "Config:"
echo "- gemini-2.5-flash: mode=native, base_url=https://api.example1.com"
echo "- claude-4.5-haiku: mode=openai-completions, uses default upstream"
echo

# gemini-2.5-flash (native mode from config)
echo "Model: gemini-2.5-flash (native mode)"
echo "---"
test_endpoint "1. /v1/messages" \
  "$BASE/v1/messages" \
  '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"2+2?"}],"max_tokens":50}'

test_endpoint "2. /v1/interactions" \
  "$BASE/v1/interactions" \
  '{"model":"gemini-2.5-flash","input":{"messages":[{"role":"user","content":"3+3?"}]}}'

test_endpoint "3. /v1beta/models/gemini-2.5-flash:generateContent" \
  "$BASE/v1beta/models/gemini-2.5-flash:generateContent" \
  '{"contents":[{"role":"user","parts":[{"text":"4+4?"}]}]}'

echo

# claude-4.5-haiku (openai-completions mode from config)
echo "Model: claude-4.5-haiku (openai-completions mode)"
echo "---"
test_endpoint "1. /v1/messages" \
  "$BASE/v1/messages" \
  '{"model":"claude-4.5-haiku","messages":[{"role":"user","content":"5+5?"}],"max_tokens":50}'

test_endpoint "2. /v1/interactions" \
  "$BASE/v1/interactions" \
  '{"model":"claude-4.5-haiku","input":{"messages":[{"role":"user","content":"6+6?"}]}}'

test_endpoint "3. /v1beta/models/claude-4.5-haiku:generateContent" \
  "$BASE/v1beta/models/claude-4.5-haiku:generateContent" \
  '{"contents":[{"role":"user","parts":[{"text":"7+7?"}]}]}'

echo
echo "=================================================================="
echo "Results: $PASS passed, $FAIL failed out of 6 tests"
echo "Success rate: $(( PASS * 100 / 6 ))%"

kill $SERVER_PID 2>/dev/null
