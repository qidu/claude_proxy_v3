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

# Models to test (all use openai-completions mode with default upstream)
MODELS=(
  "deepseek/deepseek-v3.2"
  "minimax/minimax-m2.1"
  "z-ai/glm-5"
  "gpt-oss-120b"
  "deepseek-r1"
)

echo "Testing 5 models × 3 endpoints = 15 tests"
echo "=========================================="
echo "All models use openai-completions mode with default upstream"
echo

for model in "${MODELS[@]}"; do
  echo "Model: $model"
  echo "---"
  
  test_endpoint "1. /v1/messages" \
    "$BASE/v1/messages" \
    "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"2+2?\"}],\"max_tokens\":50}"
  
  test_endpoint "2. /v1/interactions" \
    "$BASE/v1/interactions" \
    "{\"model\":\"$model\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"3+3?\"}]}}"
  
  test_endpoint "3. /v1beta/models/$model:generateContent" \
    "$BASE/v1beta/models/$model:generateContent" \
    "{\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"4+4?\"}]}]}"
  
  echo
done

echo "=========================================="
echo "Results: $PASS passed, $FAIL failed out of 15 tests"
echo "Success rate: $(( PASS * 100 / 15 ))%"

kill $SERVER_PID 2>/dev/null
