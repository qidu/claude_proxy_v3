#!/bin/bash

cd /home/teric/win/e/dev/bot/claude_proxy_v3

BASE="http://localhost:8788"

# Failed models from previous test
FAILED_MODELS=(
  "minimax/minimax-m2.5"
  "deepseek-r1"
  "deepseek-r1-0528"
  "qwen3-vl-30b-a3b-thinking"
  "glm-4.5"
  "glm-4.5-air"
  "z-ai/glm-5"
)

# Update config with alternative key
cat > proxy_config.toml << 'EOF'
[upstream]
default_url = "https://api.qnaigc.com/v1"
default_api_key = "sk-28f417e15b4643913bce23520d5948327c******"

[defaults]
mode = "openai-completions"
EOF

# Start server
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_failed_models.log 2>&1 &
SERVER_PID=$!
sleep 4

TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_TESTS=0

test_model() {
  local model=$1
  local pass=0
  local fail=0
  
  echo "Testing: $model"
  
  # Non-streaming /v1/messages
  RESP=$(timeout 10 curl -s "$BASE/v1/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer sk-28f417e15b4643913bce23520d5948327c******" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"max_tokens\":20}" 2>/dev/null)
  if echo "$RESP" | jq -e '.id' > /dev/null 2>&1; then
    echo "  ✅ Non-stream"
    ((pass++))
  else
    echo "  ❌ Non-stream: $(echo "$RESP" | jq -r '.error.message // "Failed"' | head -c 50)"
    ((fail++))
  fi
  
  # Streaming /v1/messages (increased timeout)
  RESP=$(timeout 20 curl -s -N "$BASE/v1/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer sk-28f417e15b4643913bce23520d5948327c******" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"max_tokens\":20,\"stream\":true}" 2>/dev/null | head -1)
  if echo "$RESP" | grep -qE "^(event:|data:)"; then
    echo "  ✅ Stream"
    ((pass++))
  else
    echo "  ❌ Stream: No SSE"
    ((fail++))
  fi
  
  local total=$((pass + fail))
  echo "  Result: $pass/$total"
  echo ""
  
  TOTAL_PASS=$((TOTAL_PASS + pass))
  TOTAL_FAIL=$((TOTAL_FAIL + fail))
  TOTAL_TESTS=$((TOTAL_TESTS + total))
}

echo "=========================================="
echo "Testing Failed Models with Alternative Key"
echo "=========================================="
echo ""

# Test each failed model
for model in "${FAILED_MODELS[@]}"; do
  test_model "$model"
done

echo "=========================================="
echo "Summary"
echo "=========================================="
echo "Total: $TOTAL_PASS passed, $TOTAL_FAIL failed out of $TOTAL_TESTS tests"
echo "Success rate: $(awk "BEGIN {printf \"%.1f\", ($TOTAL_PASS/$TOTAL_TESTS)*100}")%"
echo ""

# Cleanup
kill $SERVER_PID 2>/dev/null
sleep 2

echo "Test Complete"
