#!/bin/bash

# Test streaming with gemini CLI
# Config: ~/.gemini/.env, ./proxy_config.toml

MODELS=(
  "qwen3-32b"
  "deepseek/deepseek-v3.2-251201"
  "gemini-2.5-flash"
  "claude-4.6-sonnet"
)

PROMPT="Count from 1 to 5, then say done"

echo "Testing streaming with gemini CLI"
echo ""

PASS=0
FAIL=0

for model in "${MODELS[@]}"; do
  echo "=========================================="
  echo "Model: $model"
  echo "=========================================="
  
  RESULT=$(timeout 15 gemini --debug -y -m "$model" -p "$PROMPT" 2>&1)
  
  if [ $? -eq 0 ] && [ -n "$RESULT" ]; then
    if echo "$RESULT" | grep -qE "(chunk|stream|SSE|event:)"; then
      echo "✅ Streaming detected"
    else
      echo "✅ Response received"
    fi
    echo "Output: $(echo "$RESULT" | grep -v "^DEBUG:" | tail -1)"
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
