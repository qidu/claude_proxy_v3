#!/bin/bash

BASE_URL="http://localhost:8788"
AUTH_HEADER="Authorization: Bearer test-key"

MODELS=(
  "gemini-3.1-pro-preview"
  "gemini-3.0-flash-preview"
)

echo "Testing Gemini 3.x models on OpenAI-compatible upstream"
echo ""

for MODEL in "${MODELS[@]}"; do
  echo "$MODEL:"
  
  # Non-stream
  echo -n "  Non-stream: "
  RESP=$(timeout 10 curl -s -X POST "$BASE_URL/v1/messages" \
    -H "Content-Type: application/json" \
    -H "$AUTH_HEADER" \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"max_tokens\":50}" 2>&1)
  
  if echo "$RESP" | grep -q '"id"'; then
    echo "✅"
  elif echo "$RESP" | grep -q '"error"'; then
    echo "❌ - $(echo "$RESP" | grep -o '"message":"[^"]*"' | head -1 | cut -d'"' -f4)"
  else
    echo "❌"
  fi
  
  # Stream
  echo -n "  Stream: "
  RESP=$(timeout 20 curl -s -X POST "$BASE_URL/v1/messages" \
    -H "Content-Type: application/json" \
    -H "$AUTH_HEADER" \
    -d "{\"model\":\"$MODEL\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"max_tokens\":50}" 2>&1)
  
  if echo "$RESP" | grep -qE "^(event:|data:)"; then
    echo "✅"
  elif echo "$RESP" | grep -q '"error"'; then
    echo "❌ - $(echo "$RESP" | grep -o '"message":"[^"]*"' | head -1 | cut -d'"' -f4)"
  else
    echo "❌"
  fi
  
  echo ""
done
#!/bin/bash

BASE_URL="http://localhost:8788"
AUTH_HEADER="Authorization: Bearer test-key"
MODEL="gemini-3.1-pro-preview"

echo "Testing: $MODEL"
echo ""

# Non-stream
echo -n "Non-stream: "
RESP=$(timeout 10 curl -s -X POST "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"max_tokens\":50}" 2>&1)

if echo "$RESP" | grep -q '"id"'; then
  echo "✅"
elif echo "$RESP" | grep -q '"error"'; then
  echo "❌ - $(echo "$RESP" | grep -o '"message":"[^"]*"' | head -1 | cut -d'"' -f4)"
else
  echo "❌ - Invalid"
fi

# Stream
echo -n "Stream: "
RESP=$(timeout 20 curl -s -X POST "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d "{\"model\":\"$MODEL\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"max_tokens\":50}" 2>&1)

if echo "$RESP" | grep -qE "^(event:|data:)"; then
  echo "✅"
elif echo "$RESP" | grep -q '"error"'; then
  echo "❌ - $(echo "$RESP" | grep -o '"message":"[^"]*"' | head -1 | cut -d'"' -f4)"
else
  echo "❌ - Invalid"
fi
#!/bin/bash

# Test Gemini models using gemini CLI
# Config: ~/.gemini/.env, ./proxy_config.toml

MODELS=(
  "gemini-2.5-flash"
  "gemini-3.1-pro-preview"
  "gemini-3.0-flash-preview"
)

PROMPT="Say hello and tell me your model name in one sentence"

echo "Testing ${#MODELS[@]} Gemini models with gemini CLI"
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

cd /home/teric/win/e/dev/bot/claude_proxy_v3

# Backup original config
cp proxy_config.toml proxy_config.toml.backup

# Add model_alias to gemini-2-5-flash
cat > proxy_config.toml << 'EOF'
[upstream]
default_url = "https://api.qnaigc.com"
default_api_key = "sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02"

[models.gemini-2-5-flash]
mode = "native"
model_alias = "gemini-2.5-flash-exp"
base_url = "https://api.example1.com"
api_key = "sk-rFaHPAoJidbsN2BMeGcEe1bjIUeU7Nr2SKzbTY1ExOJHptP0"

[defaults]
mode = "openai-completions"
EOF

echo "Starting server with model_alias test config..."
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_alias_test.log 2>&1 &
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
    echo "   Response: $RESP" | head -c 200
    ((FAIL++))
  fi
}

BASE="http://localhost:8788"

echo "Testing gemini-2.5-flash with model_alias = 'gemini-2.5-flash-exp'"
echo "=================================================================="
echo

echo "Test 1: /v1/messages"
test_endpoint "1. /v1/messages" \
  "$BASE/v1/messages" \
  '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"test"}],"max_tokens":10}'

echo
echo "Test 2: /v1/interactions"
test_endpoint "2. /v1/interactions" \
  "$BASE/v1/interactions" \
  '{"model":"gemini-2.5-flash","input":{"messages":[{"role":"user","content":"test"}]}}'

echo
echo "Test 3: /v1beta/models/gemini-2.5-flash:generateContent"
test_endpoint "3. generateContent" \
  "$BASE/v1beta/models/gemini-2.5-flash:generateContent" \
  '{"contents":[{"role":"user","parts":[{"text":"test"}]}]}'

echo
echo "=================================================================="
echo "Results: $PASS passed, $FAIL failed out of 3 tests"

# Check logs for model name being used
echo
echo "Checking logs for model name usage..."
grep -i "gemini-2.5-flash" /tmp/proxy_alias_test.log | tail -5

kill $SERVER_PID 2>/dev/null

# Restore original config
mv proxy_config.toml.backup proxy_config.toml

echo
echo "Config restored."
#!/bin/bash

cd /home/teric/win/e/dev/bot/claude_proxy_v3

# Backup original config
cp proxy_config.toml proxy_config.toml.backup

# Create test config with gemini-2.0-flash using native upstream
cat > proxy_config.toml << 'EOF'
[upstream]
default_url = "https://api.qnaigc.com"
default_api_key = "sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02"

[models.gemini-2-0-flash]
mode = "native"
base_url = "https://api.example1.com"
api_key = "sk-rFaHPAoJidbsN2BMeGcEe1bjIUeU7Nr2SKzbTY1ExOJHptP0"

[defaults]
mode = "openai-completions"
EOF

echo "Starting server with gemini-2.0-flash config..."
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_gemini20.log 2>&1 &
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

echo "Testing gemini-2.0-flash (native mode, same upstream as gemini-2.5-flash)"
echo "=========================================================================="
echo

echo "Model: gemini-2.0-flash"
echo "---"
test_endpoint "1. /v1/messages" \
  "$BASE/v1/messages" \
  '{"model":"gemini-2.0-flash","messages":[{"role":"user","content":"2+2?"}],"max_tokens":50}'

test_endpoint "2. /v1/interactions" \
  "$BASE/v1/interactions" \
  '{"model":"gemini-2.0-flash","input":{"messages":[{"role":"user","content":"3+3?"}]}}'

test_endpoint "3. /v1beta/models/gemini-2.0-flash:generateContent" \
  "$BASE/v1beta/models/gemini-2.0-flash:generateContent" \
  '{"contents":[{"role":"user","parts":[{"text":"4+4?"}]}]}'

echo
echo "=========================================================================="
echo "Results: $PASS passed, $FAIL failed out of 3 tests"
echo "Success rate: $(( PASS * 100 / 3 ))%"

# Check logs
echo
echo "Checking logs for errors..."
grep -i "error\|gemini-2.0" /tmp/proxy_gemini20.log | tail -5

kill $SERVER_PID 2>/dev/null

# Restore original config
mv proxy_config.toml.backup proxy_config.toml

echo
echo "Config restored."
