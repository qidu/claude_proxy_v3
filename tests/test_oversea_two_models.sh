#!/bin/bash

# Test claude-4.6-sonnet and gemini-3.0-flash-preview with both native and OpenAI-compatible upstreams
# Config: proxy_config.toml_oversea

BASE_URL="http://localhost:8788"
AUTH_HEADER="Authorization: Bearer test-key"

# Models to test
MODELS=(
  "claude-4.6-sonnet"
  "gemini-3.0-flash-preview"
)

# Test endpoints
ENDPOINTS=(
  "/v1/messages"
)

echo "=========================================="
echo "Testing Models with Both Upstreams"
echo "=========================================="
echo ""

# Function to test a model
test_model() {
  local model=$1
  local endpoint=$2
  local stream=$3
  
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
  
  RESP=$(timeout $timeout curl -s -X POST "$BASE_URL$endpoint" \
    -H "Content-Type: application/json" \
    -H "$AUTH_HEADER" \
    -d "$payload" 2>&1)
  
  # Check response
  if echo "$RESP" | grep -qE "^(event:|data:)"; then
    echo "  ✅ $stream_label"
    return 0
  elif echo "$RESP" | grep -q '"id"'; then
    echo "  ✅ $stream_label"
    return 0
  elif echo "$RESP" | grep -q '"error"'; then
    ERROR_MSG=$(echo "$RESP" | grep -o '"message":"[^"]*"' | head -1)
    echo "  ❌ $stream_label - Error: $ERROR_MSG"
    return 1
  else
    echo "  ❌ $stream_label - Invalid response"
    return 1
  fi
}

# Test each model
for model in "${MODELS[@]}"; do
  echo "Testing: $model"
  
  passed=0
  total=0
  
  for endpoint in "${ENDPOINTS[@]}"; do
    # Non-streaming
    test_model "$model" "$endpoint" "false"
    if [ $? -eq 0 ]; then ((passed++)); fi
    ((total++))
    
    # Streaming
    test_model "$model" "$endpoint" "true"
    if [ $? -eq 0 ]; then ((passed++)); fi
    ((total++))
  done
  
  echo "  Result: $passed/$total"
  echo ""
done

echo "=========================================="
echo "Test Complete"
echo "=========================================="
