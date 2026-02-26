#!/bin/bash

cd /home/teric/win/e/dev/bot/claude_proxy_v3

MODEL="minimax/minimax-m2.5"
BASE="http://localhost:8788"

echo "=========================================="
echo "Testing: MiniMax M2.5"
echo "=========================================="
echo ""

# Update config
cat > proxy_config.toml << 'EOF'
[upstream]
default_url = "https://api.qnaigc.com"
default_api_key = "sk-4d01851a07d9e51729be98f9427c7f4023a58f41494f530458253b7692961ddf"

[models.minimax-minimax-m2-5]
mode = "openai-completions"
EOF

# Start server
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_minimax_test.log 2>&1 &
SERVER_PID=$!
sleep 4

PASS=0
FAIL=0

echo "Non-Streaming Tests:"
echo "---"

echo -n "  /v1/messages: "
RESP=$(curl -s "$BASE/v1/messages" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"max_tokens\":50}")
if echo "$RESP" | jq -e '.id' > /dev/null 2>&1; then
  echo "✅ $(echo "$RESP" | jq -r '.id')"
  ((PASS++))
else
  echo "❌ $(echo "$RESP" | jq -r '.error.message // "Failed"')"
  ((FAIL++))
fi

echo -n "  /v1/interactions: "
RESP=$(curl -s "$BASE/v1/interactions" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}]}}")
if echo "$RESP" | jq -e '.id' > /dev/null 2>&1; then
  echo "✅ $(echo "$RESP" | jq -r '.id')"
  ((PASS++))
else
  echo "❌ $(echo "$RESP" | jq -r '.error.message // "Failed"')"
  ((FAIL++))
fi

echo -n "  generateContent: "
RESP=$(curl -s "$BASE/v1beta/models/$MODEL:generateContent" -H "Content-Type: application/json" \
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
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Count 1 to 3\"}],\"max_tokens\":100,\"stream\":true}" 2>/dev/null | head -1)
if echo "$RESP" | grep -qE "^(event:|data:)"; then
  echo "✅ SSE"
  ((PASS++))
else
  echo "❌ No SSE"
  ((FAIL++))
fi

echo -n "  /v1/interactions (stream): "
RESP=$(timeout 10 curl -s -N "$BASE/v1/interactions" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"Count 1 to 3\"}]},\"stream\":true}" 2>/dev/null | head -1)
if echo "$RESP" | grep -qE "^(event:|data:)"; then
  echo "✅ SSE"
  ((PASS++))
else
  echo "❌ No SSE"
  ((FAIL++))
fi

echo -n "  streamGenerateContent: "
RESP=$(timeout 10 curl -s -N "$BASE/v1beta/models/$MODEL:streamGenerateContent" -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Count 1 to 3"}]}]}' 2>/dev/null | head -1)
if echo "$RESP" | grep -qE "^(event:|data:)"; then
  echo "✅ SSE"
  ((PASS++))
else
  echo "❌ No SSE"
  ((FAIL++))
fi

echo ""
echo "Results: $PASS passed, $FAIL failed out of 6 tests"
echo ""

# Cleanup
kill $SERVER_PID 2>/dev/null
sleep 2

echo "=========================================="
echo "Test Complete"
echo "=========================================="
