#!/bin/bash

# Test deepseek-r1 across all 3 endpoints
# Uses OpenAI-compatible upstream from test_keys.md

BASE_URL="http://localhost:8788"
MODEL="deepseek-r1"

echo "=========================================="
echo "Testing deepseek-r1 on all 3 endpoints"
echo "=========================================="

# Test 1: /v1/messages
echo ""
echo "Test 1: /v1/messages endpoint"
echo "----------------------------"
RESPONSE=$(curl -s "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"What is 2+2?\"}],
    \"max_tokens\": 100
  }")

if echo "$RESPONSE" | jq -e '.content[0].text' > /dev/null 2>&1; then
  echo "✅ /v1/messages: $(echo "$RESPONSE" | jq -r '.content[0].text' | head -c 80)..."
else
  echo "❌ /v1/messages failed: $RESPONSE"
fi

# Test 2: /v1/interactions
echo ""
echo "Test 2: /v1/interactions endpoint"
echo "--------------------------------"
RESPONSE=$(curl -s "$BASE_URL/v1/interactions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d "{
    \"model\": \"$MODEL\",
    \"input\": \"What is 3+3?\"
  }")

if echo "$RESPONSE" | jq -e '.outputs[0].text' > /dev/null 2>&1; then
  echo "✅ /v1/interactions: $(echo "$RESPONSE" | jq -r '.outputs[0].text' | head -c 80)..."
else
  echo "❌ /v1/interactions failed: $RESPONSE"
fi

# Test 3: Native endpoint (should fail for non-Gemini models)
echo ""
echo "Test 3: /v1beta/models/$MODEL:generateContent endpoint"
echo "-----------------------------------------------------"
RESPONSE=$(curl -s "$BASE_URL/v1beta/models/$MODEL:generateContent" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d "{
    \"contents\": [{\"role\": \"user\", \"parts\": [{\"text\": \"What is 4+4?\"}]}]
  }")

if echo "$RESPONSE" | jq -e '.content[0].text' > /dev/null 2>&1; then
  echo "✅ Native endpoint: $(echo "$RESPONSE" | jq -r '.content[0].text' | head -c 80)..."
else
  echo "⚠️  Native endpoint (expected to work with OpenAI upstream): $RESPONSE"
fi

echo ""
echo "=========================================="
echo "deepseek-r1 testing complete"
echo "=========================================="
