#!/bin/bash

# Test gemini-2.5-flash with all 3 endpoints

BASE_URL="http://localhost:8788"
MODEL="gemini-2.5-flash"
PASSED=0
FAILED=0

echo "========================================="
echo "Testing gemini-2.5-flash (Native API)"
echo "========================================="
echo ""

# Test 1: /v1/messages
echo "Test 1: /v1/messages endpoint"
RESPONSE=$(curl -s "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"What is 2+2?\"}],
    \"max_tokens\": 50
  }")

if echo "$RESPONSE" | jq -e '.type == "message" and .content[0].text' > /dev/null 2>&1; then
  echo "✅ PASSED"
  echo "Response: $(echo "$RESPONSE" | jq -r '.content[0].text' | head -1)"
  ((PASSED++))
else
  echo "❌ FAILED"
  echo "$RESPONSE" | jq .
  ((FAILED++))
fi
echo ""

# Test 2: /v1/interactions
echo "Test 2: /v1/interactions endpoint"
RESPONSE=$(curl -s "$BASE_URL/v1/interactions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d "{
    \"model\": \"$MODEL\",
    \"input\": \"What is the capital of France?\"
  }")

if echo "$RESPONSE" | jq -e '.status == "completed" and .outputs[0].text' > /dev/null 2>&1; then
  echo "✅ PASSED"
  echo "Response: $(echo "$RESPONSE" | jq -r '.outputs[0].text' | head -1)"
  ((PASSED++))
else
  echo "❌ FAILED"
  echo "$RESPONSE" | jq .
  ((FAILED++))
fi
echo ""

# Test 3: /v1beta/models/gemini-2.5-flash:generateContent
echo "Test 3: /v1beta/models/gemini-2.5-flash:generateContent endpoint"
RESPONSE=$(curl -s "$BASE_URL/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{
    "contents": [{"role": "user", "parts": [{"text": "What is 5+3?"}]}]
  }')

if echo "$RESPONSE" | jq -e '.type == "message" and .content[0].text' > /dev/null 2>&1; then
  echo "✅ PASSED"
  echo "Response: $(echo "$RESPONSE" | jq -r '.content[0].text' | head -1)"
  ((PASSED++))
else
  echo "❌ FAILED"
  echo "$RESPONSE" | jq .
  ((FAILED++))
fi
echo ""

# Summary
echo "========================================="
echo "Test Summary"
echo "========================================="
echo "Model: $MODEL"
echo "Upstream: https://api.yoosheen.com/v1beta/models/gemini-2.5-flash:generateContent"
echo "Mode: native"
echo "Passed: $PASSED"
echo "Failed: $FAILED"
echo ""

if [ $FAILED -eq 0 ]; then
  echo "✅ All tests passed!"
  exit 0
else
  echo "❌ Some tests failed"
  exit 1
fi
