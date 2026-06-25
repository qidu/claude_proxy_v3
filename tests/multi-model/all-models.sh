#!/bin/bash

cd /home/teric/win/e/dev/bot/claude_proxy_v3

BASE="http://localhost:8788"

# Update config
cat > proxy_config.toml << 'EOF'
[upstream]
default_url = "https://api.qnaigc.com"
default_api_key = "sk-4d01851a07d9e51729be98f9427c7f4023a58f41494f530458253b7692961ddf"

[defaults]
mode = "openai-completions"
EOF

# Start server
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_all_models.log 2>&1 &
SERVER_PID=$!
sleep 4

# Get model list
echo "Fetching model list..."
MODELS=$(curl -s "$BASE/v1/models" 2>/dev/null | jq -r '.data[].id' | head -30)

if [ -z "$MODELS" ]; then
  echo "❌ Failed to fetch models"
  kill $SERVER_PID 2>/dev/null
  exit 1
fi

echo "Testing $(echo "$MODELS" | wc -l) models..."
echo ""

TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_TESTS=0

test_model() {
  local model=$1
  local pass=0
  local fail=0
  
  echo "Testing: $model"
  
  # Non-streaming /v1/messages
  RESP=$(timeout 5 curl -s "$BASE/v1/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer sk-4d01851a07d9e51729be98f9427c7f4023a58f41494f530458253b7692961ddf" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"max_tokens\":20}" 2>/dev/null)
  if echo "$RESP" | jq -e '.id' > /dev/null 2>&1; then
    ((pass++))
  else
    ((fail++))
  fi
  
  # Streaming /v1/messages
  RESP=$(timeout 10 curl -s -N "$BASE/v1/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer sk-4d01851a07d9e51729be98f9427c7f4023a58f41494f530458253b7692961ddf" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"max_tokens\":20,\"stream\":true}" 2>/dev/null | head -1)
  if echo "$RESP" | grep -qE "^(event:|data:)"; then
    ((pass++))
  else
    ((fail++))
  fi
  
  local total=$((pass + fail))
  if [ $pass -eq $total ]; then
    echo "  ✅ $pass/$total"
  else
    echo "  ⚠️  $pass/$total"
  fi
  
  TOTAL_PASS=$((TOTAL_PASS + pass))
  TOTAL_FAIL=$((TOTAL_FAIL + fail))
  TOTAL_TESTS=$((TOTAL_TESTS + total))
}

# Test each model
while IFS= read -r model; do
  test_model "$model"
done <<< "$MODELS"

echo ""
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
#!/bin/bash

cd /home/teric/win/e/dev/bot/model_proxy_v3

BASE="http://localhost:8788"
API_KEY="sk-28f417e15b4643913bce23520d5948327c5986d4ca84647052703b2fa41af3dc"

echo "Starting server..."
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_all_models.log 2>&1 &
SERVER_PID=$!
sleep 4

echo "Fetching model list..."
MODELS=$(curl -s "$BASE/v1/models" 2>/dev/null | jq -r '.data[].id' | head -30)

if [ -z "$MODELS" ]; then
  echo "❌ Failed to fetch models"
  kill $SERVER_PID 2>/dev/null
  exit 1
fi

echo "Testing $(echo "$MODELS" | wc -l) models..."
echo

TOTAL_PASS=0
TOTAL_FAIL=0

test_model() {
  local model=$1
  local pass=0
  local fail=0
  
  echo "Testing: $model"
  
  # Non-streaming /v1/messages
  RESP=$(timeout 10 curl -s "$BASE/v1/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Baerer <API_KEY>" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"max_tokens\":20}" 2>/dev/null)
  if echo "$RESP" | jq -e '.id' > /dev/null 2>&1; then
    ((pass++))
  else
    ((fail++))
  fi
  
  # Streaming /v1/messages
  RESP=$(timeout 10 curl -s -N "$BASE/v1/messages" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"max_tokens\":20,\"stream\":true}" 2>/dev/null | head -1)
  if echo "$RESP" | grep -qE "^(event:|data:)"; then
    ((pass++))
  else
    ((fail++))
  fi
  
  local total=$((pass + fail))
  if [ $pass -eq $total ]; then
    echo "  ✅ $pass/$total"
  else
    echo "  ⚠️  $pass/$total"
  fi
  
  TOTAL_PASS=$((TOTAL_PASS + pass))
  TOTAL_FAIL=$((TOTAL_FAIL + fail))
}

while IFS= read -r model; do
  test_model "$model"
done <<< "$MODELS"

echo
echo "=========================================="
echo "Summary"
echo "=========================================="
TOTAL_TESTS=$((TOTAL_PASS + TOTAL_FAIL))
echo "Total: $TOTAL_PASS passed, $TOTAL_FAIL failed out of $TOTAL_TESTS tests"
echo "Success rate: $(awk "BEGIN {printf \"%.1f\", ($TOTAL_PASS/$TOTAL_TESTS)*100}")%"

kill $SERVER_PID 2>/dev/null
#!/bin/bash

# Comprehensive test for all models from docs/test_keys.md

BASE_URL="http://localhost:8788"
TOTAL_PASSED=0
TOTAL_FAILED=0

echo "╔══════════════════════════════════════════════════════════════════════════════╗"
echo "║              COMPREHENSIVE MODEL TESTING FROM test_keys.md                  ║"
echo "╚══════════════════════════════════════════════════════════════════════════════╝"
echo ""

# Function to test a model with all 3 endpoints
test_model() {
  local MODEL=$1
  local MODE=$2
  local UPSTREAM=$3
  local PASSED=0
  local FAILED=0
  
  echo "========================================="
  echo "Testing: $MODEL"
  echo "Mode: $MODE"
  echo "Upstream: $UPSTREAM"
  echo "========================================="
  echo ""
  
  # Test 1: /v1/messages
  echo "  Test 1: /v1/messages"
  RESPONSE=$(curl -s "$BASE_URL/v1/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test" \
    -d "{
      \"model\": \"$MODEL\",
      \"messages\": [{\"role\": \"user\", \"content\": \"What is 2+2?\"}],
      \"max_tokens\": 50
    }")
  
  if echo "$RESPONSE" | jq -e '.type == "message" and .content[0].text' > /dev/null 2>&1; then
    echo "  ✅ PASSED - $(echo "$RESPONSE" | jq -r '.content[0].text' | head -c 50)..."
    ((PASSED++))
  else
    echo "  ❌ FAILED"
    ((FAILED++))
  fi
  
  # Test 2: /v1/interactions
  echo "  Test 2: /v1/interactions"
  RESPONSE=$(curl -s "$BASE_URL/v1/interactions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test" \
    -d "{
      \"model\": \"$MODEL\",
      \"input\": \"What is the capital of France?\"
    }")
  
  if echo "$RESPONSE" | jq -e '.status == "completed" and .outputs[0].text' > /dev/null 2>&1; then
    echo "  ✅ PASSED - $(echo "$RESPONSE" | jq -r '.outputs[0].text' | head -c 50)..."
    ((PASSED++))
  else
    echo "  ❌ FAILED"
    ((FAILED++))
  fi
  
  # Test 3: Endpoint-specific test
  if [ "$MODE" = "native" ]; then
    # For Gemini, test native generateContent endpoint
    echo "  Test 3: /v1beta/models/$MODEL:generateContent"
    RESPONSE=$(curl -s "$BASE_URL/v1beta/models/$MODEL:generateContent" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer test" \
      -d '{
        "contents": [{"role": "user", "parts": [{"text": "What is 5+3?"}]}]
      }')
  else
    # For OpenAI-compatible, test multi-turn
    echo "  Test 3: /v1/messages (multi-turn)"
    RESPONSE=$(curl -s "$BASE_URL/v1/messages" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer test" \
      -d "{
        \"model\": \"$MODEL\",
        \"messages\": [
          {\"role\": \"user\", \"content\": \"Hello!\"},
          {\"role\": \"assistant\", \"content\": \"Hi!\"},
          {\"role\": \"user\", \"content\": \"What is 5+3?\"}
        ],
        \"max_tokens\": 50
      }")
  fi
  
  if echo "$RESPONSE" | jq -e '.type == "message" and .content[0].text' > /dev/null 2>&1; then
    echo "  ✅ PASSED - $(echo "$RESPONSE" | jq -r '.content[0].text' | head -c 50)..."
    ((PASSED++))
  else
    echo "  ❌ FAILED"
    ((FAILED++))
  fi
  
  echo ""
  echo "  Result: $PASSED/3 passed"
  echo ""
  
  TOTAL_PASSED=$((TOTAL_PASSED + PASSED))
  TOTAL_FAILED=$((TOTAL_FAILED + FAILED))
}

# Test 1: gemini-2.5-flash (native)
test_model "gemini-2.5-flash" "native" "https://api.example1.com"

# Test 2: minimax/minimax-m2.1 (OpenAI-compatible)
test_model "minimax/minimax-m2.1" "openai-completions" "https://api.qnaigc.com"

# Test 3: deepseek/deepseek-v3.2-exp (OpenAI-compatible)
test_model "deepseek/deepseek-v3.2-exp" "openai-completions" "https://api.qnaigc.com"

# Test 4: z-ai/glm-5 (OpenAI-compatible)
test_model "z-ai/glm-5" "openai-completions" "https://api.qnaigc.com"

# Summary
echo "╔══════════════════════════════════════════════════════════════════════════════╗"
echo "║                           FINAL SUMMARY                                      ║"
echo "╚══════════════════════════════════════════════════════════════════════════════╝"
echo ""
echo "Total Models Tested: 4"
echo "Total Tests: 12 (3 endpoints × 4 models)"
echo "Passed: $TOTAL_PASSED"
echo "Failed: $TOTAL_FAILED"
echo ""

if [ $TOTAL_FAILED -eq 0 ]; then
  echo "✅ ALL TESTS PASSED!"
  exit 0
else
  echo "❌ Some tests failed"
  exit 1
fi
#!/bin/bash

# Test script for Claude Proxy v3
# Tests multiple models via /v1/messages endpoint

API_KEY="sk-87abde0542f469130******"
BASE_URL="http://localhost:8788"

echo "=== Claude Proxy v3 Test Suite ==="
echo ""

# Test 1: deepseek-v3.2-exp
echo "Test 1: deepseek-v3.2-exp"
curl -s "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "deepseek/deepseek-v3.2-exp",
    "messages": [{"role": "user", "content": "What is 5+3?"}],
    "max_tokens": 50
  }' | jq -r '.content[0].text // .error.message'
echo ""

# Test 2: minimax-m2.5
echo "Test 2: minimax-m2.5"
curl -s "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "minimax/minimax-m2.5",
    "messages": [{"role": "user", "content": "What is 5+3?"}],
    "max_tokens": 50
  }' | jq -r '.content[0].text // .error.message'
echo ""

# Test 3: deepseek-r1-0528
echo "Test 3: deepseek-r1-0528"
curl -s "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "deepseek-r1-0528",
    "messages": [{"role": "user", "content": "What is 5+3?"}],
    "max_tokens": 50
  }' | jq -r '.content[0].text // .error.message'
echo ""

echo "=== Test Complete ==="
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

# Models to test (all use openai-completions mode with default upstream)
MODELS=(
  "deepseek/deepseek-v3.2"
  "minimax/minimax-m2.1"
  "z-ai/glm-5"
  "gpt-oss-120b"
  "deepseek-r1"
)

echo "Testing 5 models × 3 endpoints = 15 tests"
echo "=========================================="
echo "All models use openai-completions mode with default upstream"
echo

for model in "${MODELS[@]}"; do
  echo "Model: $model"
  echo "---"
  
  test_endpoint "1. /v1/messages" \
    "$BASE/v1/messages" \
    "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"2+2?\"}],\"max_tokens\":50}"
  
  test_endpoint "2. /v1/interactions" \
    "$BASE/v1/interactions" \
    "{\"model\":\"$model\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"3+3?\"}]}}"
  
  test_endpoint "3. /v1beta/models/$model:generateContent" \
    "$BASE/v1beta/models/$model:generateContent" \
    "{\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"4+4?\"}]}]}"
  
  echo
done

echo "=========================================="
echo "Results: $PASS passed, $FAIL failed out of 15 tests"
echo "Success rate: $(( PASS * 100 / 15 ))%"

kill $SERVER_PID 2>/dev/null
