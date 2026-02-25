#!/bin/bash

cd /home/teric/win/e/dev/bot/claude_proxy_v3

echo "Starting server..."
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_thinking.log 2>&1 &
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
    ERROR=$(echo "$RESP" | jq -r '.error.message // .message // "Unknown error"' 2>/dev/null || echo "Failed")
    echo "❌ $name: $ERROR"
    ((FAIL++))
  fi
}

BASE="http://localhost:8788"

# Test all thinking models
MODELS=(
  "deepseek/deepseek-v3.2-exp-thinking"
  "qwen3-vl-30b-a3b-thinking"
  "qwen3-30b-a3b-thinking-2507"
  "qwen3-next-80b-a3b-thinking"
  "qwen3-235b-a22b-thinking-2507"
  "doubao-seed-1.6-thinking"
  "doubao-1.5-thinking-pro"
  "deepseek/deepseek-v3.1-terminus-thinking"
  "moonshotai/kimi-k2-thinking"
)

echo "Testing ${#MODELS[@]} thinking models on all 3 endpoints"
echo "========================================================="
echo

for MODEL in "${MODELS[@]}"; do
  echo "Model: $MODEL"
  echo "---"
  
  test_endpoint "  /v1/messages" \
    "$BASE/v1/messages" \
    "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"2+2?\"}],\"max_tokens\":100}"
  
  test_endpoint "  /v1/interactions" \
    "$BASE/v1/interactions" \
    "{\"model\":\"$MODEL\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"3+3?\"}]}}"
  
  test_endpoint "  generateContent" \
    "$BASE/v1beta/models/$MODEL:generateContent" \
    '{"contents":[{"role":"user","parts":[{"text":"4+4?"}]}]}'
  
  echo
done

echo "========================================================="
echo "Total: $PASS passed, $FAIL failed out of $(( ${#MODELS[@]} * 3 )) tests"
echo "Success rate: $(( PASS * 100 / (${#MODELS[@]} * 3) ))%"

kill $SERVER_PID 2>/dev/null
