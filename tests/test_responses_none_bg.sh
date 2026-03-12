#!/bin/bash

if [ -f ".env" ]; then
    source .env
fi

echo "Start testing server $PORT ..."

PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_responses.log 2>&1 &
SERVER_PID=$!
sleep 3

PASS=0
FAIL=0

echo $BASE_URL
echo ${API_KEY: -32}

# Test models for /v1/responses endpoint
MODELS=(
  "qwen3-32b"
  "minimax/minimax-m2.5"
  "moonshotai/kimi-k2.5"
  "deepseek/deepseek-v3.2-251201"
  "z-ai/glm-4.7"
  "gpt-oss-120b"
  "stepfun/step-flash"
  "meituan/longcat-flash"
)

# Test /v1/responses with background=false
test_responses() {
  local name=$1
  local url=$2
  local data=$3

  RESP=$(curl -s "$url" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d "$data")

  echo "$RESP" >> /tmp/test_responses_output.txt
  echo ""

  # Check for Responses API format
  if echo "$RESP" | grep -qE '"status":"completed"|"id":"resp_|"object":"response"'; then
    echo "✅ $name: Response format correct"
    ((PASS++))
  else
    echo "❌ $name: Unexpected response format"
    echo "   Response preview: $(echo "$RESP" | head -c 200)"
    ((FAIL++))
  fi
  echo ""
}

echo "Responses API Test Suite (background=false)"
echo "============================================="
echo "Testing ${#MODELS[@]} models on /v1/responses endpoint"
echo

TOTAL_TESTS=${#MODELS[@]}

for MODEL in "${MODELS[@]}"; do
  echo "Model: $MODEL"
  echo "---"

  # Test /v1/responses with background=false
  test_responses "  /v1/responses" \
    "$BASE_URL/v1/responses" \
    "{\"model\":\"$MODEL\",\"input\":\"What is 2 + 3? Answer in one word.\",\"background\":false}"

  echo
done

echo "=========================================="
echo "Results: $PASS passed, $FAIL failed out of $TOTAL_TESTS tests"
echo "Success rate: $(awk "BEGIN {printf \"%.1f\", ($PASS/($PASS+$FAIL))*100}")%"

echo ""
echo "Log file: /tmp/proxy_responses.log"
echo "Output file: /tmp/test_responses_output.txt"

kill $SERVER_PID 2>/dev/null