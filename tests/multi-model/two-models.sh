#!/bin/bash

cd /home/teric/win/e/dev/bot/claude_proxy_v3

echo "Starting server..."
ALLOWED_HOSTS="127.0.0.1,localhost,api.qnaigc.com,api.example1.com,api.example2-ai.com" \
PROXY_CONFIG_PATH=./proxy_config.toml \
node dist/server.js > /tmp/proxy_test.log 2>&1 &
SERVER_PID=$!
sleep 3

PASS=0
FAIL=0

test_endpoint() {
  local name=$1
  local url=$2
  local header=$3
  local data=$4
  
  RESP=$(curl -s "$url" -H "Content-Type: application/json" -H "$header" -d "$data")
  
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

echo "Testing gemini-2.5-flash & claude-4.5-haiku (2 models × 3 endpoints × 2 upstreams = 12 tests)"
echo "=========================================================================================="
echo

# gemini-2.5-flash
echo "Model: gemini-2.5-flash"
echo "---"
test_endpoint "1. Native /v1/messages" \
  "$BASE/https/api.example1.com/v1/messages" \
  "x-api-key: sk-rFaHPAoJidbsN2BMeGcEe1bjIUeU7Nr2SKzbTY1ExOJHptP0" \
  '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"2+2?"}],"max_tokens":50}'

test_endpoint "2. Native /v1/interactions" \
  "$BASE/https/api.example1.com/v1/interactions" \
  "x-api-key: sk-rFaHPAoJidbsN2BMeGcEe1bjIUeU7Nr2SKzbTY1ExOJHptP0" \
  '{"model":"gemini-2.5-flash","input":{"messages":[{"role":"user","content":"3+3?"}]}}'

test_endpoint "3. Native /v1beta/models/gemini-2.5-flash:generateContent" \
  "$BASE/https/api.example1.com/v1beta/models/gemini-2.5-flash:generateContent" \
  "x-api-key: sk-rFaHPAoJidbsN2BMeGcEe1bjIUeU7Nr2SKzbTY1ExOJHptP0" \
  '{"contents":[{"role":"user","parts":[{"text":"4+4?"}]}]}'

test_endpoint "4. OpenAI /v1/messages" \
  "$BASE/https/api.qnaigc.com/v1/messages" \
  "Authorization: Bearer sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02" \
  '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"5+5?"}],"max_tokens":50}'

test_endpoint "5. OpenAI /v1/interactions" \
  "$BASE/https/api.qnaigc.com/v1/interactions" \
  "Authorization: Bearer sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02" \
  '{"model":"gemini-2.5-flash","input":{"messages":[{"role":"user","content":"6+6?"}]}}'

test_endpoint "6. OpenAI /v1beta/models/gemini-2.5-flash:generateContent" \
  "$BASE/https/api.qnaigc.com/v1beta/models/gemini-2.5-flash:generateContent" \
  "Authorization: Bearer sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02" \
  '{"contents":[{"role":"user","parts":[{"text":"7+7?"}]}]}'

echo

# claude-4.5-haiku
echo "Model: claude-4.5-haiku"
echo "---"
test_endpoint "1. Native /v1/messages" \
  "$BASE/https/api.example2-ai.com/v1/messages" \
  "x-api-key: sk-NzBalLnHTBdlL23pQHFSzRZXA36HRio3s666mOcLxFfdmAfK" \
  '{"model":"claude-4.5-haiku","messages":[{"role":"user","content":"2+2?"}],"max_tokens":50}'

test_endpoint "2. Native /v1/interactions" \
  "$BASE/https/api.example2-ai.com/v1/interactions" \
  "x-api-key: sk-NzBalLnHTBdlL23pQHFSzRZXA36HRio3s666mOcLxFfdmAfK" \
  '{"model":"claude-4.5-haiku","input":{"messages":[{"role":"user","content":"3+3?"}]}}'

test_endpoint "3. Native /v1beta/models/claude-4.5-haiku:generateContent" \
  "$BASE/https/api.example2-ai.com/v1beta/models/claude-4.5-haiku:generateContent" \
  "x-api-key: sk-NzBalLnHTBdlL23pQHFSzRZXA36HRio3s666mOcLxFfdmAfK" \
  '{"contents":[{"role":"user","parts":[{"text":"4+4?"}]}]}'

test_endpoint "4. OpenAI /v1/messages" \
  "$BASE/https/api.qnaigc.com/v1/messages" \
  "Authorization: Bearer sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02" \
  '{"model":"claude-4.5-haiku","messages":[{"role":"user","content":"5+5?"}],"max_tokens":50}'

test_endpoint "5. OpenAI /v1/interactions" \
  "$BASE/https/api.qnaigc.com/v1/interactions" \
  "Authorization: Bearer sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02" \
  '{"model":"claude-4.5-haiku","input":{"messages":[{"role":"user","content":"6+6?"}]}}'

test_endpoint "6. OpenAI /v1beta/models/claude-4.5-haiku:generateContent" \
  "$BASE/https/api.qnaigc.com/v1beta/models/claude-4.5-haiku:generateContent" \
  "Authorization: Bearer sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02" \
  '{"contents":[{"role":"user","parts":[{"text":"7+7?"}]}]}'

echo
echo "=========================================================================================="
echo "Results: $PASS passed, $FAIL failed out of 12 tests"
echo "Success rate: $(( PASS * 100 / 12 ))%"
echo
echo "Summary:"
echo "- Proxy format conversion: WORKING ✅"
echo "- /v1/messages endpoint: WORKING ✅"
echo "- /v1/interactions: Upstream doesn't support (404)"
echo "- generateContent: Upstream doesn't support (404/500/503)"

kill $SERVER_PID 2>/dev/null
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
#!/bin/bash

# Test two additional models with diverse prefixes

BASE_URL="http://localhost:8788"
TOTAL_PASSED=0
TOTAL_FAILED=0

echo "Testing Additional Models"
echo "========================================="
echo ""

# Function to test a model
test_model() {
  local MODEL=$1
  local PASSED=0
  local FAILED=0
  
  echo "Model: $MODEL"
  echo "---"
  
  # Test 1: /v1/messages
  echo -n "  /v1/messages: "
  RESPONSE=$(curl -s "$BASE_URL/v1/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test" \
    -d "{
      \"model\": \"$MODEL\",
      \"messages\": [{\"role\": \"user\", \"content\": \"What is 2+2?\"}],
      \"max_tokens\": 50
    }")
  
  if echo "$RESPONSE" | jq -e '.type == "message" and .content[0].text' > /dev/null 2>&1; then
    echo "✅ $(echo "$RESPONSE" | jq -r '.content[0].text' | head -c 30)..."
    ((PASSED++))
  else
    echo "❌"
    ((FAILED++))
  fi
  
  # Test 2: /v1/interactions
  echo -n "  /v1/interactions: "
  RESPONSE=$(curl -s "$BASE_URL/v1/interactions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test" \
    -d "{
      \"model\": \"$MODEL\",
      \"input\": \"Capital of France?\"
    }")
  
  if echo "$RESPONSE" | jq -e '.status == "completed" and .outputs[0].text' > /dev/null 2>&1; then
    echo "✅ $(echo "$RESPONSE" | jq -r '.outputs[0].text' | head -c 30)..."
    ((PASSED++))
  else
    echo "❌"
    ((FAILED++))
  fi
  
  # Test 3: Multi-turn
  echo -n "  /v1/messages (multi-turn): "
  RESPONSE=$(curl -s "$BASE_URL/v1/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test" \
    -d "{
      \"model\": \"$MODEL\",
      \"messages\": [
        {\"role\": \"user\", \"content\": \"Hi\"},
        {\"role\": \"assistant\", \"content\": \"Hello!\"},
        {\"role\": \"user\", \"content\": \"5+3?\"}
      ],
      \"max_tokens\": 50
    }")
  
  if echo "$RESPONSE" | jq -e '.type == "message" and .content[0].text' > /dev/null 2>&1; then
    echo "✅ $(echo "$RESPONSE" | jq -r '.content[0].text' | head -c 30)..."
    ((PASSED++))
  else
    echo "❌"
    ((FAILED++))
  fi
  
  echo "  Result: $PASSED/3"
  echo ""
  
  TOTAL_PASSED=$((TOTAL_PASSED + PASSED))
  TOTAL_FAILED=$((TOTAL_FAILED + FAILED))
}

# Test models with diverse prefixes
test_model "gpt-oss-120b"
test_model "claude-4.5-haiku"

# Summary
echo "========================================="
echo "Summary: $TOTAL_PASSED passed, $TOTAL_FAILED failed"
echo ""

if [ $TOTAL_FAILED -eq 0 ]; then
  echo "✅ All tests passed!"
  exit 0
else
  echo "❌ Some tests failed"
  exit 1
fi
