#!/bin/bash

cd /home/teric/win/e/dev/bot/claude_proxy_v3

BASE="http://localhost:8788"

test_model() {
  local model=$1
  local display_name=$2
  
  echo "=========================================="
  echo "Testing: $display_name"
  echo "=========================================="
  echo ""
  
  PASS=0
  FAIL=0
  
  echo "Non-Streaming Tests:"
  echo "---"
  
  echo -n "  /v1/messages: "
  RESP=$(curl -s "$BASE/v1/messages" -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"max_tokens\":50}")
  if echo "$RESP" | jq -e '.id' > /dev/null 2>&1; then
    echo "✅ $(echo "$RESP" | jq -r '.id')"
    ((PASS++))
  else
    echo "❌ $(echo "$RESP" | jq -r '.error.message // "Failed"')"
    ((FAIL++))
  fi
  
  echo -n "  /v1/interactions: "
  RESP=$(curl -s "$BASE/v1/interactions" -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}]}}")
  if echo "$RESP" | jq -e '.id' > /dev/null 2>&1; then
    echo "✅ $(echo "$RESP" | jq -r '.id')"
    ((PASS++))
  else
    echo "❌ $(echo "$RESP" | jq -r '.error.message // "Failed"')"
    ((FAIL++))
  fi
  
  echo -n "  generateContent: "
  RESP=$(curl -s "$BASE/v1beta/models/$model:generateContent" -H "Content-Type: application/json" \
    -d '{"contents":[{"role":"user","parts":[{"text":"Hi"}]}]}')
  if echo "$RESP" | jq -e '.id' > /dev/null 2>&1; then
    echo "✅ $(echo "$RESP" | jq -r '.id')"
    ((PASS++))
  else
    echo "❌ $(echo "$RESP" | jq -r '.error.message // "Failed"')"
    ((FAIL++))
  fi
  
  echo ""
  echo "Streaming Tests:"
  echo "---"
  
  echo -n "  /v1/messages (stream): "
  RESP=$(timeout 10 curl -s -N "$BASE/v1/messages" -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Count 1 to 3\"}],\"max_tokens\":100,\"stream\":true}" 2>/dev/null | head -1)
  if echo "$RESP" | grep -qE "^(event:|data:)"; then
    echo "✅ SSE"
    ((PASS++))
  else
    echo "❌ No SSE"
    ((FAIL++))
  fi
  
  echo -n "  /v1/interactions (stream): "
  RESP=$(timeout 10 curl -s -N "$BASE/v1/interactions" -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"Count 1 to 3\"}]},\"stream\":true}" 2>/dev/null | head -1)
  if echo "$RESP" | grep -q "data:"; then
    echo "✅ SSE"
    ((PASS++))
  else
    echo "❌ No SSE"
    ((FAIL++))
  fi
  
  echo -n "  streamGenerateContent: "
  RESP=$(timeout 10 curl -s -N "$BASE/v1beta/models/$model:streamGenerateContent" -H "Content-Type: application/json" \
    -d '{"contents":[{"role":"user","parts":[{"text":"Count 1 to 3"}]}]}' 2>/dev/null | head -1)
  if echo "$RESP" | grep -q "data:"; then
    echo "✅ SSE"
    ((PASS++))
  else
    echo "❌ No SSE"
    ((FAIL++))
  fi
  
  echo ""
  echo "Results: $PASS passed, $FAIL failed out of 6 tests"
  echo ""
}

# Update config for OpenAI-compatible mode
cat > proxy_config.toml << 'EOF'
[upstream]
default_url = "https://api.qnaigc.com"
default_api_key = "sk-4d01851a07d9e51729be98f9427c7f4023a58f41494f530458253b7692961ddf"

[models.deepseek-deepseek-v3-2]
mode = "openai-completions"

[models.deepseek-r1]
mode = "openai-completions"
EOF

# Start server
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_deepseek_test.log 2>&1 &
SERVER_PID=$!
sleep 4

# Test models
test_model "deepseek/deepseek-v3.2" "DeepSeek V3.2"
test_model "deepseek-r1" "DeepSeek R1"

# Cleanup
kill $SERVER_PID 2>/dev/null
sleep 2

echo "=========================================="
echo "Test Complete"
echo "=========================================="
