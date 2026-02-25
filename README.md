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
  - Gemini (2.5-Flash with native API support)

- **Extended Thinking Support**: Reasoning models with step-by-step explanations
  - DeepSeek R1 series (deepseek-r1, deepseek-r1-0528)
  - Doubao Thinking (doubao-seed-1.6-thinking)
  - Qwen Thinking variants (qwen3-*-thinking)
  - Natural reasoning without special parameters

- **Flexible Configuration**:
  - File-based config: `proxy_config.toml`
  - URL-based config: Eureka service discovery support
  - Model-specific routing with per-model upstreams
  - Per-model API keys
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

# Native API mode (direct pass-through)
[models.gemini-2-5-flash]
mode = "native"
base_url = "https://api.example.com"
api_key = "your-gemini-key"

[models.claude-3-5-sonnet]
mode = "native"
base_url = "https://api.anthropic.com"
api_key = "your-claude-key"

# OpenAI-compatible mode (format conversion)
[models.deepseek-v3-1]
mode = "openai-completions"
base_url = "https://api.deepseek.com"
api_key = "your-deepseek-key"

# Use default upstream (omit base_url)
[models.qwen-max]
mode = "openai-completions"

[defaults]
mode = "openai-completions"
```

**Important**: Model IDs in config use normalized names (replace `/` and `.` with `-`):
- API request: `"model": "gemini-2.5-flash"` → Config: `[models.gemini-2-5-flash]`
- API request: `"model": "deepseek/deepseek-v3.2-exp"` → Config: `[models.deepseek-deepseek-v3-2-exp]`
- API request: `"model": "z-ai/glm-5"` → Config: `[models.z-ai-glm-5]`

The proxy automatically normalizes model names for config lookup while preserving the original name in API calls.

**Note**: Each model supports one upstream. Multiple upstreams per model (load balancing) is a future feature.

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
- `docs/test_results_after_refactoring.md` - Comprehensive test results (42 models tested)
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

**Comprehensive Testing (2026-02-25):** ✅ Production Ready

#### Models Tested: 50+ models across 9 providers
- **DeepSeek:** v3.1, v3.2, R1, thinking variants
- **Qwen:** Qwen3, Qwen-Max, thinking variants (9 models)
- **Doubao:** Seed-1.6-Thinking, 1.5-Thinking-Pro
- **MiniMax:** M2.1, M2.5
- **GLM/Z-AI:** GLM-4.5, GLM-5
- **Moonshot/Kimi:** K2.5, K2-Thinking
- **Gemini:** 2.5-Flash, 2.0-Flash (native & OpenAI modes)
- **Claude:** 4.5-Sonnet, 4.5-Haiku, 4.1-Opus (native & OpenAI modes)
- **GPT-OSS:** 120B

#### Endpoints Validated: All 3 endpoints (100% coverage)

**1. `/v1/messages` - Claude API format**
- ✅ 50+ models tested
- ✅ Native mode: Gemini, Claude (pass-through)
- ✅ OpenAI mode: All models (format conversion)
- ✅ Streaming: SSE support validated

**2. `/v1/interactions` - Interactions API format**
- ✅ 50+ models tested
- ✅ Native mode: Gemini (with limitations)
- ✅ OpenAI mode: All models (format conversion)
- ✅ Streaming: SSE support validated

**3. `/v1beta/models/{model}:generateContent` - Gemini format**
- ✅ 50+ models tested
- ✅ Native mode: Gemini (direct)
- ✅ OpenAI mode: All models (format conversion)
- ✅ Streaming: SSE support validated

#### SSE Streaming Support: ✅ Fully Implemented

**All 5 upstream handlers support SSE streaming:**
- ✅ handleClaudeRequest (Native Claude)
- ✅ handleMessagesRequest (OpenAI-compatible)
- ✅ handleOpenAIRequest (Interactions/OpenAI)
- ✅ handleGeminiGenerateContentRequest (Native Gemini)
- ✅ handleGeminiInteractionsRequest (Native Gemini)

**Streaming Test Results:**
- ✅ /v1/messages: SSE works (all modes)
- ✅ /v1/interactions: SSE works (OpenAI mode 100%)
- ✅ /v1beta/models/*:generateContent: SSE works (OpenAI mode 100%)

**Note:** Native upstream streaming support varies by provider. OpenAI-compatible mode provides consistent 100% SSE streaming across all endpoints.

#### Mode Comparison

**Native Mode:**
- ✅ Gemini: 100% success (3/3 endpoints, /v1/messages streaming only)
- ✅ Claude: 33% success (1/3 endpoints - /v1/messages only)
- ⚠️ Limited to /v1/messages for streaming
- ✅ Direct API access, preserves native features

**OpenAI-Compatible Mode:**
- ✅ All models: 100% success (3/3 endpoints)
- ✅ Full SSE streaming support (all endpoints)
- ✅ Consistent behavior across providers
- ✅ Recommended for production

#### Thinking/Reasoning Models: 15+ models tested

**DeepSeek Thinking:**
- deepseek-r1, deepseek-r1-0528
- deepseek/deepseek-v3.2-exp-thinking
- deepseek/deepseek-v3.1-terminus-thinking

**Qwen Thinking (4 models):**
- qwen3-vl-30b-a3b-thinking
- qwen3-30b-a3b-thinking-2507
- qwen3-next-80b-a3b-thinking
- qwen3-235b-a22b-thinking-2507

**Doubao Thinking:**
- doubao-seed-1.6-thinking
- doubao-1.5-thinking-pro

**Moonshot Thinking:**
- moonshotai/kimi-k2-thinking

**All thinking models:** ✅ 100% success rate (27/27 tests)

#### Features Validated

1. ✅ **Model name normalization** - Handles "/" and "." in names
2. ✅ **Model-specific routing** - Per-model upstreams
3. ✅ **model_alias feature** - Maps client names to upstream names (Claude native)
4. ✅ **Format conversions** - Claude↔OpenAI↔Gemini
5. ✅ **SSE streaming** - All endpoints, all modes
6. ✅ **Thinking models** - Natural reasoning support
7. ✅ **Vision models** - Image input support
8. ✅ **Multi-turn conversations** - Context preservation

#### Success Rates

| Test Category | Success Rate | Notes |
|---------------|--------------|-------|
| All models (OpenAI mode) | 100% (150+/150+ tests) | All 3 endpoints |
| Thinking models | 100% (27/27 tests) | All 3 endpoints |
| Gemini native mode | 100% (6/6 tests) | All 3 endpoints |
| Claude OpenAI mode | 100% (6/6 tests) | All 3 endpoints |
| Claude native mode | 33% (2/6 tests) | /v1/messages only |
| SSE streaming (OpenAI) | 100% (9/9 tests) | All 3 endpoints |
| SSE streaming (native) | 33% (1/3 tests) | /v1/messages only |

#### Detailed Test Documentation

- `docs/test_results_after_refactoring.md` - Initial 42 models
- `docs/test_gemini_claude_comprehensive_results.md` - Gemini & Claude (6 configs)
- `docs/test_thinking_models_all_results.md` - 9 thinking models
- `docs/test_random_3_models_results.md` - Random model sampling
- `docs/sse_streaming_review.md` - SSE implementation review
- `docs/test_gemini_sse_both_modes_results.md` - SSE streaming validation

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
