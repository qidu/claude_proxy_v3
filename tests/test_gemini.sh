#!/bin/bash

cd /home/teric/win/e/dev/bot/model_proxy_v3

BASE="http://localhost:8788"
PASS=0
FAIL=0

test_endpoint() {
  local name=$1
  local url=$2
  local data=$3
  
  RESP=$(timeout 10 curl -s "$url" -H "Content-Type: application/json" -d "$data")
  
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
  
  PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_gemini_test.log 2>&1 &
  SERVER_PID=$!
  sleep 4
  
  test_endpoint "  /v1/messages" \
    "$BASE/v1/messages" \
    "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"max_tokens\":50}"
  
  if [ "$mode" = "gemini-generatecontent" ]; then
    test_endpoint "  /v1/interactions" \
      "$BASE/v1/interactions" \
      "{\"model\":\"$model\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}]}}"
    
    test_endpoint "  generateContent" \
      "$BASE/v1beta/models/$model:generateContent" \
      '{"contents":[{"role":"user","parts":[{"text":"Hi"}]}]}'
  else
    test_endpoint "  /v1/interactions" \
      "$BASE/v1/interactions" \
      "{\"model\":\"$model\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}]}}"
    
    test_endpoint "  generateContent" \
      "$BASE/v1beta/models/$model:generateContent" \
      '{"contents":[{"role":"user","parts":[{"text":"Hi"}]}]}'
  fi
  
  kill $SERVER_PID 2>/dev/null
  sleep 2
  echo
}

# Native mode config (gemini-generatecontent)
NATIVE_CONFIG='[upstream]
default_base_url = "https://api.qnaigc.com"
default_api_key = "sk-28f417e15b4643913bce23520d5948327c======"

[models.gemini]
upstream_mode = "gemini-generatecontent"
base_url = "https://api.yoosheen.com"
api_key = "sk-qeFSCTmVW61oSbOTFdrxi======"
"gemini-3.1-pro-preview" = ["", "", ""]
"gemini-3.0-flash-preview" = ["gemini-3-flash-preview", "", ""]
"gemini-2.5-flash" = ["", "", ""]

[models.default]
upstream_mode = "openai-completions"'

# OpenAI-compatible mode config
OPENAI_CONFIG='[upstream]
default_base_url = "https://api.qnaigc.com"
default_api_key = "sk-28f417e15b4643913bce23520d5948327c======"

[models.default]
upstream_mode = "openai-completions"'

echo "Gemini Models Test Suite"
echo "========================="
echo

# Native mode tests
test_mode "gemini-3.1-pro-preview" "gemini-generatecontent" "$NATIVE_CONFIG"
test_mode "gemini-3.0-flash-preview" "gemini-generatecontent" "$NATIVE_CONFIG"
test_mode "gemini-2.5-flash" "gemini-generatecontent" "$NATIVE_CONFIG"

# OpenAI-compatible mode tests
test_mode "gemini-3.1-pro-preview" "openai-completions" "$OPENAI_CONFIG"
test_mode "gemini-3.0-flash-preview" "openai-completions" "$OPENAI_CONFIG"
test_mode "gemini-2.5-flash" "openai-completions" "$OPENAI_CONFIG"

echo "=========================================="
echo "Results: $PASS passed, $FAIL failed"
echo "Success rate: $(awk "BEGIN {printf \"%.1f\", ($PASS/($PASS+$FAIL))*100}")%"
