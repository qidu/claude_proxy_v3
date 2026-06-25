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
#!/bin/bash

# Test deepseek-r1 across all 3 endpoints
# Uses OpenAI-compatible upstream from test_keys.md

BASE_URL="http://localhost:8788"
MODEL="deepseek-r1"

echo "=========================================="
echo "Testing deepseek-r1 on all 3 endpoints"
echo "=========================================="

# Test 1: /v1/messages
echo ""
echo "Test 1: /v1/messages endpoint"
echo "----------------------------"
RESPONSE=$(curl -s "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"What is 2+2?\"}],
    \"max_tokens\": 100
  }")

if echo "$RESPONSE" | jq -e '.content[0].text' > /dev/null 2>&1; then
  echo "✅ /v1/messages: $(echo "$RESPONSE" | jq -r '.content[0].text' | head -c 80)..."
else
  echo "❌ /v1/messages failed: $RESPONSE"
fi

# Test 2: /v1/interactions
echo ""
echo "Test 2: /v1/interactions endpoint"
echo "--------------------------------"
RESPONSE=$(curl -s "$BASE_URL/v1/interactions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d "{
    \"model\": \"$MODEL\",
    \"input\": \"What is 3+3?\"
  }")

if echo "$RESPONSE" | jq -e '.outputs[0].text' > /dev/null 2>&1; then
  echo "✅ /v1/interactions: $(echo "$RESPONSE" | jq -r '.outputs[0].text' | head -c 80)..."
else
  echo "❌ /v1/interactions failed: $RESPONSE"
fi

# Test 3: Native endpoint (should fail for non-Gemini models)
echo ""
echo "Test 3: /v1beta/models/$MODEL:generateContent endpoint"
echo "-----------------------------------------------------"
RESPONSE=$(curl -s "$BASE_URL/v1beta/models/$MODEL:generateContent" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d "{
    \"contents\": [{\"role\": \"user\", \"parts\": [{\"text\": \"What is 4+4?\"}]}]
  }")

if echo "$RESPONSE" | jq -e '.content[0].text' > /dev/null 2>&1; then
  echo "✅ Native endpoint: $(echo "$RESPONSE" | jq -r '.content[0].text' | head -c 80)..."
else
  echo "⚠️  Native endpoint (expected to work with OpenAI upstream): $RESPONSE"
fi

echo ""
echo "=========================================="
echo "deepseek-r1 testing complete"
echo "=========================================="
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

echo "Testing deepseek/deepseek-v3.2 (openai-completions mode)"
echo "========================================================="
echo "Config: Uses default upstream (https://api.qnaigc.com)"
echo

echo "Model: deepseek/deepseek-v3.2"
echo "---"
test_endpoint "1. /v1/messages" \
  "$BASE/v1/messages" \
  '{"model":"deepseek/deepseek-v3.2","messages":[{"role":"user","content":"2+2?"}],"max_tokens":50}'

test_endpoint "2. /v1/interactions" \
  "$BASE/v1/interactions" \
  '{"model":"deepseek/deepseek-v3.2","input":{"messages":[{"role":"user","content":"3+3?"}]}}'

test_endpoint "3. /v1beta/models/deepseek/deepseek-v3.2:generateContent" \
  "$BASE/v1beta/models/deepseek/deepseek-v3.2:generateContent" \
  '{"contents":[{"role":"user","parts":[{"text":"4+4?"}]}]}'

echo
echo "========================================================="
echo "Results: $PASS passed, $FAIL failed out of 3 tests"
echo "Success rate: $(( PASS * 100 / 3 ))%"

kill $SERVER_PID 2>/dev/null
