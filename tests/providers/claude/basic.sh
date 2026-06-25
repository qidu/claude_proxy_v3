#!/bin/bash

cd /home/teric/win/e/dev/bot/model_proxy_v3

BASE="http://localhost:8788"
PASS=0
FAIL=0

test_endpoint() {
  local name=$1
  local url=$2
  local data=$3
  
  RESP=$(curl -s "$url" -H "Content-Type: application/json" -d "$data")
  
  if echo "$RESP" | jq -e '.id' > /dev/null 2>&1 && ! echo "$RESP" | jq -e '.error' > /dev/null 2>&1; then
    ID=$(echo "$RESP" | jq -r '.id')
    echo "✅ $name: $ID"
    ((PASS++))
  else
    ERROR=$(echo "$RESP" | jq -r '.error.message // .message // "Unknown error"' 2>/dev/null || echo "Connection failed")
    echo "❌ $name: $ERROR"
    ((FAIL++))
  fi
}

test_mode() {
  local model=$1
  local mode=$2
  local config=$3
  
  echo "=========================================="
  echo "Testing: $model - $mode Mode"
  echo "=========================================="
  
  # Kill any existing server
  pkill -f "node dist/server.js" 2>/dev/null
  sleep 1
  
  cat > proxy_config.toml << EOF
$config
EOF
  
  PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_claude_test.log 2>&1 &
  SERVER_PID=$!
  sleep 4
  
  test_endpoint "  /v1/messages" \
    "$BASE/v1/messages" \
    "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"2+2?\"}],\"max_tokens\":50}"
  
  if [ "$mode" = "openai-completions" ]; then
    test_endpoint "  /v1/interactions" \
      "$BASE/v1/interactions" \
      "{\"model\":\"$model\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"3+3?\"}]}}"
    
    test_endpoint "  generateContent" \
      "$BASE/v1beta/models/$model:generateContent" \
      '{"contents":[{"role":"user","parts":[{"text":"4+4?"}]}]}'
  fi
  
  kill $SERVER_PID 2>/dev/null
  sleep 2
  echo
}

# Test Claude models with native mode
NATIVE_CONFIG='[upstream]
default_base_url = "https://api.qnaigc.com"
default_api_key = "sk-28f417e15b4643913bce23520d5948327c======"

[models.claude]
upstream_mode = "anthropic-messages"
base_url = "https://api.wenwen-ai.com"
api_key = "sk-cJESnlELbBSsytvgIgCevJWqBYr======"
"claude-4.6-sonnet" = ["claude-opus-4-1-20250805-thinking", "", ""]
"claude-4.5-opus" = ["claude-opus-4-20250514-thinking", "", ""]
"claude-4.1-sonnet" = ["claude-haiku-4-5-20251001-thinking", "", ""]

[models.default]
upstream_mode = "openai-completions"'

# Test Claude models with OpenAI-compatible mode
OPENAI_CONFIG='[upstream]
default_base_url = "https://api.qnaigc.com"
default_api_key = "sk-28f417e15b4643913bce23520d5948327c======"

[models.default]
upstream_mode = "openai-completions"'

echo "Claude Models Test Suite"
echo "========================="
echo

# Native mode tests
test_mode "claude-4.6-sonnet" "anthropic-messages" "$NATIVE_CONFIG"
test_mode "claude-4.5-opus" "anthropic-messages" "$NATIVE_CONFIG"
test_mode "claude-4.1-sonnet" "anthropic-messages" "$NATIVE_CONFIG"

# OpenAI-compatible mode tests
test_mode "claude-4.6-sonnet" "openai-completions" "$OPENAI_CONFIG"
test_mode "claude-4.5-opus" "openai-completions" "$OPENAI_CONFIG"
test_mode "claude-haiku-4-5" "openai-completions" "$OPENAI_CONFIG"

echo "=========================================="
echo "Results: $PASS passed, $FAIL failed"
echo "Success rate: $(awk "BEGIN {printf \"%.1f\", ($PASS/($PASS+$FAIL))*100}")%"
