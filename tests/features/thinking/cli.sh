#!/bin/bash

# Test thinking models using gemini CLI
# Config: ~/.gemini/.env, ./proxy_config.toml

MODELS=(
  "qwen3-30b-a3b-thinking-2507"
  "qwen3-next-80b-a3b-thinking"
  "qwen3-235b-a22b-thinking-2507"
  "doubao-seed-1.6-thinking"
  "doubao-1.5-thinking-pro"
  "moonshotai/kimi-k2-thinking"
  "deepseek/deepseek-v3.2-exp-thinking"
  "deepseek/deepseek-v3.1-terminus-thinking"
  "deepseek-r1-0528"
)

PROMPT="What is 2+2? Explain step by step."

echo "Testing ${#MODELS[@]} thinking models with gemini CLI"
echo ""

PASS=0
FAIL=0

for model in "${MODELS[@]}"; do
  echo "Model: $model"
  echo "gemini -y -m ${model} -p '${PROMPT}' "
  
  RESULT=$(timeout 20 gemini -y -m "$model" -p "$PROMPT" 2>&1)
  
  if [ $? -eq 0 ] && [ -n "$RESULT" ]; then
    echo "✅ $(echo "$RESULT" | grep -v "^DEBUG:" | tail -1 | head -c 80)..."
    ((PASS++))
  else
    echo "❌ $(echo "$RESULT" | grep -E "error|Error" | head -1 || echo "Failed")"
    ((FAIL++))
  fi
  echo ""
done

echo "=========================================="
echo "Results: $PASS passed, $FAIL failed"
echo "Success rate: $(awk "BEGIN {printf \"%.1f\", ($PASS/($PASS+$FAIL))*100}")%"
echo "=========================================="
#!/bin/bash

# Test all thinking models with curl (same questions as test_thinking_models.sh)
# This is the equivalent of running: gemini -y -d -m <model> -p <QUESTION>

BASE_URL="http://localhost:8788"
MODELS=(
  "deepseek/deepseek-v3.2-exp-thinking"
  "qwen3-vl-30b-a3b-thinking"
  "qwen3-30b-a3b-thinking-2507"
  "qwen3-next-80b-a3b-thinking"
  "qwen3-235b-a22b-thinking-2507"
  "doubao-seed-1.6-thinking"
  "doubao-1.5-thinking-pro"
  "deepseek/deepseek-v3.1-terminus-thinking"
  "moonshotai/kimi-k2-thinking"
)

echo "=========================================="
echo "Testing ${#MODELS[@]} thinking models (curl equivalent of gemini CLI)"
echo "=========================================="

TOTAL=0
PASSED=0

for MODEL in "${MODELS[@]}"; do
  echo ""
  echo "=========================================="
  echo "Model: $MODEL"
  echo "=========================================="
  
  TOTAL=$((TOTAL + 1))
  RESP=$(curl -s "$BASE_URL/v1/messages" -H "Content-Type: application/json" -H "Authorization: Bearer test" -d '{"model":"'"$MODEL"'","messages":[{"role":"user","content":"What is 2+2?"}],"max_tokens":50}')
  if echo "$RESP" | jq -e '.content[0].text' > /dev/null 2>&1; then
    echo "Q1(2+2): ✅ $(echo "$RESP" | jq -r '.content[0].text' | head -c 80)"
    PASSED=$((PASSED + 1))
  else
    echo "Q1(2+2): ❌"
  fi
  
  TOTAL=$((TOTAL + 1))
  RESP=$(curl -s "$BASE_URL/v1/interactions" -H "Content-Type: application/json" -H "Authorization: Bearer test" -d '{"model":"'"$MODEL"'","input":"What is 3+3?"}')
  if echo "$RESP" | jq -e '.outputs[0].text' > /dev/null 2>&1; then
    echo "Q2(3+3): ✅ $(echo "$RESP" | jq -r '.outputs[0].text' | head -c 80)"
    PASSED=$((PASSED + 1))
  else
    echo "Q2(3+3): ❌"
  fi
  
  TOTAL=$((TOTAL + 1))
  RESP=$(curl -s "$BASE_URL/v1beta/models/$MODEL:generateContent" -H "Content-Type: application/json" -H "Authorization: Bearer test" -d '{"contents":[{"role":"user","parts":[{"text":"What is 4+4?"}]}]}')
  if echo "$RESP" | jq -e '.content[0].text' > /dev/null 2>&1; then
    echo "Q3(4+4): ✅ $(echo "$RESP" | jq -r '.content[0].text' | head -c 80)"
    PASSED=$((PASSED + 1))
  else
    echo "Q3(4+4): ❌"
  fi
done

echo ""
echo "=========================================="
echo "Results: $PASSED/$TOTAL tests passed"
echo "Success rate: $(awk "BEGIN {printf \"%.1f\", ($PASSED/$TOTAL)*100}")%"
echo "=========================================="
