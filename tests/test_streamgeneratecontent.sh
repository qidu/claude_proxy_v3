#!/bin/bash

# Test streamGenerateContent with both native and OpenAI-compatible modes
# Model: gemini-2.5-flash

set -e

MODEL="gemini-2.5-flash"
PROXY_URL="http://localhost:8788"

echo "=========================================="
echo "Testing streamGenerateContent Endpoint"
echo "Model: ${MODEL}"
echo "=========================================="
echo ""

# Test 1: :generateContent with stream: true (baseline)
echo "Test 1: :generateContent with stream: true"
echo "------------------------------------------"
RESPONSE=$(timeout 3 curl -s -N "${PROXY_URL}/v1beta/models/${MODEL}:generateContent" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "role": "user",
        "parts": [{"text": "Say hello in 3 words"}]
      }
    ],
    "stream": true
  }' 2>/dev/null | head -3)

if echo "$RESPONSE" | grep -q "data:"; then
  echo "✅ PASS: Received SSE stream"
  echo "Sample: $(echo "$RESPONSE" | head -1)"
else
  echo "❌ FAIL: No SSE stream received"
  echo "Response: $RESPONSE"
fi
echo ""

# Test 2: :generateContent?alt=sse (query parameter)
echo "Test 2: :generateContent?alt=sse"
echo "------------------------------------------"
RESPONSE=$(timeout 3 curl -s -N "${PROXY_URL}/v1beta/models/${MODEL}:generateContent?alt=sse" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "role": "user",
        "parts": [{"text": "Say hello in 3 words"}]
      }
    ]
  }' 2>/dev/null | head -3)

if echo "$RESPONSE" | grep -q "data:"; then
  echo "✅ PASS: Received SSE stream (without stream parameter)"
  echo "Sample: $(echo "$RESPONSE" | head -1)"
else
  echo "❌ FAIL: No SSE stream received"
  echo "Response: $RESPONSE"
fi
echo ""

# Test 3: :streamGenerateContent (dedicated endpoint)
echo "Test 3: :streamGenerateContent"
echo "------------------------------------------"
RESPONSE=$(timeout 3 curl -s -N "${PROXY_URL}/v1beta/models/${MODEL}:streamGenerateContent" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "role": "user",
        "parts": [{"text": "Say hello in 3 words"}]
      }
    ]
  }' 2>/dev/null | head -3)

if echo "$RESPONSE" | grep -q "data:"; then
  echo "✅ PASS: Received SSE stream"
  echo "Sample: $(echo "$RESPONSE" | head -1)"
else
  echo "❌ FAIL: No SSE stream received"
  echo "Response: $RESPONSE"
fi
echo ""

# Test 4: :streamGenerateContent?alt=sse (both methods)
echo "Test 4: :streamGenerateContent?alt=sse"
echo "------------------------------------------"
RESPONSE=$(timeout 3 curl -s -N "${PROXY_URL}/v1beta/models/${MODEL}:streamGenerateContent?alt=sse" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "role": "user",
        "parts": [{"text": "Say hello in 3 words"}]
      }
    ]
  }' 2>/dev/null | head -3)

if echo "$RESPONSE" | grep -q "data:"; then
  echo "✅ PASS: Received SSE stream"
  echo "Sample: $(echo "$RESPONSE" | head -1)"
else
  echo "❌ FAIL: No SSE stream received"
  echo "Response: $RESPONSE"
fi
echo ""

# Test 5: :streamGenerateContent with stream: false (should force streaming)
echo "Test 5: :streamGenerateContent with stream: false (force streaming)"
echo "------------------------------------------"
RESPONSE=$(timeout 3 curl -s -N "${PROXY_URL}/v1beta/models/${MODEL}:streamGenerateContent" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "role": "user",
        "parts": [{"text": "Say hello in 3 words"}]
      }
    ],
    "stream": false
  }' 2>/dev/null | head -3)

if echo "$RESPONSE" | grep -q "data:"; then
  echo "✅ PASS: Forced streaming despite stream: false"
  echo "Sample: $(echo "$RESPONSE" | head -1)"
else
  echo "❌ FAIL: No SSE stream received"
  echo "Response: $RESPONSE"
fi
echo ""

echo "=========================================="
echo "Test Summary"
echo "=========================================="
echo "All 5 tests completed. Check results above."
echo ""
echo "Expected: All tests should PASS with SSE streams"
