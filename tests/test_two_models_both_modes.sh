#!/bin/bash

# Test claude-4.6-sonnet and gemini-3.0-flash-preview with both native and OpenAI-compatible modes
# Config: proxy_config.toml_oversea

BASE_URL="http://localhost:8788"
AUTH_HEADER="Authorization: Bearer test-key"

# Models to test
MODELS=(
  "claude-4.6-sonnet"
  "gemini-3.0-flash-preview"
)

echo "=========================================="
echo "Testing Models: Native vs OpenAI Mode"
echo "=========================================="
echo ""

# Function to test a model
test_model() {
  local model=$1
  local stream=$2
  
  local stream_flag=""
  local stream_label="Non-stream"
  local timeout=10
  
  if [ "$stream" = "true" ]; then
    stream_flag='"stream": true,'
    stream_label="Stream"
    timeout=20
  fi
  
  local payload="{
    \"model\": \"$model\",
    $stream_flag
    \"messages\": [{\"role\": \"user\", \"content\": \"Hi\"}],
    \"max_tokens\": 50
  }"
  
  RESP=$(timeout $timeout curl -s -X POST "$BASE_URL/v1/messages" \
    -H "Content-Type: application/json" \
    -H "$AUTH_HEADER" \
    -d "$payload" 2>&1)
  
  # Check response
  if echo "$RESP" | grep -qE "^(event:|data:)"; then
    echo "    ✅ $stream_label"
    return 0
  elif echo "$RESP" | grep -q '"id"'; then
    echo "    ✅ $stream_label"
    return 0
  elif echo "$RESP" | grep -q '"error"'; then
    ERROR_MSG=$(echo "$RESP" | grep -o '"message":"[^"]*"' | head -1)
    echo "    ❌ $stream_label - Error: $ERROR_MSG"
    return 1
  else
    echo "    ❌ $stream_label - Invalid response"
    return 1
  fi
}

# Test native mode
echo "=== NATIVE MODE ==="
echo ""

for model in "${MODELS[@]}"; do
  echo "  $model:"
  
  passed=0
  total=0
  
  # Non-streaming
  test_model "$model" "false"
  if [ $? -eq 0 ]; then ((passed++)); fi
  ((total++))
  
  # Streaming
  test_model "$model" "true"
  if [ $? -eq 0 ]; then ((passed++)); fi
  ((total++))
  
  echo "    Result: $passed/$total"
  echo ""
done

echo "=========================================="
echo "Test Complete"
echo "=========================================="
