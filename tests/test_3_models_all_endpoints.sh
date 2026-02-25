#!/bin/bash

BASE_URL="http://localhost:8788"

# Gemini native
GEMINI_BASE="https/api.yoosheen.com"
GEMINI_KEY="sk-rFaHPAoJidbsN2BMeGcEe1bjIUeU7Nr2SKzbTY1ExOJHptP0"

# Claude native
CLAUDE_BASE="https/api.wenwen-ai.com"
CLAUDE_KEY="sk-NzBalLnHTBdlL23pQHFSzRZXA36HRio3s666mOcLxFfdmAfK"

# OpenAI-compatible
OPENAI_BASE="https/api.qnaigc.com"
OPENAI_KEY="sk-87abde0542f469130364cc3de48977a71883d8ec81987d3f7e46ee360985dd02"

MODELS=("gemini-2.5-flash" "claude-4.5-sonnet" "claude-4.5-haiku")
ENDPOINTS=("v1/messages" "v1/interactions")

test_model() {
  local model=$1
  local endpoint=$2
  local base=$3
  local key=$4
  local auth_type=$5
  local q=$6
  
  if [[ "$auth_type" == "bearer" ]]; then
    local auth_header="Authorization: Bearer $key"
  else
    local auth_header="x-api-key: $key"
  fi
  
  if [[ "$endpoint" == "v1/messages" ]]; then
    RESP=$(curl -s "$BASE_URL/$base/$endpoint" -H "Content-Type: application/json" -H "$auth_header" \
      -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"$q\"}],\"max_tokens\":50}")
    echo "$RESP" | jq -r '.content[0].text // .error.message // "✅ " + (.id // "ok")'
  elif [[ "$endpoint" == "v1/interactions" ]]; then
    RESP=$(curl -s "$BASE_URL/$base/$endpoint" -H "Content-Type: application/json" -H "$auth_header" \
      -d "{\"model\":\"$model\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"$q\"}]}}")
    echo "$RESP" | jq -r '.outputs[0].content[0].text // .error.message // "✅ " + (.id // "ok")'
  else
    RESP=$(curl -s "$BASE_URL/$base/v1beta/models/$model:generateContent" -H "Content-Type: application/json" -H "$auth_header" \
      -d "{\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"$q\"}]}]}")
    echo "$RESP" | jq -r '.content[0].text // .error.message // "✅ " + (.id // "ok")'
  fi
}

echo "Testing 3 models × 3 endpoints × 2 upstreams = 18 tests"
echo "========================================================"
echo

for model in "${MODELS[@]}"; do
  echo "Model: $model"
  echo "---"
  
  # Determine native upstream
  if [[ "$model" == "gemini-2.5-flash" ]]; then
    NATIVE_BASE=$GEMINI_BASE
    NATIVE_KEY=$GEMINI_KEY
    AUTH="apikey"
  else
    NATIVE_BASE=$CLAUDE_BASE
    NATIVE_KEY=$CLAUDE_KEY
    AUTH="apikey"
  fi
  
  # Test native endpoints
  echo "1. Native /v1/messages: $(test_model "$model" "v1/messages" "$NATIVE_BASE" "$NATIVE_KEY" "$AUTH" "2+2?")"
  echo "2. Native /v1/interactions: $(test_model "$model" "v1/interactions" "$NATIVE_BASE" "$NATIVE_KEY" "$AUTH" "3+3?")"
  echo "3. Native /v1beta/models/$model:generateContent: $(test_model "$model" "generateContent" "$NATIVE_BASE" "$NATIVE_KEY" "$AUTH" "4+4?")"
  
  # Test OpenAI-compatible endpoints
  echo "4. OpenAI /v1/messages: $(test_model "$model" "v1/messages" "$OPENAI_BASE" "$OPENAI_KEY" "bearer" "5+5?")"
  echo "5. OpenAI /v1/interactions: $(test_model "$model" "v1/interactions" "$OPENAI_BASE" "$OPENAI_KEY" "bearer" "6+6?")"
  echo "6. OpenAI /v1beta/models/$model:generateContent: $(test_model "$model" "generateContent" "$OPENAI_BASE" "$OPENAI_KEY" "bearer" "7+7?")"
  echo
done

echo "========================================================"
echo "✅ All 18 tests completed"
