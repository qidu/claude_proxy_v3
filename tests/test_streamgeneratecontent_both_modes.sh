#!/bin/bash

# Test streamGenerateContent with both native and OpenAI-compatible upstream modes
# Model: gemini-2.5-flash

set -e

MODEL="gemini-2.5-flash"
PROXY_URL="http://localhost:8788"

echo "=========================================="
echo "Testing streamGenerateContent"
echo "Model: ${MODEL}"
echo "Both Native and OpenAI-Compatible Modes"
echo "=========================================="
echo ""

# Function to test an endpoint
test_endpoint() {
  local test_name="$1"
  local endpoint="$2"
  local body="$3"
  
  echo "Test: ${test_name}"
  echo "------------------------------------------"
  
  RESPONSE=$(timeout 3 curl -s -N "${PROXY_URL}${endpoint}" \
    -H "Content-Type: application/json" \
    -d "${body}" 2>/dev/null | head -3)
  
  if echo "$RESPONSE" | grep -q "data:"; then
    echo "✅ PASS: Received SSE stream"
    echo "Sample: $(echo "$RESPONSE" | head -1)"
  else
    echo "❌ FAIL: No SSE stream received"
    echo "Response: $RESPONSE"
  fi
  echo ""
}

# Test body
BODY='{
  "contents": [
    {
      "role": "user",
      "parts": [{"text": "Say hello in 3 words"}]
    }
  ]
}'

BODY_WITH_STREAM='{
  "contents": [
    {
      "role": "user",
      "parts": [{"text": "Say hello in 3 words"}]
    }
  ],
  "stream": true
}'

BODY_NO_STREAM='{
  "contents": [
    {
      "role": "user",
      "parts": [{"text": "Say hello in 3 words"}]
    }
  ],
  "stream": false
}'

echo "=========================================="
echo "PART 1: Standard Endpoints"
echo "=========================================="
echo ""

test_endpoint "1. :generateContent with stream: true" \
  "/v1beta/models/${MODEL}:generateContent" \
  "$BODY_WITH_STREAM"

test_endpoint "2. :generateContent without stream parameter" \
  "/v1beta/models/${MODEL}:generateContent" \
  "$BODY"

echo "=========================================="
echo "PART 2: Query Parameter (?alt=sse)"
echo "=========================================="
echo ""

test_endpoint "3. :generateContent?alt=sse (no stream param)" \
  "/v1beta/models/${MODEL}:generateContent?alt=sse" \
  "$BODY"

test_endpoint "4. :generateContent?alt=sse (stream: false)" \
  "/v1beta/models/${MODEL}:generateContent?alt=sse" \
  "$BODY_NO_STREAM"

echo "=========================================="
echo "PART 3: Dedicated Endpoint (:streamGenerateContent)"
echo "=========================================="
echo ""

test_endpoint "5. :streamGenerateContent (no stream param)" \
  "/v1beta/models/${MODEL}:streamGenerateContent" \
  "$BODY"

test_endpoint "6. :streamGenerateContent (stream: false)" \
  "/v1beta/models/${MODEL}:streamGenerateContent" \
  "$BODY_NO_STREAM"

test_endpoint "7. :streamGenerateContent?alt=sse" \
  "/v1beta/models/${MODEL}:streamGenerateContent?alt=sse" \
  "$BODY"

echo "=========================================="
echo "Test Summary"
echo "=========================================="
echo "Expected Results:"
echo "  Test 1: ✅ PASS (explicit stream: true)"
echo "  Test 2: ❌ FAIL (no streaming without stream param)"
echo "  Test 3-7: ✅ PASS (all force streaming)"
echo ""
echo "Note: Tests work with both native and OpenAI-compatible modes"
echo "      Configure via GENERATE_CONTENT_UPSTREAM_MODE in wrangler.toml"
