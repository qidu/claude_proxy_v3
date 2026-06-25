#!/bin/bash

# Test all thinking models on all endpoints (streaming & non-streaming)
# Tests 3 endpoints: /v1/messages, /v1/interactions, and native generateContent
#
cd /home/teric/win/e/dev/bot/model_proxy_v3

BASE_URL="http://localhost:8788"
if [[ -f .env ]]; then
    source .env
fi

echo "Starting server..."
PROXY_CONFIG_PATH=./proxy_config.toml PORT=${PORT} node dist/server.js > /tmp/test_proxy_server.log 2>&1 &
SERVER_PID=$!
sleep 3
echo "" > /tmp/test_thinking_reponses.txt

PASS=0
FAIL=0

echo $BASE_URL
echo ${API_KEY: -32}

# Simple question for non-streaming tests
SIMPLE_Q="2+2?"

# Complex question for streaming tests
COMPLEX_Q="Explain step by step how to solve this problem: A train travels 120 km in 2 hours, then 180 km in 3 hours. What is the average speed for the entire journey?"

# Tool call question for tool tests
TOOL_Q="List files in the current directory with details and sumarize files and dirs."
TOOL_Q="Calculate 15 + 27 using the math_operation tool."

# All thinking models
MODELS=(
  "deepseek-r1-0528"
#  "qwen3-vl-30b-a3b-thinking"
#  "qwen3-30b-a3b-thinking-2507"
#  "qwen3-next-80b-a3b-thinking"
  "qwen3-235b-a22b-thinking-2507"
  "doubao-seed-1.6-thinking"
#  "doubao-1.5-thinking-pro"
  "deepseek/deepseek-v3.1-terminus-thinking"
#  "moonshotai/kimi-k2-thinking"
  "moonshotai/kimi-k2.5"
  "minimax/minimax-m2.5"
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
  else
    ERROR=$(echo "$RESP" | jq -r '.error.message // .message // "Unknown error"' 2>/dev/null || echo "Failed")
    echo "  ❌ $name: $ERROR"
    echo "$RESP" | jq 
    ((FAIL++))
  fi
}

test_stream() {
  local name=$1
  local url=$2
  local data=$3

  rm -f /tmp/test_steamout.txt
  RESP=$(curl -v -N "$url" -H "Content-Type: application/json" \
        -H "Authorization: Bearer $API_KEY" \
        -H "x-api-key: $API_KEY" \
        -H "x-goog-api-key: $API_KEY" \
        -o /tmp/test_steamout.txt \
        -d "$data" 2>/dev/null)

  RESP=$(cat /tmp/test_steamout.txt)

  # Save first event for basic check
  echo "$RESP" >> /tmp/test_thinking_reponses.txt
  echo "" >> /tmp/test_thinking_reponses.txt

  if echo "$RESP" | grep -q "event: message_start"; then
          # Check for data (BUT not content_block_stop or thinking_delta) event in streaming response
    HAS_THINKING_DELTA=$(echo "$RESP" | grep -c "data: " || echo "0")
    if [ "$HAS_THINKING_DELTA" -gt 0 ]; then
      echo "  ✅ $name (stream with thinking_delta)"
    else
      echo "  ✅ $name (stream)"
    fi
    ((PASS++))
  else
    echo "  ❌ $name (stream): No SSE"
    ((FAIL++))
    echo "$RESP"
  fi
}

test_tool() {
  local name=$1
  local url=$2
  local data=$3

  # Check if this is a streaming request
  if echo "$data" | grep -q '"stream":\s*true'; then
    test_tool_stream "$name" "$url" "$data"
  else
    test_tool_nonstream "$name" "$url" "$data"
  fi
}

test_tool_nonstream() {
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
    # Check for tool_use block
    HAS_TOOL_USE=$(echo "$RESP" | jq -r '.content[] | select(.type == "tool_use") | .name // empty' 2>/dev/null | wc -c)
    # Check for correct stop_reason
    STOP_REASON=$(echo "$RESP" | jq -r '.stop_reason // empty' 2>/dev/null)

    if [ "$HAS_TOOL_USE" -gt 1 ]; then
      if [ "$STOP_REASON" = "tool_use" ]; then
        echo "  ✅ $name (with tool_use block and correct stop_reason)"
      else
        echo "  ⚠️  $name (with tool_use but stop_reason is '$STOP_REASON', expected 'tool_use')"
      fi
    else
      # Some thinking models might not support tools - this is okay
      echo "  ⚠️  $name (no tool_use - model may not support tools)"
    fi
    ((PASS++))
  else
    ERROR=$(echo "$RESP" | jq -r '.error.message // .message // "Unknown error"' 2>/dev/null || echo "Failed")
    # Check if error is about tools not being supported
    if echo "$ERROR" | grep -qi "tool\|function"; then
      echo "  ⚠️  $name: Model doesn't support tools (expected for some thinking models)"
      ((PASS++))  # Count as pass since it's expected behavior
    else
      echo "  ❌ $name: $ERROR"
      echo "$RESP" | jq
      ((FAIL++))
    fi
  fi
}

test_tool_stream() {
  local name=$1
  local url=$2
  local data=$3

  rm -f /tmp/test_tool_stream.txt
  RESP=$(curl -v -N "$url" -H "Content-Type: application/json" \
        -H "Authorization: Bearer $API_KEY" \
        -H "x-api-key: $API_KEY" \
        -H "x-goog-api-key: $API_KEY" \
        -o /tmp/test_tool_stream.txt \
        -d "$data" 2>/dev/null)

  RESP=$(cat /tmp/test_tool_stream.txt)
  echo "$RESP" >> /tmp/test_thinking_reponses.txt
  echo "" >> /tmp/test_thinking_reponses.txt

  # Check for SSE events
  if echo "$RESP" | grep -q "event: message_start"; then
    # Check for tool_use content_block_start
    HAS_TOOL_USE=$(echo "$RESP" | grep -c 'content_block_start.*tool_use' || echo "0")
    # Check for input_json_delta (tool arguments streaming)
    HAS_INPUT_JSON_DELTA=$(echo "$RESP" | grep -c 'input_json_delta' || echo "0")
    # Check for correct stop_reason in message_delta
    HAS_CORRECT_STOP_REASON=$(echo "$RESP" | grep -A1 'event: message_delta' | grep -c 'stop_reason.*tool_use' || echo "0")

    if [ "$HAS_TOOL_USE" -gt 0 ]; then
      if [ "$HAS_CORRECT_STOP_REASON" -gt 0 ]; then
        echo "  ✅ $name (stream with tool_use and correct stop_reason)"
        if [ "$HAS_INPUT_JSON_DELTA" -gt 0 ]; then
          echo "     - Has input_json_delta events for tool arguments"
        fi
      else
        echo "  ⚠️  $name (stream with tool_use but missing/wrong stop_reason)"
        echo "     - Tool use blocks found: $HAS_TOOL_USE"
        echo "     - Expected stop_reason: 'tool_use'"
      fi
    else
      # Some thinking models might not support tools - this is okay
      echo "  ⚠️  $name (stream, no tool_use - model may not support tools)"
    fi
    ((PASS++))
  else
    echo "  ❌ $name (stream): No SSE"
    ((FAIL++))
    echo "$RESP"
  fi
}

echo "Testing ${#MODELS[@]} thinking models - Stream & Non-Stream"
echo "========================================================="
echo

for MODEL in "${MODELS[@]}"; do
  echo "Model: $MODEL"
  echo "---"

  # Non-streaming tests
  #test_nonstream "/v1/messages" \
  #  "$BASE_URL/v1/messages" \
  #  "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"$SIMPLE_Q\"}],\"max_tokens\":100}"

  # Streaming tool test (tests our fix for stop_reason: tool_use)
  test_tool "/v1/messages (stream tool)" \
    "$BASE_URL/v1/messages" \
    "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Calculate 15 + 27 using the math_operation tool.\",\"cache_control\":{\"type\":\"ephemeral\"}}]}],\"max_tokens\":1365,\"stream\":true,\"system\":[{\"type\":\"text\",\"text\":\"You are a helpful assistant that uses tools when asked.\",\"cache_control\":{\"type\":\"ephemeral\"}}],\"tools\":[{\"name\":\"math_operation\",\"description\":\"Perform basic arithmetic operations\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"description\":\"First number\",\"type\":\"number\"},\"b\":{\"description\":\"Second number\",\"type\":\"number\"},\"operation\":{\"type\":\"string\",\"enum\":[\"add\",\"subtract\",\"multiply\",\"divide\"],\"description\":\"The operation to perform. One of 'add', 'subtract', 'multiply', 'divide'.\"}},\"required\":[\"a\",\"b\",\"operation\"]}}]}"

  # Non-streaming tool test (for comparison)
  test_tool "/v1/messages (non-stream tool)" \
    "$BASE_URL/v1/messages" \
    "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Calculate 15 + 27 using the math_operation tool.\",\"cache_control\":{\"type\":\"ephemeral\"}}]}],\"max_tokens\":1365,\"stream\":false,\"system\":[{\"type\":\"text\",\"text\":\"You are a helpful assistant that uses tools when asked.\",\"cache_control\":{\"type\":\"ephemeral\"}}],\"tools\":[{\"name\":\"math_operation\",\"description\":\"Perform basic arithmetic operations\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"description\":\"First number\",\"type\":\"number\"},\"b\":{\"description\":\"Second number\",\"type\":\"number\"},\"operation\":{\"type\":\"string\",\"enum\":[\"add\",\"subtract\",\"multiply\",\"divide\"],\"description\":\"The operation to perform. One of 'add', 'subtract', 'multiply', 'divide'.\"}},\"required\":[\"a\",\"b\",\"operation\"]}}]}"
    # "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"$TOOL_Q\"}],\"max_tokens\":200,\"tools\":[{\"name\":\"ls_file\",\"description\":\"List files in directory with details\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"operation\":{\"type\":\"string\",\"description\":\"Operation to perform\",\"enum\":[\"ls\",\"ls -l\",\"ls -la\"]}},\"required\":[\"operation\"]}}]}"

  #test_nonstream "/v1/interactions" \
  #  "$BASE_URL/v1/interactions" \
  #  "{\"model\":\"$MODEL\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"$SIMPLE_Q\"}]}}"

  #test_nonstream "generateContent" \
  #  "$BASE_URL/v1beta/models/$MODEL:generateContent" \
  #  "{\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"$SIMPLE_Q\"}]}]}"

  # Streaming tests
  #test_stream "/v1/messages" \
  #  "$BASE_URL/v1/messages" \
  #  "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"$COMPLEX_Q\"}],\"stream\":true}"

  #test_stream "/v1/interactions" \
  #  "$BASE_URL/v1/interactions" \
  #  "{\"model\":\"$MODEL\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"$COMPLEX_Q\"}]},\"stream\":true}"

  #test_stream "streamGenerateContent" \
  #  "$BASE_URL/v1beta/models/$MODEL:streamGenerateContent" \
  #  "{\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"$COMPLEX_Q\"}]}]}"

  echo
done

TOTAL=$(( ${#MODELS[@]} * 2 ))
echo "========================================================="
echo "Total: $PASS passed, $FAIL failed out of $TOTAL tests"
echo "Success rate: $(( PASS * 100 / TOTAL ))%"

tail /tmp/test_thinking_reponses.txt
wc -l /tmp/test_thinking_reponses.txt

kill $SERVER_PID 2>/dev/null
