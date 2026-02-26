#!/bin/bash

cd /home/teric/win/e/dev/bot/claude_proxy_v3

BASE="http://localhost:8788"

MODELS=(
  "claude-4.6-sonnet"
  "claude-4.6-opus"
  "gemini-2.0-flash"
  "gemini-2.5-pro"
  "gemini-3.0-flash-preview"
)

test_model() {
  local model=$1
  local mode=$2
  local pass=0
  local fail=0
  
  echo "Testing: $model ($mode mode)"
  
  # Non-streaming /v1/messages
  RESP=$(timeout 10 curl -s "$BASE/v1/messages" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"max_tokens\":20}" 2>/dev/null)
  if echo "$RESP" | jq -e '.id' > /dev/null 2>&1; then
    echo "  ✅ /v1/messages"
    ((pass++))
  else
    echo "  ❌ /v1/messages: $(echo "$RESP" | jq -r '.error.message // "Failed"' | head -c 50)"
    ((fail++))
  fi
  
  # Streaming /v1/messages
  RESP=$(timeout 20 curl -s -N "$BASE/v1/messages" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"max_tokens\":20,\"stream\":true}" 2>/dev/null | head -1)
  if echo "$RESP" | grep -qE "^(event:|data:)"; then
    echo "  ✅ /v1/messages (stream)"
    ((pass++))
  else
    echo "  ❌ /v1/messages (stream)"
    ((fail++))
  fi
  
  # Non-streaming /v1/interactions
  RESP=$(timeout 10 curl -s "$BASE/v1/interactions" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}]}}" 2>/dev/null)
  if echo "$RESP" | jq -e '.id' > /dev/null 2>&1; then
    echo "  ✅ /v1/interactions"
    ((pass++))
  else
    echo "  ❌ /v1/interactions: $(echo "$RESP" | jq -r '.error.message // "Failed"' | head -c 50)"
    ((fail++))
  fi
  
  # Streaming /v1/interactions
  RESP=$(timeout 20 curl -s -N "$BASE/v1/interactions" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}]},\"stream\":true}" 2>/dev/null | head -1)
  if echo "$RESP" | grep -qE "^(event:|data:)"; then
    echo "  ✅ /v1/interactions (stream)"
    ((pass++))
  else
    echo "  ❌ /v1/interactions (stream)"
    ((fail++))
  fi
  
  # Non-streaming generateContent
  RESP=$(timeout 10 curl -s "$BASE/v1beta/models/$model:generateContent" \
    -H "Content-Type: application/json" \
    -d '{"contents":[{"role":"user","parts":[{"text":"Hi"}]}]}' 2>/dev/null)
  if echo "$RESP" | jq -e '.id' > /dev/null 2>&1; then
    echo "  ✅ generateContent"
    ((pass++))
  else
    echo "  ❌ generateContent: $(echo "$RESP" | jq -r '.error.message // "Failed"' | head -c 50)"
    ((fail++))
  fi
  
  # Streaming streamGenerateContent
  RESP=$(timeout 20 curl -s -N "$BASE/v1beta/models/$model:streamGenerateContent" \
    -H "Content-Type: application/json" \
    -d '{"contents":[{"role":"user","parts":[{"text":"Hi"}]}]}' 2>/dev/null | head -1)
  if echo "$RESP" | grep -qE "^(event:|data:)"; then
    echo "  ✅ streamGenerateContent"
    ((pass++))
  else
    echo "  ❌ streamGenerateContent"
    ((fail++))
  fi
  
  local total=$((pass + fail))
  echo "  Result: $pass/$total"
  echo ""
  
  echo "$model,$mode,$pass,$total" >> /tmp/oversea_results.csv
}

# Clear results file
echo "model,mode,pass,total" > /tmp/oversea_results.csv

echo "=========================================="
echo "Testing Oversea Models - Native Mode"
echo "=========================================="
echo ""

# Copy oversea config
cp proxy_config.toml_oversea proxy_config.toml

# Start server
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_oversea.log 2>&1 &
SERVER_PID=$!
sleep 4

# Test each model in native mode
for model in "${MODELS[@]}"; do
  test_model "$model" "native"
done

# Stop server
kill $SERVER_PID 2>/dev/null
sleep 2

echo "=========================================="
echo "Testing Oversea Models - OpenAI Mode"
echo "=========================================="
echo ""

# Update config for OpenAI mode
cat > proxy_config.toml << 'EOF'
[upstream]
default_url = "https://api.qnaigc.com/v1"
default_api_key = "sk-28f417e15b4643913bce23520d5948327c******"

[defaults]
mode = "openai-completions"

[models.claude-4-6-sonnet]
mode = "openai-completions"

[models.claude-4-6-opus]
mode = "openai-completions"

[models.gemini-2-0-flash]
mode = "openai-completions"

[models.gemini-2-5-pro]
mode = "openai-completions"

[models.gemini-3-0-flash-preview]
mode = "openai-completions"
EOF

# Start server
PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_oversea_openai.log 2>&1 &
SERVER_PID=$!
sleep 4

# Test each model in OpenAI mode
for model in "${MODELS[@]}"; do
  test_model "$model" "openai"
done

# Stop server
kill $SERVER_PID 2>/dev/null
sleep 2

echo "=========================================="
echo "Summary"
echo "=========================================="
echo ""

# Display results
cat /tmp/oversea_results.csv | column -t -s,

echo ""
echo "Test Complete"
