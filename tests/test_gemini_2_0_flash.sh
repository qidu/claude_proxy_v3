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
