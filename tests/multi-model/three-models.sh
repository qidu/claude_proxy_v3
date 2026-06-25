#!/bin/bash

BASE_URL="http://localhost:8788"

# Gemini native
GEMINI_BASE="https/api.example1.com"
GEMINI_KEY="sk-rFaHPAoJidbsN2BMeGcEe1bjIUeU7Nr2SKzbTY1ExOJHptP0"

# Claude native
CLAUDE_BASE="https/api.example2-ai.com"
CLAUDE_KEY="sk-NzBalLnHTBdlL23pQHFSzRZXA36HRio3s666mOcLxFfdmAfK"

# OpenAI-compatible
OPENAI_BASE="https/api.qnaigc.com"
OPENAI_KEY="sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02"

MODELS=("gemini-2.5-flash" "claude-4.5-sonnet" "claude-4.5-haiku")
ENDPOINTS=("v1/messages" "v1/interactions")

test_model() {
  local model=$1
  local endpoint=$2
  local base=$3
  local key=$4
  local auth_type=$5
  local q=$6
  
  if [[ "$auth_type" == "bearer" ]]; then
    local auth_header="Authorization: Bearer $key"
  else
    local auth_header="x-api-key: $key"
  fi
  
  if [[ "$endpoint" == "v1/messages" ]]; then
    RESP=$(curl -s "$BASE_URL/$base/$endpoint" -H "Content-Type: application/json" -H "$auth_header" \
      -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"$q\"}],\"max_tokens\":50}")
    echo "$RESP" | jq -r '.content[0].text // .error.message // "✅ " + (.id // "ok")'
  elif [[ "$endpoint" == "v1/interactions" ]]; then
    RESP=$(curl -s "$BASE_URL/$base/$endpoint" -H "Content-Type: application/json" -H "$auth_header" \
      -d "{\"model\":\"$model\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"$q\"}]}}")
    echo "$RESP" | jq -r '.outputs[0].content[0].text // .error.message // "✅ " + (.id // "ok")'
  else
    RESP=$(curl -s "$BASE_URL/$base/v1beta/models/$model:generateContent" -H "Content-Type: application/json" -H "$auth_header" \
      -d "{\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"$q\"}]}]}")
    echo "$RESP" | jq -r '.content[0].text // .error.message // "✅ " + (.id // "ok")'
  fi
}

echo "Testing 3 models × 3 endpoints × 2 upstreams = 18 tests"
echo "========================================================"
echo

for model in "${MODELS[@]}"; do
  echo "Model: $model"
  echo "---"
  
  # Determine native upstream
  if [[ "$model" == "gemini-2.5-flash" ]]; then
    NATIVE_BASE=$GEMINI_BASE
    NATIVE_KEY=$GEMINI_KEY
    AUTH="apikey"
  else
    NATIVE_BASE=$CLAUDE_BASE
    NATIVE_KEY=$CLAUDE_KEY
    AUTH="apikey"
  fi
  
  # Test native endpoints
  echo "1. Native /v1/messages: $(test_model "$model" "v1/messages" "$NATIVE_BASE" "$NATIVE_KEY" "$AUTH" "2+2?")"
  echo "2. Native /v1/interactions: $(test_model "$model" "v1/interactions" "$NATIVE_BASE" "$NATIVE_KEY" "$AUTH" "3+3?")"
  echo "3. Native /v1beta/models/$model:generateContent: $(test_model "$model" "generateContent" "$NATIVE_BASE" "$NATIVE_KEY" "$AUTH" "4+4?")"
  
  # Test OpenAI-compatible endpoints
  echo "4. OpenAI /v1/messages: $(test_model "$model" "v1/messages" "$OPENAI_BASE" "$OPENAI_KEY" "bearer" "5+5?")"
  echo "5. OpenAI /v1/interactions: $(test_model "$model" "v1/interactions" "$OPENAI_BASE" "$OPENAI_KEY" "bearer" "6+6?")"
  echo "6. OpenAI /v1beta/models/$model:generateContent: $(test_model "$model" "generateContent" "$OPENAI_BASE" "$OPENAI_KEY" "bearer" "7+7?")"
  echo
done

echo "========================================================"
echo "✅ All 18 tests completed"
#!/bin/bash

cd /home/teric/win/e/dev/bot/claude_proxy_v3

echo "Starting server..."
ALLOWED_HOSTS="127.0.0.1,localhost,api.qnaigc.com,api.example1.com,api.example2-ai.com" \
PROXY_CONFIG_PATH=./proxy_config.toml \
node dist/server.js > /tmp/proxy_test.log 2>&1 &
SERVER_PID=$!
sleep 3

echo "Testing 3 models × 3 endpoints × 2 upstreams = 18 tests"
echo "========================================================"
echo

# Test counters
PASS=0
FAIL=0

test_endpoint() {
  local name=$1
  local url=$2
  local header=$3
  local data=$4
  
  RESP=$(curl -s "$url" -H "Content-Type: application/json" -H "$header" -d "$data")
  
  # Check for success (has id field and no error)
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

# claude-4.5-sonnet
echo "Model: claude-4.5-sonnet"
echo "---"
test_endpoint "1. Native /v1/messages" \
  "$BASE/https/api.example2-ai.com/v1/messages" \
  "x-api-key: sk-NzBalLnHTBdlL23pQHFSzRZXA36HRio3s666mOcLxFfdmAfK" \
  '{"model":"claude-4.5-sonnet","messages":[{"role":"user","content":"2+2?"}],"max_tokens":50}'

test_endpoint "2. Native /v1/interactions" \
  "$BASE/https/api.example2-ai.com/v1/interactions" \
  "x-api-key: sk-NzBalLnHTBdlL23pQHFSzRZXA36HRio3s666mOcLxFfdmAfK" \
  '{"model":"claude-4.5-sonnet","input":{"messages":[{"role":"user","content":"3+3?"}]}}'

test_endpoint "3. Native /v1beta/models/claude-4.5-sonnet:generateContent" \
  "$BASE/https/api.example2-ai.com/v1beta/models/claude-4.5-sonnet:generateContent" \
  "x-api-key: sk-NzBalLnHTBdlL23pQHFSzRZXA36HRio3s666mOcLxFfdmAfK" \
  '{"contents":[{"role":"user","parts":[{"text":"4+4?"}]}]}'

test_endpoint "4. OpenAI /v1/messages" \
  "$BASE/https/api.qnaigc.com/v1/messages" \
  "Authorization: Bearer sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02" \
  '{"model":"claude-4.5-sonnet","messages":[{"role":"user","content":"5+5?"}],"max_tokens":50}'

test_endpoint "5. OpenAI /v1/interactions" \
  "$BASE/https/api.qnaigc.com/v1/interactions" \
  "Authorization: Bearer sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02" \
  '{"model":"claude-4.5-sonnet","input":{"messages":[{"role":"user","content":"6+6?"}]}}'

test_endpoint "6. OpenAI /v1beta/models/claude-4.5-sonnet:generateContent" \
  "$BASE/https/api.qnaigc.com/v1beta/models/claude-4.5-sonnet:generateContent" \
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
echo "========================================================"
echo "Results: $PASS passed, $FAIL failed out of 18 tests"
echo "Success rate: $(( PASS * 100 / 18 ))%"

# Cleanup
kill $SERVER_PID 2>/dev/null
#!/bin/bash

cd /home/teric/win/e/dev/bot/claude_proxy_v3

echo "Starting server..."
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_random3.log 2>&1 &
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
    ERROR=$(echo "$RESP" | jq -r '.error.message // .message // "Unknown error"' 2>/dev/null || echo "Failed")
    echo "❌ $name: $ERROR"
    ((FAIL++))
  fi
}

BASE="http://localhost:8788"

# Test 3 random models
MODELS=(
  "deepseek/deepseek-v3.1-terminus"
  "qwen3-30b-a3b"
  "qwen-vl-max-2025-01-25"
)

echo "Testing 3 random models on all 3 endpoints"
echo "========================================================="
echo

for MODEL in "${MODELS[@]}"; do
  echo "Model: $MODEL"
  echo "---"
  
  test_endpoint "  /v1/messages" \
    "$BASE/v1/messages" \
    "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"2+2?\"}],\"max_tokens\":50}"
  
  test_endpoint "  /v1/interactions" \
    "$BASE/v1/interactions" \
    "{\"model\":\"$MODEL\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"3+3?\"}]}}"
  
  test_endpoint "  generateContent" \
    "$BASE/v1beta/models/$MODEL:generateContent" \
    '{"contents":[{"role":"user","parts":[{"text":"4+4?"}]}]}'
  
  echo
done

echo "========================================================="
echo "Total: $PASS passed, $FAIL failed out of 9 tests"
echo "Success rate: $(( PASS * 100 / 9 ))%"

kill $SERVER_PID 2>/dev/null
#!/bin/bash

cd /home/teric/win/e/dev/bot/claude_proxy_v3

echo "Starting server..."
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_random3_new.log 2>&1 &
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
    ERROR=$(echo "$RESP" | jq -r '.error.message // .message // "Unknown error"' 2>/dev/null || echo "Failed")
    echo "❌ $name: $ERROR"
    ((FAIL++))
  fi
}

BASE="http://localhost:8788"

# Test 3 new random models
MODELS=(
  "qwen3-next-80b-a3b-thinking"
  "doubao-1.5-vision-pro"
  "deepseek-r1-0528"
)

echo "Testing 3 new random models on all 3 endpoints"
echo "========================================================="
echo

for MODEL in "${MODELS[@]}"; do
  echo "Model: $MODEL"
  echo "---"
  
  test_endpoint "  /v1/messages" \
    "$BASE/v1/messages" \
    "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"2+2?\"}],\"max_tokens\":50}"
  
  test_endpoint "  /v1/interactions" \
    "$BASE/v1/interactions" \
    "{\"model\":\"$MODEL\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"3+3?\"}]}}"
  
  test_endpoint "  generateContent" \
    "$BASE/v1beta/models/$MODEL:generateContent" \
    '{"contents":[{"role":"user","parts":[{"text":"4+4?"}]}]}'
  
  echo
done

echo "========================================================="
echo "Total: $PASS passed, $FAIL failed out of 9 tests"
echo "Success rate: $(( PASS * 100 / 9 ))%"

kill $SERVER_PID 2>/dev/null
