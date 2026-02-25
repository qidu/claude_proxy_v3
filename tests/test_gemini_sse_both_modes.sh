#!/bin/bash

cd /home/teric/win/e/dev/bot/claude_proxy_v3

# Backup config
cp proxy_config.toml proxy_config.toml.backup

echo "=========================================="
echo "Test 1: Native Gemini Mode"
echo "=========================================="

# Native mode already configured in proxy_config.toml
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_gemini_native_sse.log 2>&1 &
SERVER_PID=$!
sleep 3

NATIVE_PASS=0
NATIVE_FAIL=0

test_sse() {
  local name=$1
  local url=$2
  local data=$3
  
  RESP=$(curl -s -N "$url" -H "Content-Type: application/json" -d "$data" | head -20)
  
  if echo "$RESP" | grep -q "event:\|data:"; then
    EVENT_COUNT=$(echo "$RESP" | grep -c "^event:\|^data:")
    echo "✅ $name: SSE works ($EVENT_COUNT events)"
    return 0
  else
    echo "❌ $name: No SSE"
    return 1
  fi
}

BASE="http://localhost:8788"

echo
echo "Native Mode: gemini-2.5-flash"
echo "---"
test_sse "1. /v1/messages" \
  "$BASE/v1/messages" \
  '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"Count 1 to 3"}],"max_tokens":50,"stream":true}' && ((NATIVE_PASS++)) || ((NATIVE_FAIL++))

test_sse "2. /v1/interactions" \
  "$BASE/v1/interactions" \
  '{"model":"gemini-2.5-flash","input":{"messages":[{"role":"user","content":"Count 1 to 3"}]},"stream":true}' && ((NATIVE_PASS++)) || ((NATIVE_FAIL++))

test_sse "3. generateContent" \
  "$BASE/v1beta/models/gemini-2.5-flash:generateContent" \
  '{"contents":[{"role":"user","parts":[{"text":"Count 1 to 3"}]}],"stream":true}' && ((NATIVE_PASS++)) || ((NATIVE_FAIL++))

echo
echo "Native Mode: $NATIVE_PASS/3 passed"

kill $SERVER_PID 2>/dev/null
sleep 2

echo
echo "=========================================="
echo "Test 2: OpenAI-Compatible Mode"
echo "=========================================="

# Create config for OpenAI mode
cat > proxy_config.toml << 'EOF'
[upstream]
default_url = "https://api.qnaigc.com"
default_api_key = "sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02"

[models.gemini-2-5-flash]
mode = "openai-completions"
base_url = "https://api.qnaigc.com"
api_key = "sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02"

[defaults]
mode = "openai-completions"
EOF

PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_gemini_openai_sse.log 2>&1 &
SERVER_PID=$!
sleep 3

OPENAI_PASS=0
OPENAI_FAIL=0

echo
echo "OpenAI-Compatible Mode: gemini-2.5-flash"
echo "---"
test_sse "1. /v1/messages" \
  "$BASE/v1/messages" \
  '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"Count 1 to 3"}],"max_tokens":50,"stream":true}' && ((OPENAI_PASS++)) || ((OPENAI_FAIL++))

test_sse "2. /v1/interactions" \
  "$BASE/v1/interactions" \
  '{"model":"gemini-2.5-flash","input":{"messages":[{"role":"user","content":"Count 1 to 3"}]},"stream":true}' && ((OPENAI_PASS++)) || ((OPENAI_FAIL++))

test_sse "3. generateContent" \
  "$BASE/v1beta/models/gemini-2.5-flash:generateContent" \
  '{"contents":[{"role":"user","parts":[{"text":"Count 1 to 3"}]}],"stream":true}' && ((OPENAI_PASS++)) || ((OPENAI_FAIL++))

echo
echo "OpenAI-Compatible Mode: $OPENAI_PASS/3 passed"

kill $SERVER_PID 2>/dev/null

# Restore config
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
