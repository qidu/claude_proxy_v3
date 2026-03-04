echo '
GEMINI_API_KEY="sk-17ac71ed56aee***"
GOOGLE_GEMINI_BASE_URL="http://localhost:8788"
' > .env

MODELS=(
  "qwen3-32b"
  "qwen-max-2025-01-25"
  "minimax/minimax-m2.1"
  "minimax/minimax-m2.5"
  "moonshotai/kimi-k2.5"
  "deepseek/deepseek-v3.2"
  "gemini-2.5-flash"
  "claude-4.5-sonnet"
  "z-ai/glm-4.7"
)

for MODEL in "${MODELS[@]}"; do
    echo "# Testing Gemini CLI with model: $MODEL" 
    gemini -y -m "$MODEL" -p "What is 4 + 5 =? Answer in one word."
done
