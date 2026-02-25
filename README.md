# Claude Proxy v3

A complete Claude API proxy that supports multiple AI model providers with unified Claude API format.

## ✨ Features

- **Unified Claude API Format**: All models respond in Claude API format
  - `GET /v1/models` - List available models
  - `POST /v1/messages` - Send messages (supports 49+ models)
  - `POST /v1/messages/count_tokens` - Count tokens in messages

- **Multiple Model Providers**: Support for 6+ providers:
  - DeepSeek (v3.1, v3.2, R1, etc.)
  - MiniMax (M2.1, M2.5, M1)
  - GLM/Z-AI (GLM-4.5, GLM-5, etc.)
  - Moonshot/Kimi (K2.5, K2-0905)
  - Qwen (Qwen3, Qwen-Max, Qwen-Turbo, Qwen-Coder)
  - Doubao (Seed-1.6-Thinking)

- **Extended Thinking Support**: Reasoning models with step-by-step explanations
  - DeepSeek R1 series (deepseek-r1, deepseek-r1-0528)
  - Doubao Thinking (doubao-seed-1.6-thinking)
  - Qwen Thinking variants (qwen3-*-thinking)
  - Natural reasoning without special parameters

- **Flexible Configuration**:
  - File-based config: `proxy_config.toml`
  - URL-based config: Eureka service discovery support
  - Model-specific routing
  - Native and OpenAI-compatible modes

- **Dynamic Routing**: Route requests to any OpenAI-compatible API
- **TypeScript First**: Full type safety with comprehensive type definitions
- **Cloudflare Workers Ready**: Optimized for edge deployment

## 🚀 Quick Start

### 1. Clone and Install

```bash
cd claude_proxy_v3
npm install
```

### 2. Configure

#### Basic Configuration (`wrangler.toml`):
```toml
[vars]
LOCAL_TOKEN_COUNTING = "false"
FIXED_ROUTE_TARGET_URL = "https://api.qnaigc.com"
PROXY_CONFIG_PATH = "./proxy_config.toml"
```

#### Model Configuration (`proxy_config.toml`):
```toml
[upstream]
default_url = "https://api.qnaigc.com"
default_api_key = "your-api-key"

[models.gemini-2-5-flash]
mode = "native"
base_url = "https://api.example.com"
api_key = "your-gemini-key"

[defaults]
mode = "openai-completions"
```

# Gemini API configuration
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com"
GEMINI_API_VERSION = "v1beta"
GEMINI_API_KEY = "your-gemini-api-key"

# Gemini routing modes (choose 'openai' or 'gemini' for each endpoint)
# 'openai' = convert to OpenAI format and route to OpenAI-compatible upstream
# 'gemini' = convert to Gemini format and route to Gemini API
GEMINI_INTERACTIONS_MODE = "gemini"           # /v1/interactions routing mode
GEMINI_GENERATE_CONTENT_MODE = "gemini"       # /v1beta/models/{model}:generateContent routing mode

# Fixed route configuration (for /v1/messages and OpenAI-compatible modes)
FIXED_ROUTE_TARGET_URL = "https://api.example.com"
FIXED_ROUTE_PATH_PREFIX = ""
```

### 3. Develop Locally

```bash
npm run dev
```

or
```bash
npm run build
PROXY_CONFIG_PATH=./proxy_config.toml npx tsx dist/server.js
```

### 4. Deploy

#### Docker
```bash
docker build -t claude-proxy-v3 .
docker run -p 8788:8788 -v $(pwd)/proxy_config.toml:/app/proxy_config.toml claude-proxy-v3
```

#### PM2 (High Performance)
```bash
npm run build
pm2 start dist/server.js -i 4
```

### 5. Test

```bash
# Test multiple models
bash tests/test_models.sh

# Test specific endpoint
curl http://localhost:8788/v1/messages \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "deepseek-v3.1",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100
  }'
```

### 6. Docs
- `docs/routing_refactor.md` - Routing architecture and implementation
- `docs/config_loader.md` - Configuration loading guide
- `docs/test_results_after_refactoring.md` - Comprehensive test results (22 models tested)

# Test Gemini API
node tests/test_gemini_native.js
node tests/test_gemini_openai_compatible.js
node tests/test_gemini_simple.js
```

### 6. Docs
Designing, Implementation, Reviewing, Testing docs are all generated with `Claude Code` + `DeepSeek-V3.2`, these md files are listed in `docs`.

- `docs/Refactor_gemini_interactions_to_openai_compatible.md`: Comprehensive architecture analysis and refactoring guide for Gemini API support
- `tests/README.md`: Gemini API testing guide covering both native and OpenAI-compatible modes

## 📚 API Reference

### Models API

**Endpoint**: `GET /v1/models`

List available models from the target API.

**Example URL**:
```
/GET /https/api.qnaigc.com/openai/v1/models/v1/models
/GET /https/api.qnaigc.com/v1/models
```

**Response**:
```json
{
  "data": [
    {
      "id": "deepseek-v3.1",
      "type": "model",
      "created_at": "2024-01-01T00:00:00Z",
      "display_name": "DeepSeek V3.1"
    }
  ],
  "first_id": "deepseek-v3.1",
  "has_more": false,
  "last_id": "deepseek-v3.1"
}
```

### Messages API

**Endpoint**: `POST /v1/messages`

Send messages with optional thinking configuration.

**Example URL**:
```
/POST /https/api.qnaigc.com/v1/messages
```

**Request with Thinking**:
```json
{
  "model": "deepseek-v3.1",
  "messages": [
    {
      "role": "user",
      "content": "What is the capital of France?"
    }
  ],
  "max_tokens": 1000,
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  }
}
```

**Response**:
```json
{
  "id": "msg_123456789",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "The capital of France is Paris."
    }
  ],
  "model": "deepseek-v3.1",
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 10,
    "output_tokens": 5
  }
}
```

### Token Counting API

**Endpoint**: `POST /v1/messages/count_tokens`

Count tokens in messages, including thinking configuration.

**Example URL**:
```
/POST /https/api.qnaigc.com/v1/messages/count_tokens
```

**Request**:
```json
{
  "model": "deepseek-v3.1",
  "messages": [
    {
      "role": "user",
      "content": "What is the capital of France?"
    }
  ],
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  }
}
```

**Response**:
```json
{
  "type": "token_count",
  "input_tokens": 10,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 0
}
```

## 🔧 Configuration

### Environment Variables

```toml
# wrangler.toml
[vars]
# OpenAI-compatible upstream
FIXED_ROUTE_TARGET_URL = "https://api.qnaigc.com"
FIXED_ROUTE_PATH_PREFIX = ""

# Config file path or URL
PROXY_CONFIG_PATH = "./proxy_config.toml"
# PROXY_CONFIG_URL = "http://eureka-server/config/proxy_config.toml"

# Optional settings
LOCAL_TOKEN_COUNTING = "false"
ALLOWED_HOSTS = "127.0.0.1,localhost,api.qnaigc.com"
LOG_LEVEL = "debug"
```

### Model Configuration

```toml
# proxy_config.toml
[upstream]
default_url = "https://api.qnaigc.com"
default_api_key = "sk-your-api-key"

[models.gemini-2-5-flash]
mode = "native"
base_url = "https://api.example.com"
api_key = "sk-gemini-key"

[models.deepseek-v3-1]
mode = "openai-completions"
# Uses default upstream

[defaults]
mode = "openai-completions"
```

### Configuration Loading

The proxy supports two config sources:

1. **Local File**: `PROXY_CONFIG_PATH=./proxy_config.toml`
2. **Remote URL**: `PROXY_CONFIG_URL=http://eureka-server/config/proxy_config.toml`

Config is loaded on startup and cached for performance.

### Authentication

Forward authentication headers from the original request:
- `Authorization: Bearer <token>`
- `x-api-key: <key>`

#### Gemini API Authentication
For Gemini API endpoints, authentication headers are automatically mapped:
- **OpenAI-Compatible Mode**: Uses `Authorization: Bearer <api-key>` header
- **Native Interactions Mode**: Uses `x-goog-api-key: <api-key>` header
- API keys can be provided via:
  - Request headers: `Authorization: Bearer <key>` or `x-api-key: <key>`
  - Environment variable: `GEMINI_API_KEY`
  - For native Gemini: `x-goog-api-key: <key>` header

## 🏗️ Architecture

### Project Structure

```
src/
├── index.ts                 # Main router and middleware
├── handlers/
│   ├── messages.ts         # Messages API handler
│   ├── models.ts           # Models API handler
│   ├── token-counting.ts   # Token counting handler
│   └── gemini.ts           # Gemini API handler (dual-mode)
├── converters/
│   ├── claude-to-openai.ts # Request conversion
│   ├── openai-to-claude.ts # Response conversion
│   ├── streaming.ts        # Streaming response conversion
│   ├── claude-to-gemini.ts # Claude to Gemini conversion
│   ├── gemini-to-claude.ts # Gemini to Claude conversion
│   └── gemini-streaming.ts # Gemini streaming transformer
├── utils/
│   ├── routing.ts          # Dynamic routing logic
│   ├── validation.ts       # Request validation
│   ├── errors.ts           # Error handling
│   └── thinking.ts         # Thinking utilities
└── types/
    ├── claude.ts           # Claude API types
    ├── openai.ts           # OpenAI API types
    ├── gemini.ts           # Gemini API types
    └── shared.ts           # Shared types
```

### Key Components

1. **Router Middleware**: Parses URLs, handles authentication, routes to handlers
2. **Converters**: Convert between Claude, OpenAI, and Gemini API formats
3. **Validation**: Comprehensive request validation with Claude API error formats
4. **Error Handling**: Claude API-compatible error responses
5. **Gemini Dual-Mode Handler**: Supports both native Interactions API and OpenAI-compatible endpoints with automatic format detection

## 🧪 Testing

### Type Checking

```bash
npm run typecheck
```

### Test Multiple Models

```bash
bash tests/test_models.sh
```

### Example Requests

```bash
# List models
curl http://localhost:8788/v1/models \
  -H "Authorization: Bearer your-api-key"

# Send message
curl http://localhost:8788/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "deepseek-v3.1",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100
  }'

# Test with different models
curl http://localhost:8788/v1/messages \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "qwen-max-2025-01-25",
    "messages": [{"role": "user", "content": "Capital of France?"}],
    "max_tokens": 50
  }'
```

### Test Results

See `docs/test_results_after_refactoring.md` for comprehensive test results:
- ✅ 26 models tested successfully
- ✅ 10+ question types validated (math, coding, translation, reasoning, etc.)
- ✅ 6 providers tested (DeepSeek, MiniMax, GLM, Moonshot, Qwen, Doubao)
- ✅ Extended thinking/reasoning models validated
- ✅ 100% success rate

### Reasoning Models Tested:
- deepseek-r1, deepseek-r1-0528 - Step-by-step mathematical reasoning
- doubao-seed-1.6-thinking - Detailed reasoning process
- deepseek/deepseek-v3.2-exp - Complex explanations
- moonshotai/kimi-k2.5 - Structured explanations
- minimax/minimax-m2.1 - Scientific reasoning
- z-ai/glm-5 - Multi-section explanations

## 📄 License

MIT

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## 🔗 Links

- [Claude API Documentation](https://docs.anthropic.com/claude/reference/)
- [OpenAI API Documentation](https://platform.openai.com/docs/api-reference)
- [Google Gemini API Documentation](https://ai.google.dev/gemini-api/docs)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Claude Proxy (v0)](https://github.com/tingxifa/claude_proxy) and a [fork(v0.1)](https://github.com/qidu/claude_proxy)
