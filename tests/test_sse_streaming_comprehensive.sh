#!/bin/bash

echo "Starting server..."
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_streaming_comprehensive.log 2>&1 &
SERVER_PID=$!
sleep 3

PASS=0
FAIL=0

BASE="http://localhost:8788"
API_KEY="sk-28f417e15b46439*"
API_KEY="sk-e86b76b64132588eac588c0530f6914f41c0452c86eac3629a0c09d9a55723f2"

# Test more models including different providers
MODELS=(
  "qwen3-32b"
  "qwen-max-2025-01-25"
  "minimax/minimax-m2.1"
  "minimax/minimax-m2.5"
  "moonshotai/kimi-k2.5"
  "deepseek/deepseek-v3.2"
  "gemini-2.5-flash"
#  "gemini-3.1-pro-preview"
  "claude-4.5-sonnet"
#  "claude-4.6-sonnet"
  "z-ai/glm-4.7"
)

test_sse_endpoint() {
  local name=$1
  local url=$2
  local data=$3
  
  RESP=$(curl -s -N "$url" \
    -H "Content-Type: application/json" \
    -H "x-api-key: $API_KEY" \
    -H "x-goog-api-key: $API_KEY" \
    -H "Authorization: Bearer $API_KEY" \
    -d "$data" | head -20)
  
  echo "$RESP"
  echo ""
  if echo "$RESP" | grep -qE "^(event:|data:)"; then
    EVENT_COUNT=$(echo "$RESP" | grep -cE "^(event:|data:)")
    echo "✅ $name: SSE streaming works ($EVENT_COUNT events)"
    ((PASS++))
  else
    echo "❌ $name: No SSE events detected"
    ((FAIL++))
  fi
  echo ""
}

test_gemini_cli() {
  local model=$1
  echo 'echo "# Testing Gemini CLI with model: $model" '
  
  echo "gemini -y -m '$model' -p 'What is 4 + 5 =? Answer in one word.' "
  # RESP=$(gemini -y -m "$model" -p "What is 4 + 5 =? Answer in one word." 2>&1)
  
  # if echo "$RESP" | grep -qE "9|nine|Nine"; then
  #   echo "✅ Gemini CLI: Works with model $model"
  #   ((PASS++))
  # else
  #   echo "❌ Gemini CLI: Failed with model $model"
  #   echo "   Response: $(echo "$RESP" | head -c 100)"
  #   ((FAIL++))
  # fi
  # echo ""
}


echo "Comprehensive SSE Streaming Test Suite"
echo "======================================"
echo "Testing ${#MODELS[@]} models on all 3 endpoints + Gemini CLI"
echo

TOTAL_TESTS=$(( ${#MODELS[@]} * 4 ))  # 3 endpoints + Gemini CLI

for MODEL in "${MODELS[@]}"; do
  echo "Model: $MODEL"
  echo "---"
  
  # Test 3 endpoints
  test_sse_endpoint "  /v1/messages" \
    "$BASE/v1/messages" \
    "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"What is 4 + 5 =\"}],\"max_tokens\":100,\"stream\":true}"
  
  test_sse_endpoint "  /v1/interactions" \
    "$BASE/v1/interactions" \
    "{\"model\":\"$MODEL\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"What is 4 + 5 =\"}]},\"stream\":true}"
  
  test_sse_endpoint "  streamGenerateContent" \
    "$BASE/v1beta/models/$MODEL:streamGenerateContent" \
    "{\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"What is 4 + 5 =\"}]}]}"
 
  # Test Gemini CLI for Gemini models
  # test_gemini_cli "$MODEL"
  echo
done

echo "=========================================="
echo "Results: $PASS passed, $FAIL failed out of $TOTAL_TESTS tests"
echo "Success rate: $(awk "BEGIN {printf \"%.1f\", ($PASS/($PASS+$FAIL))*100}")%"

for MODEL in "${MODELS[@]}"; do
  # test_gemini_cli "$MODEL"
  echo
done

kill $SERVER_PID 2>/dev/null
