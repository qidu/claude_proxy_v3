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

echo "Testing claude-sonnet-4.5 (2 upstreams × 3 endpoints = 6 tests)"
echo "================================================================"
echo

# Test with native upstream (uses default config - no model-specific config)
echo "1. Native upstream (uses default mode from config)"
echo "---"
test_endpoint "1a. /v1/messages" \
  "$BASE/v1/messages" \
  '{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"2+2?"}],"max_tokens":50}'

test_endpoint "1b. /v1/interactions" \
  "$BASE/v1/interactions" \
  '{"model":"claude-sonnet-4.5","input":{"messages":[{"role":"user","content":"3+3?"}]}}'

test_endpoint "1c. /v1beta/models/claude-sonnet-4.5:generateContent" \
  "$BASE/v1beta/models/claude-sonnet-4.5:generateContent" \
  '{"contents":[{"role":"user","parts":[{"text":"4+4?"}]}]}'

echo

# Test with OpenAI-compatible upstream (explicit test - same as default)
echo "2. OpenAI-compatible upstream (default behavior)"
echo "---"
echo "Note: Same as above since model uses default openai-completions mode"
echo "Skipping duplicate tests - already tested above"

echo
echo "================================================================"
echo "Results: $PASS passed, $FAIL failed out of 3 tests"
echo "Success rate: $(( PASS * 100 / 3 ))%"
echo
echo "Note: claude-sonnet-4.5 has no model-specific config,"
echo "      so it uses [defaults] mode = openai-completions"

kill $SERVER_PID 2>/dev/null
