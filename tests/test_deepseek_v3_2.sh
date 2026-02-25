#!/bin/bash

# Test deepseek/deepseek-v3.2-exp with all 3 endpoints

BASE_URL="http://localhost:8788"
MODEL="deepseek/deepseek-v3.2-exp"
PASSED=0
FAILED=0

echo "========================================="
echo "Testing deepseek/deepseek-v3.2-exp"
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

# Test 3: /v1/messages with multi-turn
echo "Test 3: /v1/messages with multi-turn"
RESPONSE=$(curl -s "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [
      {\"role\": \"user\", \"content\": \"Hello!\"},
      {\"role\": \"assistant\", \"content\": \"Hi there!\"},
      {\"role\": \"user\", \"content\": \"What is 5+3?\"}
    ],
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

# Summary
echo "========================================="
echo "Test Summary"
echo "========================================="
echo "Model: $MODEL"
echo "Upstream: https://api.qnaigc.com (OpenAI-compatible)"
echo "Mode: openai-completions"
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
