#!/bin/bash

# Test cached_content parameter support
# This test demonstrates how to use context caching with the proxy

set -e

BASE_URL="${BASE_URL:-http://localhost:8788}"
MODEL="${MODEL:-gemini-2.5-flash}"

echo "=== Testing cached_content Parameter Support ==="
echo ""

# Test 1: /v1/messages with cached_content
echo "Test 1: Claude Messages API with cached_content"
curl -s "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-key" \
  -d "{
    \"model\": \"$MODEL\",
    \"max_tokens\": 100,
    \"messages\": [{
      \"role\": \"user\",
      \"content\": \"What was in the cached content?\"
    }],
    \"cached_content\": \"cachedContents/example-cache-id\"
  }" | jq -r '.content[0].text // .error.message // "No response"'
echo ""

# Test 2: /v1/interactions with cached_content
echo "Test 2: Interactions API with cached_content"
curl -s "$BASE_URL/v1/interactions" \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: test-key" \
  -d "{
    \"model\": \"$MODEL\",
    \"input\": \"Summarize the cached document\",
    \"cached_content\": \"cachedContents/example-cache-id\"
  }" | jq -r '.outputs[0].text // .error.message // "No response"'
echo ""

# Test 3: /v1beta/models/{model}:generateContent with cachedContent
echo "Test 3: Native Gemini generateContent with cachedContent"
curl -s "$BASE_URL/v1beta/models/$MODEL:generateContent" \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: test-key" \
  -d "{
    \"contents\": [{
      \"role\": \"user\",
      \"parts\": [{\"text\": \"What's in the cache?\"}]
    }],
    \"cachedContent\": \"cachedContents/example-cache-id\"
  }" | jq -r '.candidates[0].content.parts[0].text // .error.message // "No response"'
echo ""

echo "=== All cached_content tests completed ==="
