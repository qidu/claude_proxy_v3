#!/bin/bash

# Comprehensive test for all models from docs/test_keys.md

BASE_URL="http://localhost:8788"
TOTAL_PASSED=0
TOTAL_FAILED=0

echo "╔══════════════════════════════════════════════════════════════════════════════╗"
echo "║              COMPREHENSIVE MODEL TESTING FROM test_keys.md                  ║"
echo "╚══════════════════════════════════════════════════════════════════════════════╝"
echo ""

# Function to test a model with all 3 endpoints
test_model() {
  local MODEL=$1
  local MODE=$2
  local UPSTREAM=$3
  local PASSED=0
  local FAILED=0
  
  echo "========================================="
  echo "Testing: $MODEL"
  echo "Mode: $MODE"
  echo "Upstream: $UPSTREAM"
  echo "========================================="
  echo ""
  
  # Test 1: /v1/messages
  echo "  Test 1: /v1/messages"
  RESPONSE=$(curl -s "$BASE_URL/v1/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test" \
    -d "{
      \"model\": \"$MODEL\",
      \"messages\": [{\"role\": \"user\", \"content\": \"What is 2+2?\"}],
      \"max_tokens\": 50
    }")
  
  if echo "$RESPONSE" | jq -e '.type == "message" and .content[0].text' > /dev/null 2>&1; then
    echo "  ✅ PASSED - $(echo "$RESPONSE" | jq -r '.content[0].text' | head -c 50)..."
    ((PASSED++))
  else
    echo "  ❌ FAILED"
    ((FAILED++))
  fi
  
  # Test 2: /v1/interactions
  echo "  Test 2: /v1/interactions"
  RESPONSE=$(curl -s "$BASE_URL/v1/interactions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test" \
    -d "{
      \"model\": \"$MODEL\",
      \"input\": \"What is the capital of France?\"
    }")
  
  if echo "$RESPONSE" | jq -e '.status == "completed" and .outputs[0].text' > /dev/null 2>&1; then
    echo "  ✅ PASSED - $(echo "$RESPONSE" | jq -r '.outputs[0].text' | head -c 50)..."
    ((PASSED++))
  else
    echo "  ❌ FAILED"
    ((FAILED++))
  fi
  
  # Test 3: Endpoint-specific test
  if [ "$MODE" = "native" ]; then
    # For Gemini, test native generateContent endpoint
    echo "  Test 3: /v1beta/models/$MODEL:generateContent"
    RESPONSE=$(curl -s "$BASE_URL/v1beta/models/$MODEL:generateContent" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer test" \
      -d '{
        "contents": [{"role": "user", "parts": [{"text": "What is 5+3?"}]}]
      }')
  else
    # For OpenAI-compatible, test multi-turn
    echo "  Test 3: /v1/messages (multi-turn)"
    RESPONSE=$(curl -s "$BASE_URL/v1/messages" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer test" \
      -d "{
        \"model\": \"$MODEL\",
        \"messages\": [
          {\"role\": \"user\", \"content\": \"Hello!\"},
          {\"role\": \"assistant\", \"content\": \"Hi!\"},
          {\"role\": \"user\", \"content\": \"What is 5+3?\"}
        ],
        \"max_tokens\": 50
      }")
  fi
  
  if echo "$RESPONSE" | jq -e '.type == "message" and .content[0].text' > /dev/null 2>&1; then
    echo "  ✅ PASSED - $(echo "$RESPONSE" | jq -r '.content[0].text' | head -c 50)..."
    ((PASSED++))
  else
    echo "  ❌ FAILED"
    ((FAILED++))
  fi
  
  echo ""
  echo "  Result: $PASSED/3 passed"
  echo ""
  
  TOTAL_PASSED=$((TOTAL_PASSED + PASSED))
  TOTAL_FAILED=$((TOTAL_FAILED + FAILED))
}

# Test 1: gemini-2.5-flash (native)
test_model "gemini-2.5-flash" "native" "https://api.example1.com"

# Test 2: minimax/minimax-m2.1 (OpenAI-compatible)
test_model "minimax/minimax-m2.1" "openai-completions" "https://api.qnaigc.com"

# Test 3: deepseek/deepseek-v3.2-exp (OpenAI-compatible)
test_model "deepseek/deepseek-v3.2-exp" "openai-completions" "https://api.qnaigc.com"

# Test 4: z-ai/glm-5 (OpenAI-compatible)
test_model "z-ai/glm-5" "openai-completions" "https://api.qnaigc.com"

# Summary
echo "╔══════════════════════════════════════════════════════════════════════════════╗"
echo "║                           FINAL SUMMARY                                      ║"
echo "╚══════════════════════════════════════════════════════════════════════════════╝"
echo ""
echo "Total Models Tested: 4"
echo "Total Tests: 12 (3 endpoints × 4 models)"
echo "Passed: $TOTAL_PASSED"
echo "Failed: $TOTAL_FAILED"
echo ""

if [ $TOTAL_FAILED -eq 0 ]; then
  echo "✅ ALL TESTS PASSED!"
  exit 0
else
  echo "❌ Some tests failed"
  exit 1
fi
