#!/bin/bash

# Token Counting Test Script for model_proxy_v3
# Tests token counting for various models and content types

set -e

# ============================================================
# Configuration
# ============================================================

PORT=8788
PROXY_ENDPOINT="http://localhost:${PORT}/v1/messages"
COUNT_TOKENS_ENDPOINT="http://localhost:${PORT}/v1/messages/count_tokens"

source .env

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1" >&2; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1" >&2; }
log_test() { echo -e "${BLUE}[TEST]${NC} $1" >&2; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# ============================================================
# Test Data
# ============================================================

SHORT_TEXT="Hello, how are you today?"
DOC_CONTENT=$(cat /home/teric/win/e/dev/bot/model_proxy_v3/docs/claude-api-reference.md 2>/dev/null || echo "")

# Get all .ts files in src directory
get_src_files() {
    find /home/teric/win/e/dev/bot/model_proxy_v3/src -type f -name "*.ts" 2>/dev/null | sort
}

# ============================================================
# Test Functions
# ============================================================

test_short_text() {
    local model="$1"
    log_test "Testing short text with model: $model"
    
    local response=$(curl -s -X POST "$COUNT_TOKENS_ENDPOINT" \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -H "x-api-key: $API_KEY" \
        -d "{\"model\": \"$model\", \"messages\": [{\"role\": \"user\", \"content\": \"$SHORT_TEXT\"}], \"max_tokens\": 1024}")
    
    local input_tokens=$(echo "$response" | jq -r '.input_tokens // 0')
    echo "$input_tokens"
}

test_doc_content() {
    local model="$1"
    log_test "Testing doc content with model: $model"

    # Use temp file to avoid command line issues with large content
    local json_file=$(mktemp)
    local escaped=$(echo "$DOC_CONTENT" | jq -Rs '.')
    printf '{"model": "%s", "messages": [{"role": "user", "content": %s}], "max_tokens": 1024}\n' "$model" "$escaped" > "$json_file"

    local response=$(curl -s -X POST "$COUNT_TOKENS_ENDPOINT" \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -H "x-api-key: $API_KEY" \
        --data-binary @"$json_file")

    rm -f "$json_file"

    # Safely parse JSON response
    local input_tokens=$(echo "$response" | jq -r 'try .input_tokens // "0"' 2>/dev/null || echo "0")
    local token_counting_method=$(curl -s -X POST "$COUNT_TOKENS_ENDPOINT" \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -H "x-api-key: $API_KEY" \
        -d "{\"model\": \"$model\", \"messages\": [{\"role\": \"user\", \"content\": \"test\"}], \"max_tokens\": 1024}" \
        -D - 2>/dev/null | grep -i "x-token-counting" | cut -d: -f2 | tr -d ' \r' || echo "unknown")

    echo "$input_tokens|$token_counting_method"
}

test_src_file() {
    local file_path="$1"
    local model="${2:-deepseek/deepseek-v3.2-251201}"

    local file_name=$(basename "$file_path")
    log_test "Testing file: $file_name with model: $model"

    local content=$(cat "$file_path" 2>/dev/null || echo "")
    [ -z "$content" ] && echo "0" && return

    # Use a temp file and proper JSON escaping
    local json_file=$(mktemp)
    # Use jq -Rs (raw string) which produces valid JSON string
    local escaped=$(echo "$content" | jq -Rs '.')
    printf '{"model": "%s", "messages": [{"role": "user", "content": %s}], "max_tokens": 1024}\n' "$model" "$escaped" > "$json_file"

    local response=$(curl -s -X POST "$COUNT_TOKENS_ENDPOINT" \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -H "x-api-key: $API_KEY" \
        --data-binary @"$json_file")

    rm -f "$json_file"

    # Check if response is valid JSON and contains input_tokens
    local input_tokens=$(echo "$response" | jq -r 'try .input_tokens // "0"' 2>/dev/null)
    if [ -z "$input_tokens" ] || ! [[ "$input_tokens" =~ ^[0-9]+$ ]]; then
        echo "0"
    else
        echo "$input_tokens"
    fi
}

# ============================================================
# Test Suites
# ============================================================

run_short_text_tests() {
    log_info "=== Test Suite: Short Text Token Counting ==="
    
    local models=(
        "deepseek/deepseek-v3.2-251201"
        "minimax/minimax-m2.5"
        "moonshotai/kimi-k2.5"
        "z-ai/glm-5"
    )
    
    echo ""
    echo "| Model | Input Tokens |"
    echo "|-------|-------------|"
    
    for model in "${models[@]}"; do
        local tokens=$(test_short_text "$model")
        echo "| $model | $tokens |"
    done
    echo ""
}

run_doc_content_tests() {
    log_info "=== Test Suite: Documentation Content Token Counting ==="
    
    local models=(
        "deepseek/deepseek-v3.2-251201"
        "minimax/minimax-m2.5"
        "moonshotai/kimi-k2.5"
        "z-ai/glm-5"
        "claude-sonnet-4-20250514"
    )
    
    echo ""
    echo "| Model | Input Tokens | Counting Method |"
    echo "|-------|-------------|-----------------|"
    
    for model in "${models[@]}"; do
        local result=$(test_doc_content "$model")
        local tokens=$(echo "$result" | cut -d'|' -f1)
        local method=$(echo "$result" | cut -d'|' -f2)
        echo "| $model | $tokens | $method |"
    done
    echo ""
}

run_src_file_tests() {
    log_info "=== Test Suite: Source Files Token Counting ==="
    log_info "Model: deepseek/deepseek-v3.2-251201"
    
    local files=($(get_src_files))
    
    local total_tokens=0
    local file_count=0
    
    echo ""
    echo "| File | Input Tokens |"
    echo "|-------|-------------|"
    
    # Create temp file for results
    local temp_file=$(mktemp)
    
    for file in "${files[@]}"; do
        local tokens=$(test_src_file "$file")
        if [ "$tokens" != "0" ] && [ -n "$tokens" ]; then
            local relative_path="${file#/home/teric/win/e/dev/bot/model_proxy_v3/}"
            # Use a unique separator for sorting
            echo -e "${relative_path}\t${tokens}" >> "$temp_file"
            total_tokens=$((total_tokens + tokens))
            file_count=$((file_count + 1))
        fi
    done

    # Sort by tokens descending (field 2, numeric, reverse) and display
    sort -t$'\t' -k2 -nr "$temp_file" 2>/dev/null | while IFS=$'\t' read -r path tok; do
        echo "| $path | $tok |"
    done
    rm -f "$temp_file"
    
    echo ""
    log_info "Total files: $file_count"
    log_info "Total tokens: $total_tokens"
    echo ""
}

run_model_comparison_tests() {
    log_info "=== Test Suite: Model Comparison (Same Input) ==="
    
    local test_input="The quick brown fox jumps over the lazy dog. This is a sample sentence for testing tokenization across different AI models. Artificial intelligence has rapidly transformed from a speculative concept to a practical reality."
    
    local models=(
        "deepseek/deepseek-v3.2-251201"
        "minimax/minimax-m2.5"
        "moonshotai/kimi-k2.5"
        "z-ai/glm-5"
        "claude-sonnet-4-20250514"
    )
    
    echo ""
    echo "| Model | Input Tokens |"
    echo "|-------|-------------|"
    
    for model in "${models[@]}"; do
        local response=$(curl -s -X POST "$COUNT_TOKENS_ENDPOINT" \
            -H "Content-Type: application/json" \
            -H "anthropic-version: 2023-06-01" \
            -H "x-api-key: $API_KEY" \
            -d "{\"model\": \"$model\", \"messages\": [{\"role\": \"user\", \"content\": \"$test_input\"}], \"max_tokens\": 1024}")
        
        local tokens=$(echo "$response" | jq -r '.input_tokens // 0')
        echo "| $model | $tokens |"
    done
    echo ""
}

# ============================================================
# Main
# ============================================================

print_help() {
    echo "Token Counting Test Script"
    echo ""
    echo "Usage: $0 [test_suite]"
    echo ""
    echo "Test Suites:"
    echo "  short_text     - Test short text token counting"
    echo "  doc_content    - Test documentation content token counting"
    echo "  src_files      - Test all source files token counting"
    echo "  model_compare  - Compare token counting across models"
    echo "  all            - Run all test suites (default)"
    echo ""
}

main() {
    local suite="${1:-all}"
    
    echo ""
    echo "=============================================="
    echo "     Token Counting Test Results"
    echo "=============================================="
    echo ""
    log_info "Proxy: $PROXY_ENDPOINT"
    log_info "API Key: ${API_KEY:0:10}..."
    echo ""
    
    # Verify proxy is running
    if ! curl -s "$PROXY_ENDPOINT" > /dev/null 2>&1; then
        log_error "Proxy is not running at $PROXY_ENDPOINT"
        exit 1
    fi
    
    case "$suite" in
        short_text)
            run_short_text_tests
            ;;
        doc_content)
            run_doc_content_tests
            ;;
        src_files)
            run_src_file_tests
            ;;
        model_compare)
            run_model_comparison_tests
            ;;
        all)
            run_short_text_tests
            run_doc_content_tests
            run_model_comparison_tests
            run_src_file_tests
            ;;
        help|--help|-h)
            print_help
            ;;
        *)
            log_error "Unknown test suite: $suite"
            print_help
            exit 1
            ;;
    esac
    
    log_info "All tests completed!"
}

main "$@"
