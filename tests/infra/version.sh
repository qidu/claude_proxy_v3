#!/bin/bash

echo "Testing version field in health and root endpoints"
echo "=================================================="
echo

BASE_URL="http://localhost:8788"

echo "1. Testing /health endpoint:"
curl -s "$BASE_URL/health" | jq .
echo

echo "2. Testing / (root) endpoint:"
curl -s "$BASE_URL/" | jq .
echo

echo "=================================================="
echo "✅ Version field should appear in both responses"
