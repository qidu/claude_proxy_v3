#!/bin/bash

# Test two additional models with diverse prefixes

BASE_URL="http://localhost:8788"
TOTAL_PASSED=0
TOTAL_FAILED=0

echo "Testing Additional Models"
echo "========================================="
echo ""

# Function to test a model
test_model() {
  local MODEL=$1
  local PASSED=0
  local FAILED=0
  
  echo "Model: $MODEL"
  echo "---"
  
  # Test 1: /v1/messages
  echo -n "  /v1/messages: "
  RESPONSE=$(curl -s "$BASE_URL/v1/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test" \
    -d "{
      \"model\": \"$MODEL\",
      \"messages\": [{\"role\": \"user\", \"content\": \"What is 2+2?\"}],
      \"max_tokens\": 50
    }")
  
  if echo "$RESPONSE" | jq -e '.type == "message" and .content[0].text' > /dev/null 2>&1; then
    echo "✅ $(echo "$RESPONSE" | jq -r '.content[0].text' | head -c 30)..."
    ((PASSED++))
  else
    echo "❌"
    ((FAILED++))
  fi
  
  # Test 2: /v1/interactions
  echo -n "  /v1/interactions: "
  RESPONSE=$(curl -s "$BASE_URL/v1/interactions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test" \
    -d "{
      \"model\": \"$MODEL\",
      \"input\": \"Capital of France?\"
    }")
  
  if echo "$RESPONSE" | jq -e '.status == "completed" and .outputs[0].text' > /dev/null 2>&1; then
    echo "✅ $(echo "$RESPONSE" | jq -r '.outputs[0].text' | head -c 30)..."
    ((PASSED++))
  else
    echo "❌"
    ((FAILED++))
  fi
  
  # Test 3: Multi-turn
  echo -n "  /v1/messages (multi-turn): "
  RESPONSE=$(curl -s "$BASE_URL/v1/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test" \
    -d "{
      \"model\": \"$MODEL\",
      \"messages\": [
        {\"role\": \"user\", \"content\": \"Hi\"},
        {\"role\": \"assistant\", \"content\": \"Hello!\"},
        {\"role\": \"user\", \"content\": \"5+3?\"}
      ],
      \"max_tokens\": 50
    }")
  
  if echo "$RESPONSE" | jq -e '.type == "message" and .content[0].text' > /dev/null 2>&1; then
    echo "✅ $(echo "$RESPONSE" | jq -r '.content[0].text' | head -c 30)..."
    ((PASSED++))
  else
    echo "❌"
    ((FAILED++))
  fi
  
  echo "  Result: $PASSED/3"
  echo ""
  
  TOTAL_PASSED=$((TOTAL_PASSED + PASSED))
  TOTAL_FAILED=$((TOTAL_FAILED + FAILED))
}

# Test models with diverse prefixes
test_model "gpt-oss-120b"
test_model "claude-4.5-haiku"

# Summary
echo "========================================="
echo "Summary: $TOTAL_PASSED passed, $TOTAL_FAILED failed"
echo ""

if [ $TOTAL_FAILED -eq 0 ]; then
  echo "✅ All tests passed!"
  exit 0
else
  echo "❌ Some tests failed"
  exit 1
fi
