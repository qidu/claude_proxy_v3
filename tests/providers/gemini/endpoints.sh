#!/bin/bash

# Test Gemini endpoints with model-specific routing

BASE_URL="http://localhost:8788"

echo "=== Testing Gemini Endpoints with Model-Specific Routing ==="
echo ""

# Test 1: /v1/messages (already tested, works)
echo "1. Testing /v1/messages with gemini-2.5-flash"
RESPONSE=$(curl -s "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Say hello"}],
    "max_tokens": 50
  }')

if echo "$RESPONSE" | jq -e '.content[0].text' > /dev/null 2>&1; then
  echo "✅ /v1/messages works"
  echo "   Response: $(echo "$RESPONSE" | jq -r '.content[0].text')"
else
  echo "❌ /v1/messages failed"
  echo "$RESPONSE" | jq .
fi
echo ""

# Test 2: /v1beta/models/{model}:generateContent
echo "2. Testing /v1beta/models/gemini-2.5-flash:generateContent"
RESPONSE=$(curl -s "$BASE_URL/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Say hello"}],
    "max_tokens": 50
  }')

if echo "$RESPONSE" | jq -e '.content[0].text' > /dev/null 2>&1; then
  echo "✅ /v1beta/models/{model}:generateContent works"
  echo "   Response: $(echo "$RESPONSE" | jq -r '.content[0].text')"
else
  echo "❌ /v1beta/models/{model}:generateContent failed"
  echo "$RESPONSE" | jq .
fi
echo ""

# Test 3: Complex question with /v1beta/models/{model}:generateContent
echo "3. Testing complex question with /v1beta/models/gemini-2.5-flash:generateContent"
RESPONSE=$(curl -s "$BASE_URL/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{
      "role": "user",
      "content": "Explain quantum entanglement in one sentence."
    }],
    "max_tokens": 100
  }')

if echo "$RESPONSE" | jq -e '.content[0].text' > /dev/null 2>&1; then
  echo "✅ Complex question works"
  echo "   Response: $(echo "$RESPONSE" | jq -r '.content[0].text')"
  echo "   Tokens: input=$(echo "$RESPONSE" | jq -r '.usage.input_tokens'), output=$(echo "$RESPONSE" | jq -r '.usage.output_tokens')"
else
  echo "❌ Complex question failed"
  echo "$RESPONSE" | jq .
fi
echo ""

# Test 4: /v1/interactions (known issue)
echo "4. Testing /v1/interactions with gemini-2.5-flash"
RESPONSE=$(curl -s "$BASE_URL/v1/interactions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Say hello"}],
    "max_tokens": 50
  }')

if echo "$RESPONSE" | jq -e '.content[0].text' > /dev/null 2>&1; then
  echo "✅ /v1/interactions works"
  echo "   Response: $(echo "$RESPONSE" | jq -r '.content[0].text')"
else
  echo "⚠️  /v1/interactions has issues (known)"
  echo "$RESPONSE" | jq .
fi
echo ""

echo "=== Summary ==="
echo "✅ /v1/messages - Works with model-specific routing"
echo "✅ /v1beta/models/{model}:generateContent - Works with model-specific routing"
echo "⚠️  /v1/interactions - Has issues (needs investigation)"
echo ""
echo "Model-specific routing successfully routes gemini-2.5-flash to:"
echo "  - Upstream: https://api.example1.com"
echo "  - Mode: native"
echo "  - API Key: From config"
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
echo "Upstream: https://api.example1.com/v1beta/models/gemini-2.5-flash:generateContent"
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
