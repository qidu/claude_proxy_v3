#!/bin/bash
# Test /v1/responses and /v1/responses/compact endpoints
# Usage: BASE_URL=http://localhost:3000 API_KEY=sk-xxx bash tests/test_responses_endpoints.sh

if [ -f ".env" ]; then
#  source .env
   echo
fi

BASE_URL="${BASE_URL:-http://localhost:8787}"
API_KEY="${API_KEY:-sk-test}"

MODELS=(
  "gpt-oss-120b-medium"
  "gemini-3-flash"
)

PASS=0
FAIL=0

ok()   { echo "  ✅ $1"; ((PASS++)); }
fail() { echo "  ❌ $1"; ((FAIL++)); }

# ─────────────────────────────────────────────
# /v1/responses  (non-streaming)
# ─────────────────────────────────────────────
test_responses_basic() {
  local model=$1
  local resp
  resp=$(curl -sf "$BASE_URL/v1/responses" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d "{
      \"model\": \"$model\",
      \"input\": \"What is 2 + 2? Reply with the number only.\",
      \"stream\": false
    }")

  if [ $? -ne 0 ]; then
    fail "$model  /v1/responses  (non-stream) — curl error"
    return
  fi

  local object id output_len status
  object=$(echo "$resp" | grep -o '"object":"[^"]*"' | head -1 | cut -d'"' -f4)
  id=$(echo "$resp" | grep -o '"id":"resp_[^"]*"' | head -1 | cut -d'"' -f4)
  status=$(echo "$resp" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  # output array non-empty: at least one item
  output_len=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('output', [])))" 2>/dev/null)

  if [ "$object" = "response" ] && [ -n "$id" ] && [ "$status" = "completed" ] && [ "${output_len:-0}" -gt 0 ]; then
    ok "$model  /v1/responses  (non-stream)  id=$id  output_items=$output_len"
  else
    fail "$model  /v1/responses  (non-stream)  object='$object' status='$status' output_items='$output_len'"
    echo "     preview: $(echo "$resp" | head -c 300)"
  fi
}

# ─────────────────────────────────────────────
# /v1/responses  (streaming)
# ─────────────────────────────────────────────
test_responses_stream() {
  local model=$1
  local raw
  raw=$(curl -sf "$BASE_URL/v1/responses" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d "{
      \"model\": \"$model\",
      \"input\": \"Count from 1 to 3.\",
      \"stream\": true
    }")

  if [ $? -ne 0 ]; then
    fail "$model  /v1/responses  (stream) — curl error"
    return
  fi

  local has_created has_completed has_done output_non_empty
  has_created=$(echo "$raw" | grep -c '"type":"response.created"')
  has_completed=$(echo "$raw" | grep -c '"type":"response.completed"')
  has_done=$(echo "$raw" | grep -c '\[DONE\]')

  # Extract output array from response.completed event and check length
  output_non_empty=$(echo "$raw" \
    | grep '"type":"response.completed"' \
    | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if line.startswith('data: '):
        line = line[6:]
    try:
        d = json.loads(line)
        out = d.get('response', {}).get('output', [])
        print(len(out))
    except Exception:
        pass
" 2>/dev/null | tail -1)

  if [ "${has_created:-0}" -ge 1 ] && [ "${has_completed:-0}" -ge 1 ] && \
     [ "${has_done:-0}" -ge 1 ] && [ "${output_non_empty:-0}" -gt 0 ]; then
    ok "$model  /v1/responses  (stream)  completed_output_items=$output_non_empty"
  else
    fail "$model  /v1/responses  (stream)  created=$has_created completed=$has_completed done=$has_done output_items=$output_non_empty"
    echo "     preview: $(echo "$raw" | head -c 400)"
  fi
}

# ─────────────────────────────────────────────
# /v1/responses  (with tools)
# ─────────────────────────────────────────────
test_responses_tools() {
  local model=$1
  local resp
  resp=$(curl -sf "$BASE_URL/v1/responses" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d "{
      \"model\": \"$model\",
      \"input\": \"What is the weather in Tokyo? Use the get_weather tool.\",
      \"stream\": false,
      \"tools\": [{
        \"type\": \"function\",
        \"name\": \"get_weather\",
        \"description\": \"Get current weather for a city.\",
        \"parameters\": {
          \"type\": \"object\",
          \"properties\": {
            \"city\": { \"type\": \"string\" }
          },
          \"required\": [\"city\"]
        }
      }],
      \"tool_choice\": \"auto\"
    }")

  if [ $? -ne 0 ]; then
    fail "$model  /v1/responses  (tools) — curl error"
    return
  fi

  local object status output_len
  object=$(echo "$resp" | grep -o '"object":"[^"]*"' | head -1 | cut -d'"' -f4)
  status=$(echo "$resp" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  output_len=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('output', [])))" 2>/dev/null)

  if [ "$object" = "response" ] && [ "$status" = "completed" ] && [ "${output_len:-0}" -gt 0 ]; then
    # Check if any function_call item was returned
    local has_fc
    has_fc=$(echo "$resp" | grep -c '"type":"function_call"')
    if [ "${has_fc:-0}" -gt 0 ]; then
      ok "$model  /v1/responses  (tools)  function_call returned"
    else
      ok "$model  /v1/responses  (tools)  responded without tool call (acceptable)"
    fi
  else
    fail "$model  /v1/responses  (tools)  object='$object' status='$status' output_items='$output_len'"
    echo "     preview: $(echo "$resp" | head -c 300)"
  fi
}

# ─────────────────────────────────────────────
# /v1/responses/compact
# Spec: POST /v1/responses/compact
#   Request: same shape as /v1/responses (model + input)
#   Response: { object: "response.compaction", id, created_at, output: [...] }
# ─────────────────────────────────────────────
test_responses_compact() {
  local model=$1

  # Build a short multi-turn conversation to compact
  local resp
  resp=$(curl -sf "$BASE_URL/v1/responses/compact" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d "{
      \"model\": \"$model\",
      \"input\": [
        {
          \"type\": \"message\",
          \"role\": \"user\",
          \"content\": [{\"type\": \"input_text\", \"text\": \"Hello, my name is Alice.\"}]
        },
        {
          \"type\": \"message\",
          \"role\": \"assistant\",
          \"content\": [{\"type\": \"output_text\", \"text\": \"Hello Alice! How can I help you today?\"}]
        },
        {
          \"type\": \"message\",
          \"role\": \"user\",
          \"content\": [{\"type\": \"input_text\", \"text\": \"What is my name?\"}]
        }
      ]
    }")

  if [ $? -ne 0 ]; then
    fail "$model  /v1/responses/compact — curl error"
    return
  fi

  local object id output_len
  object=$(echo "$resp" | grep -o '"object":"[^"]*"' | head -1 | cut -d'"' -f4)
  id=$(echo "$resp" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  output_len=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('output', [])))" 2>/dev/null)

  if [ "$object" = "response.compaction" ] && [ -n "$id" ] && [ "${output_len:-0}" -gt 0 ]; then
    ok "$model  /v1/responses/compact  id=$id  output_items=$output_len"
  else
    fail "$model  /v1/responses/compact  object='$object' output_items='$output_len'"
    echo "     preview: $(echo "$resp" | head -c 300)"
  fi
}

# ─────────────────────────────────────────────
# Run all tests
# ─────────────────────────────────────────────
echo "========================================"
echo "Responses API test suite"
echo "BASE_URL: $BASE_URL"
echo "Models:   ${MODELS[*]}"
echo "========================================"
echo ""

for MODEL in "${MODELS[@]}"; do
  echo "── $MODEL ──────────────────────────────"
  test_responses_basic  "$MODEL"
  test_responses_stream "$MODEL"
  test_responses_tools  "$MODEL"
  test_responses_compact "$MODEL"
  echo ""
done

echo "========================================"
echo "Results: $PASS passed, $FAIL failed"
if [ $FAIL -eq 0 ]; then
  echo "All tests passed ✅"
else
  echo "Some tests failed ❌"
  exit 1
fi
#!/bin/bash

if [ -f ".env" ]; then
    source .env
fi

echo "Start testing server $PORT ..."

PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js > /tmp/proxy_responses.log 2>&1 &
SERVER_PID=$!
sleep 3

PASS=0
FAIL=0

echo $BASE_URL
echo ${API_KEY: -32}

# Test models for /v1/responses endpoint
MODELS=(
  "qwen3-32b"
  "minimax/minimax-m2.5"
  "moonshotai/kimi-k2.5"
  "deepseek/deepseek-v3.2-251201"
  "z-ai/glm-4.7"
  "gpt-oss-120b"
  "stepfun/step-flash"
  "meituan/longcat-flash"
)

# Test /v1/responses with background=false
test_responses() {
  local name=$1
  local url=$2
  local data=$3

  RESP=$(curl -s "$url" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d "$data")

  echo "$RESP" >> /tmp/test_responses_output.txt
  echo ""

  # Check for Responses API format
  if echo "$RESP" | grep -qE '"status":"completed"|"id":"resp_|"object":"response"'; then
    echo "✅ $name: Response format correct"
    ((PASS++))
  else
    echo "❌ $name: Unexpected response format"
    echo "   Response preview: $(echo "$RESP" | head -c 200)"
    ((FAIL++))
  fi
  echo ""
}

echo "Responses API Test Suite (background=false)"
echo "============================================="
echo "Testing ${#MODELS[@]} models on /v1/responses endpoint"
echo

TOTAL_TESTS=${#MODELS[@]}

for MODEL in "${MODELS[@]}"; do
  echo "Model: $MODEL"
  echo "---"

  # Test /v1/responses with background=false
  test_responses "  /v1/responses" \
    "$BASE_URL/v1/responses" \
    "{\"model\":\"$MODEL\",\"input\":\"What is 2 + 3? Answer in one word.\",\"background\":false}"

  echo
done

echo "=========================================="
echo "Results: $PASS passed, $FAIL failed out of $TOTAL_TESTS tests"
echo "Success rate: $(awk "BEGIN {printf \"%.1f\", ($PASS/($PASS+$FAIL))*100}")%"

echo ""
echo "Log file: /tmp/proxy_responses.log"
echo "Output file: /tmp/test_responses_output.txt"

kill $SERVER_PID 2>/dev/null