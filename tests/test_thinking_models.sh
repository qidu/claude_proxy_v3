#!/bin/bash

# Test all thinking models on all endpoints (streaming & non-streaming)
# Tests 3 endpoints: /v1/messages, /v1/interactions, and native generateContent

cd /home/teric/win/e/dev/bot/model_proxy_v3

echo "Starting server..."
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_thinking.log 2>&1 &
SERVER_PID=$!
sleep 3

PASS=0
FAIL=0

BASE_URL="http://localhost:8788"
if [[ -f .env ]]; then
    source .env
fi
echo $BASE_URL
echo ${API_KEY: -32}

# Simple question for non-streaming tests
SIMPLE_Q="2+2?"

# Complex question for streaming tests
COMPLEX_Q="Explain step by step how to solve this problem: A train travels 120 km in 2 hours, then 180 km in 3 hours. What is the average speed for the entire journey?"

# All thinking models
MODELS=(
  "deepseek-r1-0528"
#  "qwen3-vl-30b-a3b-thinking"
#  "qwen3-30b-a3b-thinking-2507"
#  "qwen3-next-80b-a3b-thinking"
#  "qwen3-235b-a22b-thinking-2507"
#  "doubao-seed-1.6-thinking"
#  "doubao-1.5-thinking-pro"
#  "deepseek/deepseek-v3.1-terminus-thinking"
#  "moonshotai/kimi-k2-thinking"
#  "moonshotai/kimi-k2.5"
#  "minimax/minimax-m2.5"
)

test_nonstream() {
  local name=$1
  local url=$2
  local data=$3

  RESP=$(curl -s "$url" -H "Content-Type: application/json" \
        -H "Authorization: Bearer $API_KEY" \
        -H "x-api-key: $API_KEY" \
        -H "x-goog-api-key: $API_KEY" \
        -d "$data")
  echo "$RESP" >> /tmp/test_thinking_reponses.txt
  echo "" >> /tmp/test_thinking_reponses.txt

  if echo "$RESP" | jq -e '.model' > /dev/null 2>&1 && ! echo "$RESP" | jq -e '.error' > /dev/null 2>&1; then
    # Check for thinking block extraction
    HAS_THINKING=$(echo "$RESP" | jq -r '.content[] | select(.type == "thinking") | .thinking // empty' 2>/dev/null | wc -c)
    if [ "$HAS_THINKING" -gt 1 ]; then
      echo "  ✅ $name (with thinking block extracted)"
    else
      echo "  ✅ $name"
    fi
    ((PASS++))
    echo "$RESP"
  else
    ERROR=$(echo "$RESP" | jq -r '.error.message // .message // "Unknown error"' 2>/dev/null || echo "Failed")
    echo "  ❌ $name: $ERROR"
    echo "$RESP" | jq -e '.id'
    echo "$RESP" | jq -e '.model'
    echo "$RESP" | jq 
    ((FAIL++))
  fi
}

test_stream() {
  local name=$1
  local url=$2
  local data=$3

  echo "$data" | jq
  RESP=$(timeout 10 curl -s -N "$url" -H "Content-Type: application/json" \
        -H "Authorization: Bearer $API_KEY" \
        -H "x-api-key: $API_KEY" \
        -H "x-goog-api-key: $API_KEY" \
        -d "$data" 2>/dev/null)

  # Save first event for basic check
  echo "$RESP"
  FIRST_EVENT=$(echo "$RESP" | head -1)
  echo "$RESP" >> /tmp/test_thinking_reponses.txt
  echo "" >> /tmp/test_thinking_reponses.txt

  if echo "$FIRST_EVENT" | grep -q "data:"; then
    # Check for thinking_delta event in streaming response
    HAS_THINKING_DELTA=$(echo "$RESP" | grep -c "thinking_delta" || echo "0")
    if [ "$HAS_THINKING_DELTA" -gt 0 ]; then
      echo "  ✅ $name (stream with thinking_delta)"
    else
      echo "  ✅ $name (stream)"
    fi
    ((PASS++))
  else
    echo "  ❌ $name (stream): No SSE"
    ((FAIL++))
  fi
}

echo "Testing ${#MODELS[@]} thinking models - Stream & Non-Stream"
echo "========================================================="
echo

for MODEL in "${MODELS[@]}"; do
  echo "Model: $MODEL"
  echo "---"

  # Non-streaming tests
  test_nonstream "/v1/messages" \
    "$BASE_URL/v1/messages" \
    "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"$SIMPLE_Q\"}],\"max_tokens\":100}"

  test_nonstream "/v1/interactions" \
    "$BASE_URL/v1/interactions" \
    "{\"model\":\"$MODEL\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"$SIMPLE_Q\"}]}}"

  test_nonstream "generateContent" \
    "$BASE_URL/v1beta/models/$MODEL:generateContent" \
    "{\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"$SIMPLE_Q\"}]}]}"

  # Streaming tests (complex question)
  test_stream "/v1/messages" \
    "$BASE_URL/v1/messages" \
    "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"$COMPLEX_Q\"}],\"max_tokens\":500,\"stream\":true}"

  test_stream "/v1/interactions" \
    "$BASE_URL/v1/interactions" \
    "{\"model\":\"$MODEL\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"$COMPLEX_Q\"}]},\"stream\":true}"

  test_stream "streamGenerateContent" \
    "$BASE_URL/v1beta/models/$MODEL:streamGenerateContent" \
    "{\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"$COMPLEX_Q\"}]}]}"

  echo
done

TOTAL=$(( ${#MODELS[@]} * 6 ))
echo "========================================================="
echo "Total: $PASS passed, $FAIL failed out of $TOTAL tests"
echo "Success rate: $(( PASS * 100 / TOTAL ))%"

tail /tmp/test_thinking_reponses.txt
wc -l /tmp/test_thinking_reponses.txt

kill $SERVER_PID 2>/dev/null
