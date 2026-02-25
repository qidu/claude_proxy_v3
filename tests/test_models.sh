#!/bin/bash

# Test script for Claude Proxy v3
# Tests multiple models via /v1/messages endpoint

API_KEY="sk-87abde0542f469130******"
BASE_URL="http://localhost:8788"

echo "=== Claude Proxy v3 Test Suite ==="
echo ""

# Test 1: deepseek-v3.2-exp
echo "Test 1: deepseek-v3.2-exp"
curl -s "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "deepseek/deepseek-v3.2-exp",
    "messages": [{"role": "user", "content": "What is 5+3?"}],
    "max_tokens": 50
  }' | jq -r '.content[0].text // .error.message'
echo ""

# Test 2: minimax-m2.5
echo "Test 2: minimax-m2.5"
curl -s "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "minimax/minimax-m2.5",
    "messages": [{"role": "user", "content": "What is 5+3?"}],
    "max_tokens": 50
  }' | jq -r '.content[0].text // .error.message'
echo ""

# Test 3: deepseek-r1-0528
echo "Test 3: deepseek-r1-0528"
curl -s "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "deepseek-r1-0528",
    "messages": [{"role": "user", "content": "What is 5+3?"}],
    "max_tokens": 50
  }' | jq -r '.content[0].text // .error.message'
echo ""

echo "=== Test Complete ==="
