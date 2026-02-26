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
