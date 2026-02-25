#!/bin/bash

cd /home/teric/win/e/dev/bot/claude_proxy_v3

# Backup original config
cp proxy_config.toml proxy_config.toml.backup

echo "=========================================="
echo "Test 1: Native Mode"
echo "=========================================="

# Create config for native mode
cat > proxy_config.toml << 'EOF'
[upstream]
default_url = "https://api.qnaigc.com"
default_api_key = "sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02"

[models.claude-4-5-haiku]
mode = "native"
model_alias = "claude-haiku-4-5-20251001"
base_url = "https://api.wenwen-ai.com"
api_key = "sk-NzBalLnHTBdlL23pQHFSzRZXA36HRio3s666mOcLxFfdmAfK"

[defaults]
mode = "openai-completions"
EOF

echo "Starting server with native mode..."
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_haiku_native.log 2>&1 &
SERVER_PID=$!
sleep 3

NATIVE_PASS=0
NATIVE_FAIL=0

test_endpoint() {
  local name=$1
  local url=$2
  local data=$3
  
  RESP=$(curl -s "$url" -H "Content-Type: application/json" -d "$data")
  
  if echo "$RESP" | jq -e '.id' > /dev/null 2>&1 && ! echo "$RESP" | jq -e '.error' > /dev/null 2>&1; then
    ID=$(echo "$RESP" | jq -r '.id')
    echo "✅ $name: $ID"
    return 0
  else
    ERROR=$(echo "$RESP" | jq -r '.error.message // .message // "Unknown error"' 2>/dev/null || echo "Failed")
    echo "❌ $name: $ERROR"
    return 1
  fi
}

BASE="http://localhost:8788"

echo
echo "Native Mode: claude-4.5-haiku"
echo "---"
test_endpoint "1. /v1/messages" \
  "$BASE/v1/messages" \
  '{"model":"claude-4.5-haiku","messages":[{"role":"user","content":"2+2?"}],"max_tokens":50}' && ((NATIVE_PASS++)) || ((NATIVE_FAIL++))

test_endpoint "2. /v1/interactions" \
  "$BASE/v1/interactions" \
  '{"model":"claude-4.5-haiku","input":{"messages":[{"role":"user","content":"3+3?"}]}}' && ((NATIVE_PASS++)) || ((NATIVE_FAIL++))

test_endpoint "3. generateContent" \
  "$BASE/v1beta/models/claude-4.5-haiku:generateContent" \
  '{"contents":[{"role":"user","parts":[{"text":"4+4?"}]}]}' && ((NATIVE_PASS++)) || ((NATIVE_FAIL++))

echo
echo "Native Mode Results: $NATIVE_PASS passed, $NATIVE_FAIL failed"

kill $SERVER_PID 2>/dev/null
sleep 2

echo
echo "=========================================="
echo "Test 2: OpenAI-Compatible Mode"
echo "=========================================="

# Create config for OpenAI-compatible mode
cat > proxy_config.toml << 'EOF'
[upstream]
default_url = "https://api.qnaigc.com"
default_api_key = "sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02"

[models.claude-4-5-haiku]
mode = "openai-completions"
base_url = "https://api.qnaigc.com"
api_key = "sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02"

[defaults]
mode = "openai-completions"
EOF

echo "Starting server with OpenAI-compatible mode..."
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_haiku_openai.log 2>&1 &
SERVER_PID=$!
sleep 3

OPENAI_PASS=0
OPENAI_FAIL=0

echo
echo "OpenAI-Compatible Mode: claude-4.5-haiku"
echo "---"
test_endpoint "1. /v1/messages" \
  "$BASE/v1/messages" \
  '{"model":"claude-4.5-haiku","messages":[{"role":"user","content":"2+2?"}],"max_tokens":50}' && ((OPENAI_PASS++)) || ((OPENAI_FAIL++))

test_endpoint "2. /v1/interactions" \
  "$BASE/v1/interactions" \
  '{"model":"claude-4.5-haiku","input":{"messages":[{"role":"user","content":"3+3?"}]}}' && ((OPENAI_PASS++)) || ((OPENAI_FAIL++))

test_endpoint "3. generateContent" \
  "$BASE/v1beta/models/claude-4.5-haiku:generateContent" \
  '{"contents":[{"role":"user","parts":[{"text":"4+4?"}]}]}' && ((OPENAI_PASS++)) || ((OPENAI_FAIL++))

echo
echo "OpenAI-Compatible Mode Results: $OPENAI_PASS passed, $OPENAI_FAIL failed"

kill $SERVER_PID 2>/dev/null

# Restore original config
mv proxy_config.toml.backup proxy_config.toml

echo
echo "=========================================="
echo "Summary"
echo "=========================================="
echo "Native Mode: $NATIVE_PASS/3 passed ($(( NATIVE_PASS * 100 / 3 ))%)"
echo "OpenAI-Compatible Mode: $OPENAI_PASS/3 passed ($(( OPENAI_PASS * 100 / 3 ))%)"
echo "Total: $(( NATIVE_PASS + OPENAI_PASS ))/6 passed ($(( (NATIVE_PASS + OPENAI_PASS) * 100 / 6 ))%)"
echo
echo "Config restored."
