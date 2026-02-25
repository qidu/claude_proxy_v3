#!/bin/bash

# Test all models with "-think*" postfix on all 3 endpoints
# Uses OpenAI-compatible upstream from test_keys.md

BASE_URL="http://localhost:8788"

# Models with "-think*" postfix
MODELS=(
  "deepseek/deepseek-v3.2-exp-thinking"
  "qwen3-vl-30b-a3b-thinking"
  "qwen3-30b-a3b-thinking-2507"
  "qwen3-next-80b-a3b-thinking"
  "qwen3-235b-a22b-thinking-2507"
  "doubao-seed-1.6-thinking"
  "doubao-1.5-thinking-pro"
  "deepseek/deepseek-v3.1-terminus-thinking"
  "moonshotai/kimi-k2-thinking"
)

echo "=========================================="
echo "Testing ${#MODELS[@]} thinking models on all 3 endpoints"
echo "=========================================="

TOTAL_TESTS=0
PASSED_TESTS=0

for MODEL in "${MODELS[@]}"; do
  echo ""
  echo "=========================================="
  echo "Testing: $MODEL"
  echo "=========================================="
  
  # Test 1: /v1/messages
  echo "Test 1: /v1/messages"
  RESPONSE=$(curl -s "$BASE_URL/v1/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test" \
    -d "{
      \"model\": \"$MODEL\",
      \"messages\": [{\"role\": \"user\", \"content\": \"What is 2+2?\"}],
      \"max_tokens\": 100
    }")
  
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
  if echo "$RESPONSE" | jq -e '.content[0].text' > /dev/null 2>&1; then
    echo "✅ /v1/messages: $(echo "$RESPONSE" | jq -r '.content[0].text' | head -c 60)..."
    PASSED_TESTS=$((PASSED_TESTS + 1))
  else
    echo "❌ /v1/messages failed"
  fi
  
  # Test 2: /v1/interactions
  echo "Test 2: /v1/interactions"
  RESPONSE=$(curl -s "$BASE_URL/v1/interactions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test" \
    -d "{
      \"model\": \"$MODEL\",
      \"input\": \"What is 3+3?\"
    }")
  
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
  if echo "$RESPONSE" | jq -e '.outputs[0].text' > /dev/null 2>&1; then
    echo "✅ /v1/interactions: $(echo "$RESPONSE" | jq -r '.outputs[0].text' | head -c 60)..."
    PASSED_TESTS=$((PASSED_TESTS + 1))
  else
    echo "❌ /v1/interactions failed"
  fi
  
  # Test 3: Native endpoint
  echo "Test 3: /v1beta/models/$MODEL:generateContent"
  RESPONSE=$(curl -s "$BASE_URL/v1beta/models/$MODEL:generateContent" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test" \
    -d "{
      \"contents\": [{\"role\": \"user\", \"parts\": [{\"text\": \"What is 4+4?\"}]}]
    }")
  
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
  if echo "$RESPONSE" | jq -e '.content[0].text' > /dev/null 2>&1; then
    echo "✅ Native endpoint: $(echo "$RESPONSE" | jq -r '.content[0].text' | head -c 60)..."
    PASSED_TESTS=$((PASSED_TESTS + 1))
  else
    echo "❌ Native endpoint failed"
  fi
done

echo ""
echo "=========================================="
echo "Testing complete"
echo "Results: $PASSED_TESTS/$TOTAL_TESTS tests passed"
echo "Success rate: $(awk "BEGIN {printf \"%.1f\", ($PASSED_TESTS/$TOTAL_TESTS)*100}")%"
echo "=========================================="
