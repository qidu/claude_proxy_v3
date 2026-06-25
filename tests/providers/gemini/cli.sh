#!/bin/bash

# Test basic models using gemini CLI
# Config: ~/.gemini/.env, ./proxy_config.toml

MODELS=(
  "deepseek/deepseek-v3.1"
  "deepseek-r1"
  "minimax/minimax-m2.1"
  "moonshotai/kimi-k2.5"
  "z-ai/glm-5"
  "minimax/minimax-m2.5"
  "qwen3-32b"
  "deepseek/deepseek-v3.2-exp"
  "z-ai/glm-4.7"
  "moonshotai/kimi-k2-0905"
)

PROMPT="Say hello and tell me your model name in one sentence"

echo "Testing ${#MODELS[@]} basic models with gemini CLI"
echo ""

PASS=0
FAIL=0

for model in "${MODELS[@]}"; do
  echo "=========================================="
  echo "Model: $model"
  echo "=========================================="
  
  RESULT=$(timeout 10 gemini -y -m "$model" -p "$PROMPT" 2>&1)
  
  if [ $? -eq 0 ] && [ -n "$RESULT" ]; then
    echo "✅ $(echo "$RESULT" | grep -v "^DEBUG:" | tail -1)"
    ((PASS++))
  else
    echo "❌ $(echo "$RESULT" | grep -E "error|Error" | head -1 || echo "Failed")"
    ((FAIL++))
  fi
  echo ""
done

echo "=========================================="
echo "Results: $PASS passed, $FAIL failed"
echo "Success rate: $(awk "BEGIN {printf \"%.1f\", ($PASS/($PASS+$FAIL))*100}")%"
echo "=========================================="
#!/bin/bash

# Test Gemini CLI User-Agent detection
# This test verifies that the proxy detects gemini-cli user-agent and forces non-streaming

BASE_URL="http://localhost:8788"
MODEL="qwen3-30b-a3b-thinking-2507"

echo "Testing Gemini CLI User-Agent Detection"
echo "========================================"
echo ""

# Test 1: With gemini-cli user-agent (should force non-streaming)
echo "Test 1: With gemini-cli user-agent"
echo "-----------------------------------"
curl -s "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "User-Agent: gemini-cli/1.0.0" \
  -H "Authorization: Bearer test-key" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Say 'hello' in one word\"}],
    \"max_tokens\": 50,
    \"stream\": true
  }" | jq -r '.content[0].text' 2>/dev/null

if [ $? -eq 0 ]; then
    echo "✅ Non-streaming response received (gemini-cli detected)"
else
    echo "❌ Failed to parse response"
fi

echo ""
echo "Test 2: Without gemini-cli user-agent (should respect stream=true)"
echo "-------------------------------------------------------------------"
response=$(curl -s "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "User-Agent: curl/7.68.0" \
  -H "Authorization: Bearer test-key" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Say 'hello' in one word\"}],
    \"max_tokens\": 50,
    \"stream\": true
  }")

# Check if response is SSE format (starts with "data:")
if echo "$response" | head -1 | grep -q "^data:"; then
    echo "✅ SSE streaming response received (normal behavior)"
else
    echo "❌ Expected SSE format but got: $(echo "$response" | head -c 100)"
fi

echo ""
echo "Test 3: With gemini-cli user-agent and stream=false (should stay non-streaming)"
echo "--------------------------------------------------------------------------------"
curl -s "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "User-Agent: gemini-cli/1.0.0" \
  -H "Authorization: Bearer test-key" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Say 'hello' in one word\"}],
    \"max_tokens\": 50,
    \"stream\": false
  }" | jq -r '.content[0].text' 2>/dev/null

if [ $? -eq 0 ]; then
    echo "✅ Non-streaming response received"
else
    echo "❌ Failed to parse response"
fi

echo ""
echo "All tests completed!"
