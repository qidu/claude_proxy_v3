#!/bin/bash
# Test wildcard (*) and catch-all routing rules
#
# Routing priority:
#   Priority 1: Exact match  (all categories)
#   Priority 2: prefix-*     (models.claude → models.gemini)
#   Priority 3: * catch-all  (models.default)

BASE_URL="${BASE_URL:-http://localhost:8788}"
PASS=0
FAIL=0

# Helper: send a /v1/messages request and check response
send_request() {
  local model="$1"
  local expected_text="$2"
  curl -s "$BASE_URL/v1/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test" \
    -d "{\"model\": \"$model\", \"messages\": [{\"role\": \"user\", \"content\": \"Reply: $expected_text\"}], \"max_tokens\": 20}"
}

# Helper: assert response contains expected text
assert_contains() {
  local label="$1"
  local model="$2"
  local expected="$3"
  local response
  response=$(send_request "$model" "$expected")
  if echo "$response" | jq -e ".error" > /dev/null 2>&1; then
    echo "❌ $label"
    echo "   Model: $model"
    echo "   Error: $(echo "$response" | jq -r '.error.type'): $(echo "$response" | jq -r '.error.message')"
    ((FAIL++))
  elif echo "$response" | jq -e ".content[0].text" > /dev/null 2>&1; then
    echo "✅ $label"
    echo "   Model: $model  →  $(echo "$response" | jq -r '.model')"
    ((PASS++))
  else
    echo "❌ $label"
    echo "   Model: $model"
    echo "   Unexpected response:"
    echo "$response" | jq .
    ((FAIL++))
  fi
}

echo "============================================"
echo "  Test: Wildcard (*) and Catch-All Routing"
echo "============================================"
echo ""

# ──────────────────────────────────────────────
# Priority 1: Exact match (covered in existing test_model_routing.sh)
# Re-confirm a few exact matches still work.
# ──────────────────────────────────────────────
echo "--- Priority 1: Exact key match ---"

# Exact match in models.free: "claude-sonnet-4-6" is a literal key in [models.free].
assert_contains \
  "Exact: claude-sonnet-4-6 in models.free" \
  "claude-sonnet-4-6" "hello"

# Exact match in models.default: "deepseek-v4-flash" is a literal key in [models.default].
assert_contains \
  "Exact: deepseek-v4-flash in models.default" \
  "deepseek-v4-flash" "hello"

echo ""

# ──────────────────────────────────────────────
# Priority 2: prefix-* wildcard in models.claude / models.gemini
# ──────────────────────────────────────────────
echo "--- Priority 2: prefix-* wildcard matching ---"

# claude-haiku-4-5-20251001 has NO exact match in any category.
# Priority 2: "claude-*" in models.claude matches "claude-haiku-4-5-20251001".
assert_contains \
  "Wildcard: claude-haiku-4-5-20251001 matches claude-* in models.claude" \
  "claude-haiku-4-5-20251001" "hello"

# claude-opus-4-8 has NO exact match (models.free only has alias "opus48", not "claude-opus-4-8").
# Priority 2: "claude-*" in models.claude matches "claude-opus-4-8".
assert_contains \
  "Wildcard: claude-opus-4-8 matches claude-* in models.claude" \
  "claude-opus-4-8" "hello"

# gemini-2.0-flash has NO exact match in models.gemini.
# Priority 2: "gemini-*" in models.gemini matches "gemini-2.0-flash".
assert_contains \
  "Wildcard: gemini-2.0-flash matches gemini-* in models.gemini" \
  "gemini-2.0-flash" "hello"

echo ""

# ──────────────────────────────────────────────
# Priority 3: * catch-all in models.default
# ──────────────────────────────────────────────
echo "--- Priority 3: * catch-all in models.default ---"

# A model that has NO exact match and NO wildcard match
# should fall through to models.default's catch-all.
# upstream_mode = openai-completions, base_url = api.minimaxi.com
# model name should be passed through unchanged (not "*")
assert_contains \
  "Catch-all: totally-unknown-model routes via * in models.default" \
  "totally-unknown-model-xyz123" "hello"

# Any non-claude/gemini model not in config falls here
assert_contains \
  "Catch-all: openai/gpt-4 routes via * in models.default" \
  "openai/gpt-4" "hello"

echo ""
echo "============================================"
echo "  Results: $PASS passed, $FAIL failed"
echo "============================================"

if [ $FAIL -gt 0 ]; then
  exit 1
fi
exit 0
