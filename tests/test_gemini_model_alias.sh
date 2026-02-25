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
