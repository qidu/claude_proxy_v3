#!/bin/bash

# Test gemini-2.5-flash with streamGenerateContent
# Tests both native and OpenAI-compatible modes

set -e

MODEL="gemini-2.5-flash"
PROXY_URL="http://localhost:8788"

echo "=========================================="
echo "Testing gemini-2.5-flash"
echo "streamGenerateContent Implementation"
echo "=========================================="
echo ""

# Function to test an endpoint
test_endpoint() {
  local test_name="$1"
  local endpoint="$2"
  local body="$3"
  
  echo "${test_name}"
  echo "------------------------------------------"
  
  RESPONSE=$(timeout 3 curl -s -N "${PROXY_URL}${endpoint}" \
    -H "Content-Type: application/json" \
    -d "${body}" 2>/dev/null | head -3)
  
  if echo "$RESPONSE" | grep -q "data:"; then
    echo "✅ PASS: Received SSE stream"
    echo "Sample: $(echo "$RESPONSE" | head -1 | cut -c1-80)"
  else
    echo "❌ FAIL: No SSE stream"
    echo "Response: $(echo "$RESPONSE" | head -1 | cut -c1-80)"
  fi
  echo ""
}

# Test bodies
BODY_SIMPLE='{
  "contents": [{"role": "user", "parts": [{"text": "Say hello"}]}]
}'

BODY_STREAM_TRUE='{
  "contents": [{"role": "user", "parts": [{"text": "Say hello"}]}],
  "stream": true
}'

BODY_STREAM_FALSE='{
  "contents": [{"role": "user", "parts": [{"text": "Say hello"}]}],
  "stream": false
}'

echo "=========================================="
echo "PART 1: Standard :generateContent"
echo "=========================================="
echo ""

test_endpoint "Test 1: :generateContent (no stream param)" \
  "/v1beta/models/${MODEL}:generateContent" \
  "$BODY_SIMPLE"

test_endpoint "Test 2: :generateContent (stream: true)" \
  "/v1beta/models/${MODEL}:generateContent" \
  "$BODY_STREAM_TRUE"

test_endpoint "Test 3: :generateContent (stream: false)" \
  "/v1beta/models/${MODEL}:generateContent" \
  "$BODY_STREAM_FALSE"

echo "=========================================="
echo "PART 2: :generateContent?alt=sse"
echo "=========================================="
echo ""

test_endpoint "Test 4: :generateContent?alt=sse (no stream param)" \
  "/v1beta/models/${MODEL}:generateContent?alt=sse" \
  "$BODY_SIMPLE"

test_endpoint "Test 5: :generateContent?alt=sse (stream: false)" \
  "/v1beta/models/${MODEL}:generateContent?alt=sse" \
  "$BODY_STREAM_FALSE"

echo "=========================================="
echo "PART 3: :streamGenerateContent"
echo "=========================================="
echo ""

test_endpoint "Test 6: :streamGenerateContent (no stream param)" \
  "/v1beta/models/${MODEL}:streamGenerateContent" \
  "$BODY_SIMPLE"

test_endpoint "Test 7: :streamGenerateContent (stream: false)" \
  "/v1beta/models/${MODEL}:streamGenerateContent" \
  "$BODY_STREAM_FALSE"

test_endpoint "Test 8: :streamGenerateContent?alt=sse" \
  "/v1beta/models/${MODEL}:streamGenerateContent?alt=sse" \
  "$BODY_SIMPLE"

echo "=========================================="
echo "Test Summary"
echo "=========================================="
echo ""
echo "Expected Results:"
echo "  Native Mode:"
echo "    Test 1: ❌ FAIL (no streaming without stream param)"
echo "    Test 2: ✅ PASS (stream: true)"
echo "    Test 3: ❌ FAIL (stream: false)"
echo "    Test 4-8: ✅ PASS (all force streaming)"
echo ""
echo "  OpenAI-Compatible Mode:"
echo "    Test 1: ❌ FAIL (no streaming without stream param)"
echo "    Test 2: ✅ PASS (stream: true)"
echo "    Test 3: ❌ FAIL (stream: false)"
echo "    Test 4-8: ✅ PASS (all force streaming)"
echo ""
echo "Note: Configure mode via GENERATE_CONTENT_UPSTREAM_MODE"
echo "      in wrangler.toml or proxy_config.toml"
