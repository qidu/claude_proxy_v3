#!/bin/bash

# Claude Proxy v3 Configuration Script
#
# This script helps set up Claude Code CLI to work with the Claude Proxy v3.
# It provides an interactive way to configure your Claude CLI settings.

# Default values
DEFAULT_WORKER_URL="https://claude-proxy-v3.your-domain.workers.dev"
DEFAULT_API_KEY=""
DEFAULT_OPEN_AI_URL="api.qnaigc.com"
DEFAULT_OPEN_MODEL="deepseek-v3.1"
DEFAULT_THINKING_ENABLED="n"
DEFAULT_THINKING_BUDGET="10000"

# Interactive configuration
echo "=== Claude Proxy v3 Configuration ==="
echo

# Get user input
read -p "Enter Worker URL [default: $DEFAULT_WORKER_URL]: " input_worker_url
WORKER_URL="${input_worker_url:-$DEFAULT_WORKER_URL}"

read -p "Enter API Key [default: $DEFAULT_API_KEY]: " input_api_key
API_KEY="${input_api_key:-$DEFAULT_API_KEY}"

read -p "Enter OpenAI URL (without protocol) [default: $DEFAULT_OPEN_AI_URL]: " input_open_ai_url
OPEN_AI_URL="${input_open_ai_url:-$DEFAULT_OPEN_AI_URL}"

read -p "Enter Model Name [default: $DEFAULT_OPEN_MODEL]: " input_open_model
OPEN_MODEL="${input_open_model:-$DEFAULT_OPEN_MODEL}"

echo
echo "Extended Thinking Configuration:"
read -p "Enable thinking (y/N) [default: $DEFAULT_THINKING_ENABLED]: " input_thinking_enabled
THINKING_ENABLED="${input_thinking_enabled:-$DEFAULT_THINKING_ENABLED}"

if [[ "$THINKING_ENABLED" =~ ^[Yy]$ ]]; then
    read -p "Thinking budget tokens [default: $DEFAULT_THINKING_BUDGET]: " input_thinking_budget
    THINKING_BUDGET="${input_thinking_budget:-$DEFAULT_THINKING_BUDGET}"
else
    THINKING_BUDGET=""
fi

echo
echo "Configuration Summary:"
echo "Worker URL: $WORKER_URL"
echo "API Key: ${API_KEY:0:10}..."
echo "OpenAI URL: $OPEN_AI_URL"
echo "Model: $OPEN_MODEL"
if [[ "$THINKING_ENABLED" =~ ^[Yy]$ ]]; then
    echo "Thinking: Enabled (budget: $THINKING_BUDGET tokens)"
else
    echo "Thinking: Disabled"
fi
echo

read -p "Confirm configuration? (y/N): " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Configuration cancelled"
    exit 0
fi

# Constants
readonly CLAUDE_COMMAND="claude"
readonly NPM_PACKAGE="@anthropic-ai/claude-code"
readonly CLAUDE_DIR="$HOME/.claude"
readonly SETTINGS_FILE="$CLAUDE_DIR/settings.json"

# Build base URL for v3 format (different from v2)
readonly BASE_URL="$WORKER_URL/https/$OPEN_AI_URL/models/$OPEN_MODEL"
readonly TEST_BASE_URL="$WORKER_URL/https/$OPEN_AI_URL/models"

# Check Claude Code installation
echo "Checking for Claude Code installation..."

if command -v "$CLAUDE_COMMAND" &> /dev/null; then
    echo "Claude Code is already installed."
else
    echo "Claude Code not found. Installing..."

    if ! command -v npm &> /dev/null; then
        echo "Error: npm is not installed. Please install Node.js first."
        exit 1
    fi

    echo "Installing Claude Code via npm..."
    if ! npm install -g "$NPM_PACKAGE"; then
        echo "Error: Failed to install Claude Code."
        exit 1
    fi

    echo "Claude Code installed successfully."
fi

# Configure settings
echo "Setting up Claude Code configuration..."

if [ ! -d "$CLAUDE_DIR" ]; then
    mkdir -p "$CLAUDE_DIR"
fi

# Create sample configuration for v3
if [ -f "$SETTINGS_FILE" ]; then
    echo "Settings file exists. Creating backup..."
    cp "$SETTINGS_FILE" "$SETTINGS_FILE.backup.$(date +%Y%m%d_%H%M%S)"
fi

# Create new settings with proxy example
cat > "$SETTINGS_FILE" << EOF
{
  "env": {
    "ANTHROPIC_API_KEY": "$API_KEY",
    "ANTHROPIC_BASE_URL": "$BASE_URL"
  },
  "permissions": {
    "allow": [],
    "deny": []
  },
  "apiKeyHelper": "echo '$API_KEY'",
  "__proxy_examples__": {
    "models": "GET $TEST_BASE_URL/v1/models",
    "messages": "POST $BASE_URL/v1/messages",
    "token_counting": "POST $BASE_URL/v1/messages/count_tokens$( [[ "$THINKING_ENABLED" =~ ^[Yy]$ ]] && echo -e "\n  Example with thinking:\n  {\n    \"thinking\": {\n      \"type\": \"enabled\",\n      \"budget_tokens\": $THINKING_BUDGET\n    }\n  }" || echo "" )"
  }
}
EOF

echo "Configuration complete!"
echo "Settings saved to: $SETTINGS_FILE"
echo

# Test connection
echo "=== Testing Proxy Connection ==="
echo "Testing different proxy endpoints..."

# Test Models API
echo
echo "1. Testing Models API..."
MODELS_URL="$TEST_BASE_URL/v1/models"
if [ -n "$API_KEY" ]; then
    curl_response=$(curl -s -w "\n%{http_code}" \
      -X GET \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $API_KEY" \
      "$MODELS_URL" 2>/dev/null || echo "CURL_FAILED")
else
    curl_response=$(curl -s -w "\n%{http_code}" \
      -X GET \
      -H "Content-Type: application/json" \
      "$MODELS_URL" 2>/dev/null || echo "CURL_FAILED")
fi

http_code=$(echo "$curl_response" | tail -n1)
response_body=$(echo "$curl_response" | sed '$d')

if [ "$http_code" = "200" ]; then
    echo "✅ Models API connected successfully!"
    echo "   Found models: $(echo "$response_body" | grep -o '"id":"[^"]*"' | head -5 | sed 's/"id":"//g' | sed 's/"//g' | tr '\n' ' ')"
else
    echo "⚠️  Models API returned HTTP $http_code"
    echo "   This may be expected if the target API doesn't support models listing"
fi

# Test token counting (optional test)
echo
echo "2. Testing Token Counting API (optional)..."
if [[ "$THINKING_ENABLED" =~ ^[Yy]$ ]]; then
    THINKING_JSON=",\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":$THINKING_BUDGET}"
else
    THINKING_JSON=""
fi

TOKEN_COUNTING_URL="$BASE_URL/v1/messages/count_tokens"
TEST_DATA='{
  "model": "'"$OPEN_MODEL"'",
  "messages": [
    {
      "role": "user",
      "content": "Test message for token counting"
    }
  ]
'"$THINKING_JSON"'
}'

if [ -n "$API_KEY" ]; then
    curl_response=$(curl -s -w "\n%{http_code}" \
      -X POST \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $API_KEY" \
      -d "$TEST_DATA" \
      "$TOKEN_COUNTING_URL" 2>/dev/null || echo "CURL_FAILED")
else
    curl_response=$(curl -s -w "\n%{http_code}" \
      -X POST \
      -H "Content-Type: application/json" \
      -d "$TEST_DATA" \
      "$TOKEN_COUNTING_URL" 2>/dev/null || echo "CURL_FAILED")
fi

http_code=$(echo "$curl_response" | tail -n1)
response_body=$(echo "$curl_response" | sed '$d')

if [ "$http_code" = "200" ]; then
    echo "✅ Token Counting API connected successfully!"
    echo "   Response: $(echo "$response_body" | grep -o '"input_tokens":[0-9]*' | head -1)"
elif [ "$http_code" = "400" ] || [ "$http_code" = "404" ] || [ "$http_code" = "501" ]; then
    echo "⚠️  Token Counting API returned HTTP $http_code"
    echo "   This may be expected if the target API doesn't support token counting"
else
    echo "⚠️  Token Counting API returned HTTP $http_code"
fi

echo
echo "=== Setup Complete ==="
echo
echo "Your Claude CLI is now configured to use Claude Proxy v3!"
echo
echo "Usage examples:"
echo
echo "1. List available models:"
echo "   curl -X GET '$MODELS_URL' \\"
echo "     -H 'Authorization: Bearer YOUR_API_KEY'"
echo
echo "2. Send a message:"
if [[ "$THINKING_ENABLED" =~ ^[Yy]$ ]]; then
    echo "   curl -X POST '$BASE_URL/v1/messages' \\"
    echo "     -H 'Content-Type: application/json' \\"
    echo "     -H 'Authorization: Bearer YOUR_API_KEY' \\"
    echo "     -d '{\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}],\"max_tokens\":100,\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":$THINKING_BUDGET}}'"
else
    echo "   curl -X POST '$BASE_URL/v1/messages' \\"
    echo "     -H 'Content-Type: application/json' \\"
    echo "     -H 'Authorization: Bearer YOUR_API_KEY' \\"
    echo "     -d '{\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}],\"max_tokens\":100}'"
fi
echo
echo "3. Count tokens:"
echo "   curl -X POST '$BASE_URL/v1/messages/count_tokens' \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -H 'Authorization: Bearer YOUR_API_KEY' \\"
echo "     -d '$TEST_DATA'"
echo
echo "To use with Claude CLI:"
echo "   claude 'Hello, how are you?'"
echo
echo "Remember: Your API key is stored in ~/.claude/settings.json"
echo "You can modify the settings file if you need to change configuration."
