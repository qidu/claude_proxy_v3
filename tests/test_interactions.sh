#!/bin/bash

# Test /v1/interactions endpoint with Gemini

BASE_URL="http://localhost:8788"
PASSED=0
FAILED=0

echo "========================================="
echo "Testing /v1/interactions Endpoint"
echo "========================================="
echo ""

# Test 1: Simple string input
echo "Test 1: Simple string input"
RESPONSE=$(curl -s "$BASE_URL/v1/interactions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{
    "model": "gemini-2.5-flash",
    "input": "What is 2+2?"
  }')

if echo "$RESPONSE" | jq -e '.status == "completed" and .outputs[0].text' > /dev/null 2>&1; then
  echo "✅ PASSED"
  echo "Response: $(echo "$RESPONSE" | jq -r '.outputs[0].text')"
  ((PASSED++))
else
  echo "❌ FAILED"
  echo "$RESPONSE" | jq .
  ((FAILED++))
fi
echo ""

# Test 2: Multi-turn conversation
echo "Test 2: Multi-turn conversation"
RESPONSE=$(curl -s "$BASE_URL/v1/interactions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{
    "model": "gemini-2.5-flash",
    "input": [
      {"role": "user", "content": "Hello!"},
      {"role": "model", "content": "Hi! How can I help?"},
      {"role": "user", "content": "What is the capital of Japan?"}
    ]
  }')

if echo "$RESPONSE" | jq -e '.status == "completed" and .outputs[0].text' > /dev/null 2>&1; then
  echo "✅ PASSED"
  echo "Response: $(echo "$RESPONSE" | jq -r '.outputs[0].text')"
  ((PASSED++))
else
  echo "❌ FAILED"
  echo "$RESPONSE" | jq .
  ((FAILED++))
fi
echo ""

# Test 3: Complex question
echo "Test 3: Complex question"
RESPONSE=$(curl -s "$BASE_URL/v1/interactions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{
    "model": "gemini-2.5-flash",
    "input": "Write a haiku about programming"
  }')

if echo "$RESPONSE" | jq -e '.status == "completed" and .outputs[0].text' > /dev/null 2>&1; then
  echo "✅ PASSED"
  echo "Response: $(echo "$RESPONSE" | jq -r '.outputs[0].text')"
  ((PASSED++))
else
  echo "❌ FAILED"
  echo "$RESPONSE" | jq .
  ((FAILED++))
fi
echo ""

# Test 4: Verify response format
echo "Test 4: Verify Interactions API response format"
RESPONSE=$(curl -s "$BASE_URL/v1/interactions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{
    "model": "gemini-2.5-flash",
    "input": "Hi"
  }')

HAS_ID=$(echo "$RESPONSE" | jq -e '.id' > /dev/null 2>&1 && echo "yes" || echo "no")
HAS_MODEL=$(echo "$RESPONSE" | jq -e '.model' > /dev/null 2>&1 && echo "yes" || echo "no")
HAS_STATUS=$(echo "$RESPONSE" | jq -e '.status' > /dev/null 2>&1 && echo "yes" || echo "no")
HAS_OBJECT=$(echo "$RESPONSE" | jq -e '.object == "interaction"' > /dev/null 2>&1 && echo "yes" || echo "no")
HAS_OUTPUTS=$(echo "$RESPONSE" | jq -e '.outputs | length > 0' > /dev/null 2>&1 && echo "yes" || echo "no")
HAS_USAGE=$(echo "$RESPONSE" | jq -e '.usage.total_tokens' > /dev/null 2>&1 && echo "yes" || echo "no")

if [ "$HAS_ID" = "yes" ] && [ "$HAS_MODEL" = "yes" ] && [ "$HAS_STATUS" = "yes" ] && \
   [ "$HAS_OBJECT" = "yes" ] && [ "$HAS_OUTPUTS" = "yes" ] && [ "$HAS_USAGE" = "yes" ]; then
  echo "✅ PASSED"
  echo "All required fields present: id, model, status, object, outputs, usage"
  ((PASSED++))
else
  echo "❌ FAILED"
  echo "Missing fields - id:$HAS_ID model:$HAS_MODEL status:$HAS_STATUS object:$HAS_OBJECT outputs:$HAS_OUTPUTS usage:$HAS_USAGE"
  echo "$RESPONSE" | jq .
  ((FAILED++))
fi
echo ""

# Summary
echo "========================================="
echo "Test Summary"
echo "========================================="
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
