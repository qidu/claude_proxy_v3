#!/bin/bash

# Claude Messages API 测试脚本
# 生成的测试脚本，对应 TEST_DOCUMENTATION.md 中的所有测试用例
#
# 用法: ./test_messages.sh [test_case_number]
# 不带参数则运行所有测试用例
# 带参数则只运行指定的测试用例 (如: ./test_messages.sh TC001)

set -e

# ============================================================
# 配置
# ============================================================
API_KEY="sk-d8d563******"
API_KEY="sk-d8d563c410cd87a6c29dc81bf983aa935a16fe27166a8eb0444c1324ec15b854"
MODEL="minimax/minimax-m2.1"

# API 端点
A_ENDPOINT="https://api.qnaigc.com/v1/messages"
A_COUNT_ENDPOINT="https://api.qnaigc.com/v1/messages/count_tokens"

B_PORT=8788
B_ENDPOINT="http://localhost:${B_PORT}/https/api.qnaigc.com/v1/messages"
B_COUNT_ENDPOINT="http://localhost:${B_PORT}/https/api.qnaigc.com/v1/messages/count_tokens"
B_ENDPOINT="http://localhost:${B_PORT}/v1/messages"
B_COUNT_ENDPOINT="http://localhost:${B_PORT}/v1/messages/count_tokens"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 输出函数
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 通用请求函数
curl_post() {
    local endpoint="$1"
    local data="$2"
    local desc="$3"

    log_info "测试: $desc"
    log_info "端点: $endpoint"

    time curl -s -X POST "$endpoint" \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -H "X-Api-Key: $API_KEY" \
        -d "$data" | jq '.'
}

# ============================================================
# 测试用例
# ============================================================

# TC001: 基础文本对话
test_TC001() {
    log_info "=== TC001: 基础文本对话 ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "你好，请介绍一下你自己"}], "max_tokens": 1024}'

    echo "--- 直连请求 ---"
    curl_post "$A_ENDPOINT" "$data" "TC001 直连"

    echo ""
    echo "--- 代理请求 ---"
    curl_post "$B_ENDPOINT" "$data" "TC001 代理"
}

# TC002: 多轮对话
test_TC002() {
    log_info "=== TC002: 多轮对话 ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "什么是机器学习？"}, {"role": "assistant", "content": "机器学习是..."}, {"role": "user", "content": "能举个具体的例子吗？"}], "max_tokens": 1024}'

    echo "--- 直连请求 ---"
    curl_post "$A_ENDPOINT" "$data" "TC002 直连"

    echo ""
    echo "--- 代理请求 ---"
    curl_post "$B_ENDPOINT" "$data" "TC002 代理"
}

# TC003: 系统提示词
test_TC003() {
    log_info "=== TC003: 系统提示词 ==="

    local data='{"model": "'"$MODEL"'", "system": "你是一位专业的Python编程助手", "messages": [{"role": "user", "content": "写一个快速排序算法"}], "max_tokens": 2048}'

    echo "--- 直连请求 ---"
    curl_post "$A_ENDPOINT" "$data" "TC003 直连"

    echo ""
    echo "--- 代理请求 ---"
    curl_post "$B_ENDPOINT" "$data" "TC003 代理"
}

# TC004: 自定义停止序列
test_TC004() {
    log_info "=== TC004: 自定义停止序列 ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "列出5个编程语言"}], "max_tokens": 1024, "stop_sequences": ["4."]}'

    echo "--- 直连请求 ---"
    curl_post "$A_ENDPOINT" "$data" "TC004 直连"

    echo ""
    echo "--- 代理请求 ---"
    curl_post "$B_ENDPOINT" "$data" "TC004 代理"
}

# TC005: 温度参数测试
test_TC005() {
    log_info "=== TC005: 温度参数测试 ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "1+1等于几"}], "max_tokens": 1024, "temperature": 0.0}'

    echo "--- 直连请求 ---"
    curl_post "$A_ENDPOINT" "$data" "TC005 直连"

    echo ""
    echo "--- 代理请求 ---"
    curl_post "$B_ENDPOINT" "$data" "TC005 代理"
}

# TC006: 流式响应
test_TC006() {
    log_info "=== TC006: 流式响应 ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "写一首关于春天的诗"}], "max_tokens": 1024, "stream": true}'

    echo "--- 直连请求 ---"
    log_info "TC006 直连 (流式响应)"
    curl -s -X POST "$A_ENDPOINT" \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -H "X-Api-Key: $API_KEY" \
        -d "$data" \
        --no-buffer

    echo ""
    echo "--- 代理请求 ---"
    log_info "TC006 代理 (流式响应)"
    curl -s -X POST "$B_ENDPOINT" \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -H "X-Api-Key: $API_KEY" \
        -d "$data" \
        --no-buffer
}

# TC007: 工具调用 (Tool Use)
test_TC007() {
    log_info "=== TC007: 工具调用 (Tool Use) ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "请帮我查询天气"}], "max_tokens": 1024, "tools": [{"name": "get_weather", "description": "获取指定城市的天气信息", "input_schema": {"type": "object", "properties": {"city": {"type": "string", "description": "城市名称"}}, "required": ["city"]}}]}'

    echo "--- 直连请求 ---"
    curl_post "$A_ENDPOINT" "$data" "TC007 直连"

    echo ""
    echo "--- 代理请求 ---"
    curl_post "$B_ENDPOINT" "$data" "TC007 代理"
}

# TC008: 扩展思考 (Thinking)
test_TC008() {
    log_info "=== TC008: 扩展思考 (Thinking) ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "分析一下人工智能的发展趋势"}], "max_tokens": 4096, "thinking": {"type": "enabled", "budget_tokens": 2048}}'

    echo "--- 直连请求 ---"
    curl_post "$A_ENDPOINT" "$data" "TC008 直连"

    echo ""
    echo "--- 代理请求 ---"
    curl_post "$B_ENDPOINT" "$data" "TC008 代理"
}

# TC009: 图片输入 (Image) - 需要替换 BASE64_ENCODED_IMAGE_DATA
test_TC009() {
    log_info "=== TC009: 图片输入 (Image) ==="
    log_warn "注意: 需要替换 BASE64_ENCODED_IMAGE_DATA 为实际的 base64 编码图片"

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": [{"type": "text", "text": "描述这张图片中的内容"}, {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "BASE64_ENCODED_IMAGE_DATA"}}]}], "max_tokens": 1024}'

    echo "--- 直连请求 ---"
    curl_post "$A_ENDPOINT" "$data" "TC009 直连"

    echo ""
    echo "--- 代理请求 ---"
    curl_post "$B_ENDPOINT" "$data" "TC009 代理"
}

# TC010: 长文本输入 - 需要创建 long_text.txt 文件
test_TC010() {
    log_info "=== TC010: 长文本输入 ==="
    log_warn "注意: 需要创建 long_text.txt 文件"

    if [ ! -f "long_text.txt" ]; then
        log_error "long_text.txt 文件不存在，请先创建该文件"
        return 1
    fi

    local content=$(cat long_text.txt | jq -Rs .)
    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": '"$content"' }], "max_tokens": 1024}'

    echo "--- 直连请求 ---"
    curl_post "$A_ENDPOINT" "$data" "TC010 直连"

    echo ""
    echo "--- 代理请求 ---"
    curl_post "$B_ENDPOINT" "$data" "TC010 代理"
}

# TC011: 基础Token计数
test_TC011() {
    log_info "=== TC011: 基础Token计数 ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "Hello, world"}]}'

    echo "--- 直连请求 ---"
    curl_post "$A_COUNT_ENDPOINT" "$data" "TC011 直连"

    echo ""
    echo "--- 代理请求 ---"
    curl_post "$B_COUNT_ENDPOINT" "$data" "TC011 代理"
}

# TC012: 带系统提示的Token计数
test_TC012() {
    log_info "=== TC012: 带系统提示的Token计数 ==="

    local data='{"model": "'"$MODEL"'", "system": "你是一位helpful assistant", "messages": [{"role": "user", "content": "今天天气怎么样"}]}'

    echo "--- 直连请求 ---"
    curl_post "$A_COUNT_ENDPOINT" "$data" "TC012 直连"

    echo ""
    echo "--- 代理请求 ---"
    curl_post "$B_COUNT_ENDPOINT" "$data" "TC012 代理"
}

# TC013: 工具定义的Token计数
test_TC013() {
    log_info "=== TC013: 工具定义的Token计数 ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "请帮我查询天气"}], "tools": [{"name": "get_weather", "description": "获取天气", "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}]}'

    echo "--- 直连请求 ---"
    curl_post "$A_COUNT_ENDPOINT" "$data" "TC013 直连"

    echo ""
    echo "--- 代理请求 ---"
    curl_post "$B_COUNT_ENDPOINT" "$data" "TC013 代理"
}

# TC014: 无效API Key
test_TC014() {
    log_info "=== TC014: 无效API Key ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "test"}], "max_tokens": 1024}'

    echo "--- 直连请求 (无效API Key) ---"
    curl -s -X POST "$A_ENDPOINT" \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -H "X-Api-Key: invalid_key" \
        -d "$data" | jq '.'

    echo ""
    echo "--- 代理请求 (无效API Key) ---"
    curl -s -X POST "$B_ENDPOINT" \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -H "X-Api-Key: invalid_key" \
        -d "$data" | jq '.'
}

# TC015: 缺少必填参数
test_TC015() {
    log_info "=== TC015: 缺少必填参数 ==="

    echo "--- 直连请求 (缺少必填参数) ---"
    curl -s -X POST "$A_ENDPOINT" \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -H "X-Api-Key: $API_KEY" \
        -d '{"model": "'"$MODEL"'"}' | jq '.'

    echo ""
    echo "--- 代理请求 (缺少必填参数) ---"
    curl -s -X POST "$B_ENDPOINT" \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -H "X-Api-Key: $API_KEY" \
        -d '{"model": "'"$MODEL"'"}' | jq '.'
}

# TC016: 无效的Model
test_TC016() {
    log_info "=== TC016: 无效的Model ==="

    local data='{"model": "non_existent_model", "messages": [{"role": "user", "content": "test"}], "max_tokens": 1024}'

    echo "--- 直连请求 (无效Model) ---"
    curl_post "$A_ENDPOINT" "$data" "TC016 直连"

    echo ""
    echo "--- 代理请求 (无效Model) ---"
    curl_post "$B_ENDPOINT" "$data" "TC016 代理"
}

# TC017: 超出Rate Limit - 并发测试
test_TC017() {
    log_info "=== TC017: 超出Rate Limit ==="
    log_info "发送 20 个并发请求..."

    echo "--- 直连并发请求 ---"
    for i in {1..3}; do
        curl -s -w "%{http_code}" -X POST "$A_ENDPOINT" \
            -H "Content-Type: application/json" \
            -H "anthropic-version: 2023-06-01" \
            -H "X-Api-Key: $API_KEY" \
            -d '{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "test '"$i"'" }], "max_tokens": 64}' \
            -o /dev/null
            
        echo ${http_code}
    done
    wait
    log_info "并发请求完成"

    echo ""
    echo "--- 代理并发请求 ---"
    for i in {1..3}; do
        curl -s -w "%{http_code}" -X POST "$B_ENDPOINT" \
            -H "Content-Type: application/json" \
            -H "anthropic-version: 2023-06-01" \
            -H "X-Api-Key: $API_KEY" \
            -d '{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "test '"$i"'" }], "max_tokens": 64}' \
            -o /dev/null
        echo ${http_code}
    done
    wait
    log_info "并发请求完成"
}

# TC018: 基础功能对比 (自动化对比)
test_TC018() {
    log_info "=== TC018: 基础功能对比 (自动化) ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "你好"}], "max_tokens": 512}'

    echo "--- 获取直连响应 ---"
    local direct_response=$(curl -s -X POST "$A_ENDPOINT" \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -H "X-Api-Key: $API_KEY" \
        -d "$data")

    local direct_model=$(echo "$direct_response" | jq -r '.model')
    local direct_input_tokens=$(echo "$direct_response" | jq -r '.usage.input_tokens')

    echo "直连 - model: $direct_model"
    echo "直连 - input_tokens: $direct_input_tokens"

    echo ""
    echo "--- 获取代理响应 ---"
    local proxy_response=$(curl -s -X POST "$B_ENDPOINT" \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -H "X-Api-Key: $API_KEY" \
        -d "$data")

    local proxy_model=$(echo "$proxy_response" | jq -r '.model')
    local proxy_input_tokens=$(echo "$proxy_response" | jq -r '.usage.input_tokens')

    echo "代理 - model: $proxy_model"
    echo "代理 - input_tokens: $proxy_input_tokens"

    echo ""
    echo "--- 对比结果 ---"
    if [ "$direct_model" == "$proxy_model" ]; then
        log_info "model 字段一致"
    else
        log_error "model 字段不一致: 直连=$direct_model, 代理=$proxy_model"
    fi

    if [ "$direct_input_tokens" == "$proxy_input_tokens" ]; then
        log_info "input_tokens 一致"
    else
        log_error "input_tokens 不一致: 直连=$direct_input_tokens, 代理=$proxy_input_tokens"
    fi
}

# TC019: 响应格式对比
test_TC019() {
    log_info "=== TC019: 响应格式对比 ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "你好"}], "max_tokens": 512}'

    echo "--- 获取直连响应 ---"
    local direct_response=$(curl -s -X POST "$A_ENDPOINT" \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -H "X-Api-Key: $API_KEY" \
        -d "$data")

    echo "直连响应字段:"
    echo "$direct_response" | jq -r 'keys | .[]' | sort    echo "--- 获取

    echo ""
代理响应 ---"
    local proxy_response=$(curl -s -X POST "$B_ENDPOINT" \
        -H "Content-Type: application/json" \
anthropic-version:        -H " 2023-06-01" \
        -H "X-Api-Key: $API_KEY" \
        -d "$data")

    echo "代理响应字段:"
    echo "$proxy_response" | jq -r 'keys | .[]' | sort

    echo ""
    echo "--- 对比结果 ---"
    local direct_fields=$(echo "$direct_response" | jq -r 'keys | sort | join("\n")')
    local proxy_fields=$(echo "$proxy_response" | jq -r 'keys | sort | join("\n")')

    if [ "$direct_fields" == "$proxy_fields" ]; then
        log_info "响应字段完全一致"
    else
        log_error "响应字段不一致"
        echo "差异:"
        diff <(echo "$direct_fields") <(echo "$proxy_fields") || true
    fi
}

# TC020: 性能对比
test_TC020() {
    log_info "=== TC020: 性能对比 ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "你好"}], "max_tokens": 512}'
    local iterations=5

    log_info "进行 $iterations 次测试..."

    echo "--- 直连性能测试 ---"
    local direct_total=0
    for i in {1..5}; do
        local start_time=$(date +%s%N)
        curl -s -X POST "$A_ENDPOINT" \
            -H "Content-Type: application/json" \
            -H "anthropic-version: 2023-06-01" \
            -H "X-Api-Key: $API_KEY" \
            -d "$data" > /dev/null
        local end_time=$(date +%s%N)
        local duration=$(( (end_time - start_time) / 1000000 ))
        direct_total=$(( direct_total + duration ))
        echo "  第 $i 次: ${duration}ms"
    done
    local direct_avg=$(( direct_total / iterations ))
    echo "  平均: ${direct_avg}ms"

    echo ""
    echo "--- 代理性能测试 ---"
    local proxy_total=0
    for i in {1..5}; do
        local start_time=$(date +%s%N)
        curl -s -X POST "$B_ENDPOINT" \
            -H "Content-Type: application/json" \
            -H "anthropic-version: 2023-06-01" \
            -H "X-Api-Key: $API_KEY" \
            -d "$data" > /dev/null
        local end_time=$(date +%s%N)
        local duration=$(( (end_time - start_time) / 1000000 ))
        proxy_total=$(( proxy_total + duration ))
        echo "  第 $i 次: ${duration}ms"
    done
    local proxy_avg=$(( proxy_total / iterations ))
    echo "  平均: ${proxy_avg}ms"

    echo ""
    echo "--- 性能对比 ---"
    if [ $direct_avg -gt 0 ]; then
        local diff=$(( ((proxy_avg - direct_avg) * 100) / direct_avg ))
        if [ $diff -gt 0 ]; then
            log_info "代理比直连慢 ${diff}%"
        else
            diff=$(( -diff ))
            log_info "代理比直连快 ${diff}%"
        fi
    fi
}

# 打印帮助信息
print_help() {
    echo "用法: $0 [test_case_number]"
    echo ""
    echo "可用测试用例:"
    echo "  TC001-TC017  - 运行单个测试用例"
    echo "  TC018        - 基础功能对比 (自动化)"
    echo "  TC019        - 响应格式对比"
    echo "  TC020        - 性能对比"
    echo "  all          - 运行所有测试用例"
    echo "  help         - 显示此帮助信息"
    echo ""
    echo "示例:"
    echo "  $0                    # 运行所有测试"
    echo "  $0 TC001              # 只运行 TC001"
    echo "  $0 TC018 TC019 TC020  # 运行多个对比测试"
}

# 主函数
main() {
    if [ $# -eq 0 ]; then
        print_help
        exit 0
    fi

    case "$1" in
        help|--help|-h)
            print_help
            ;;
        all)
            test_TC001
            test_TC002
            test_TC003
            test_TC004
            test_TC005
            test_TC006
            test_TC007
            test_TC008
            test_TC009
            test_TC010
            test_TC011
            test_TC012
            test_TC013
            test_TC014
            test_TC015
            test_TC016
            test_TC017
            test_TC018
            test_TC019
            test_TC020
            ;;
        TC001) test_TC001 ;;
        TC002) test_TC002 ;;
        TC003) test_TC003 ;;
        TC004) test_TC004 ;;
        TC005) test_TC005 ;;
        TC006) test_TC006 ;;
        TC007) test_TC007 ;;
        TC008) test_TC008 ;;
        TC009) test_TC009 ;;
        TC010) test_TC010 ;;
        TC011) test_TC011 ;;
        TC012) test_TC012 ;;
        TC013) test_TC013 ;;
        TC014) test_TC014 ;;
        TC015) test_TC015 ;;
        TC016) test_TC016 ;;
        TC017) test_TC017 ;;
        TC018) test_TC018 ;;
        TC019) test_TC019 ;;
        TC020) test_TC020 ;;
        *)
            log_error "未知测试用例: $1"
            print_help
            exit 1
            ;;
    esac
}

main "$@"
