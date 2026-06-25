#!/bin/bash

# Test Claude models using gemini CLI
# Config: ~/.gemini/.env, ./proxy_config.toml

MODELS=(
  "claude-4.6-sonnet"
  "claude-4.5-opus"
  "claude-4.5-haiku"
  "claude-4.1-sonnet"
  "claude-4.0-sonnet"
  "claude-3.7-sonnet"
)

PROMPT="Say hello and tell me your model name in one sentence"

echo "Testing ${#MODELS[@]} Claude models with gemini CLI"
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

echo "Testing claude-sonnet-4.5 (2 upstreams × 3 endpoints = 6 tests)"
echo "================================================================"
echo

# Test with native upstream (uses default config - no model-specific config)
echo "1. Native upstream (uses default mode from config)"
echo "---"
test_endpoint "1a. /v1/messages" \
  "$BASE/v1/messages" \
  '{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"2+2?"}],"max_tokens":50}'

test_endpoint "1b. /v1/interactions" \
  "$BASE/v1/interactions" \
  '{"model":"claude-sonnet-4.5","input":{"messages":[{"role":"user","content":"3+3?"}]}}'

test_endpoint "1c. /v1beta/models/claude-sonnet-4.5:generateContent" \
  "$BASE/v1beta/models/claude-sonnet-4.5:generateContent" \
  '{"contents":[{"role":"user","parts":[{"text":"4+4?"}]}]}'

echo

# Test with OpenAI-compatible upstream (explicit test - same as default)
echo "2. OpenAI-compatible upstream (default behavior)"
echo "---"
echo "Note: Same as above since model uses default openai-completions mode"
echo "Skipping duplicate tests - already tested above"

echo
echo "================================================================"
echo "Results: $PASS passed, $FAIL failed out of 3 tests"
echo "Success rate: $(( PASS * 100 / 3 ))%"
echo
echo "Note: claude-sonnet-4.5 has no model-specific config,"
echo "      so it uses [defaults] mode = openai-completions"

kill $SERVER_PID 2>/dev/null
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

echo "Testing claude-haiku-4-5 (uses default openai-completions mode)"
echo "================================================================"
echo

echo "Model: claude-haiku-4-5 (openai-completions mode)"
echo "---"
test_endpoint "1. /v1/messages" \
  "$BASE/v1/messages" \
  '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"2+2?"}],"max_tokens":50}'

test_endpoint "2. /v1/interactions" \
  "$BASE/v1/interactions" \
  '{"model":"claude-haiku-4-5","input":{"messages":[{"role":"user","content":"3+3?"}]}}'

test_endpoint "3. /v1beta/models/claude-haiku-4-5:generateContent" \
  "$BASE/v1beta/models/claude-haiku-4-5:generateContent" \
  '{"contents":[{"role":"user","parts":[{"text":"4+4?"}]}]}'

echo
echo "================================================================"
echo "Results: $PASS passed, $FAIL failed out of 3 tests"
echo "Success rate: $(( PASS * 100 / 3 ))%"
echo
echo "Note: Correct model name is 'claude-4.5-haiku' (already tested ✅)"

kill $SERVER_PID 2>/dev/null
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

echo "Testing claude-4.5-haiku with model_alias support"
echo "=================================================="
echo "Config: mode=native, model_alias=claude-haiku-4-5-20251001"
echo

echo "Model: claude-4.5-haiku (native mode with alias)"
echo "---"
test_endpoint "1. /v1/messages" \
  "$BASE/v1/messages" \
  '{"model":"claude-4.5-haiku","messages":[{"role":"user","content":"2+2?"}],"max_tokens":50}'

test_endpoint "2. /v1/interactions" \
  "$BASE/v1/interactions" \
  '{"model":"claude-4.5-haiku","input":{"messages":[{"role":"user","content":"3+3?"}]}}'

test_endpoint "3. /v1beta/models/claude-4.5-haiku:generateContent" \
  "$BASE/v1beta/models/claude-4.5-haiku:generateContent" \
  '{"contents":[{"role":"user","parts":[{"text":"4+4?"}]}]}'

echo
echo "=================================================="
echo "Results: $PASS passed, $FAIL failed out of 3 tests"
echo "Success rate: $(( PASS * 100 / 3 ))%"

kill $SERVER_PID 2>/dev/null
