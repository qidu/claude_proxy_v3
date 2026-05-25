# Model Proxy v3

A complete Claude and Gemini API Proxy and also Reponses Endpoints that supports multiple AI models and providers with Claude and Gemini API format.

## ✨ Features

- **Unified API Format**:
  - `GET /v1/models` - List available models
  - `POST /v1/messages` - Process claude messages (supports 49+ models)
  - `POST /v1/responses` - OpenAI Responses API (passthrough or convert to chat completions)
  - `POST /v1/responses/input_tokens` - Count input tokens for a Responses API request
  - `POST /v1/responses/compact` - Compact a conversation (returns `response.compaction` object)
  - `POST /v1/interactions` -  Process gemini interactions messages
  - `POST /v1beta/models/{model}:generateContent` - Process gemini content messages
  - `POST /v1beta/models/{model}:streamGenerateContent` - Process gemini content messages with SSE
  - `POST /v1/models/{model}:generateContent` - Alternative Gemini v1 endpoint (added 2026-03-03)
  - `POST /v1/models/{model}:streamGenerateContent` - Alternative Gemini v1 endpoint with SSE (added 2026-03-03)
  - `POST /v1/messages/count_tokens` - Count tokens in messages
  - `POST /v1/embeddings` - Generate embeddings (proxied to upstream OpenAI-compatible API)
  - `GET /dashboard` - Web dashboard for config and runtime statistics
  - `GET /dashboard/api/config` - Read sanitized editable config (`models.*`, `composite`; hides `api_key`)
  - `PUT /dashboard/api/config` - Save dashboard config edits (file mode only; read-only when `PROXY_CONFIG_URL` is set)
  - `GET /dashboard/api/stats/models` - Model request + token stats
  - Dashboard "Export CSV" button reads table data from the DOM and triggers a download; it does **not** change the in-memory stats data.
  - `GET /dashboard/api/stats/agents` - User-agent prefix + tool stats
  - `GET /dashboard/api/stats/requests` - Request/response stats by endpoint, upstream, and status code

- **Multiple Model Providers**: Support for 6+ providers:
  - DeepSeek (v3.1, v3.2, R1, etc.)
  - MiniMax (M2.1, M2.5, M1)
  - GLM/Z-AI (GLM-4.5, GLM-5, etc.)
  - Moonshot/Kimi (K2.5, K2-0905)
  - Qwen (Qwen3, Qwen-Max, Qwen-Turbo, Qwen-Coder)
  - Doubao (Seed-1.6-Thinking)
  - Gemini (2.5-Flash with native API support)

- **Extended Thinking Support**: Full Claude-style thinking with signature verification
  - **Model Support**: DeepSeek R1 series, Doubao Thinking, Qwen Thinking variants, Gemini reasoning models
  - **Thinking Modes**: Supports `enabled` (manual) and `adaptive` (Claude 4.6+) thinking types
  - **Boolean Support**: Accepts boolean values (`true`/`false`) in addition to string values (`"enabled"`/`"disabled"`)
  - **Flexible Request Fields**: `/v1/messages` accepts `thinking: { type: "enabled" }` with or without `budget_tokens`, plus `reasoning_effort: "low" | "medium" | "high" | "max"` and `output_config.effort` (including non-standard `xhigh` normalization), and `output_config.task_budget.total` can supply the thinking budget when `budget_tokens` is omitted (request-supplied effort takes priority over budget-based thresholds)
  - **OpenAI Upstream Passthrough**: For `openai-completions` upstreams, the proxy derives `reasoning_effort` from `thinking.budget_tokens` and strips the `thinking` field (OpenAI chat completions schema does not support it)
  - **Signature Verification**: Full signature_delta streaming events for thinking block verification
  - **Streaming Support**: Proper thinking_delta and signature_delta events in SSE streams
  - **Token Counting**: Accurate token counting for thinking content with budget validation

- **Flexible Configuration**:
  - File-based config: `proxy_config.toml`
  - URL-based config: Eureka service discovery support
  - Model-specific routing with per-model upstreams
  - Composite model routing with weighted, primary/fallback, or default ordering
  - Per-model API keys
  - Native and OpenAI-compatible modes

- **Model-based Routing**: Route requests based on model name via `proxy_config.toml` categories
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
PROXY_CONFIG_PATH = "./proxy_config.toml"
```

#### Model Configuration (`proxy_config.toml`):
```toml
[upstream]
upstream_mode = "openai-completions"
default_base_url = "https://api.qnaigc.com"
default_api_key = "your-api-key"

# Gemini models with native API
[models.gemini]
upstream_mode = "gemini-generatecontent"
base_url = "https://api.example.com"
api_key = "your-gemini-key"
"gemini-3.1-pro-preview" = ["", "", ""]  # Inherits all from category
"gemini-3.0-flash-preview" = ["gemini-3-flash-preview", "", ""]  # Override alias

# Claude models with native API
[models.claude]
upstream_mode = "anthropic-messages"
base_url = "https://api.anthropic.com"
api_key = "your-claude-key"
"claude-4.6-sonnet" = ["claude-opus-4-1-20250805-thinking", "", ""]  # Model alias

# OpenAI-compatible models (default category)
[models.default]
upstream_mode = "openai-completions"
# Inherits base_url and api_key from [upstream]
"deepseek/deepseek-v3.2" = ["", "", ""]
"gpt-oss-120b" = ["", "", ""]
```

**Configuration Structure**:
- **Category-based**: Group models by provider (`[models.gemini]`, `[models.claude]`, `[models.default]`)
- **Array format**: `["model-alias", "base-url", "api-key"]` - empty strings inherit from category
- **upstream_mode**: Explicit mode per category (`anthropic-messages`, `gemini-generatecontent`, `openai-completions`)
- **Model names**: Preserve original names (no normalization) - `"deepseek/deepseek-v3.2"`, `"gemini-2.5-flash"`
- **Inheritance chain**: Model array → Category defaults → [upstream] defaults

**Note**: Each model supports one upstream. Composite aliases can route across multiple configured models, but each individual model still maps to a single upstream.

#### Composite aliases

```toml
[composite]
"gpt-all" = {"gpt-5.4-mini": {"share": 50}, "gpt-5-mini": {"share": 20}, "nvidia/nemotron-3-super-120b-a12b-free": {}}
"gpt-5" = {"gpt-5.4-mini": {"fallback": 1}, "gpt-5-mini": {"primary": true}, "nvidia/nemotron-3-super-120b-a12b-free": {"fallback": 2}}
"llama" = {"llama3": {}, "g5-mini": {}}
```

Composite behavior:
- `primary: true`: always try this target first, then fail over to others.
- `fallback: N`: lower number means higher retry priority when primary is absent.
- `share`: weighted random selection for first attempt when no `primary`/`fallback` is configured.
- no `share`/`primary`/`fallback`: equal random first-attempt distribution across targets.
- if one upstream fails, proxy retries the next configured candidate automatically.

#### Consul-backed config

`PROXY_CONFIG_URL` can point to a Consul server address, and the proxy will read the KV prefix `model-proxy-v3/`.

**Notice**: `wrangler.toml` vars are loaded by Wrangler/Cloudflare at runtime. The Node server (`npm run server` / `dist/server.js`) uses process environment variables instead.

Example:

```toml
# wrangler.toml
PROXY_CONFIG_URL = "http://localhost:8500"
```

Put config into Consul KV using the `model-proxy-v3/` prefix:

```bash
consul kv put model-proxy-v3/upstream/default_base_url "https://api.qnaigc.com"
consul kv put model-proxy-v3/upstream/budget_to_effort_low "8000"
consul kv put model-proxy-v3/upstream/budget_to_effort_medium "20000"
consul kv put model-proxy-v3/upstream/budget_to_effort_high "0"

consul kv put model-proxy-v3/models/claude/upstream_mode "anthropic-messages"
consul kv put model-proxy-v3/models/claude/base_url "http://localhost:4000"
consul kv put model-proxy-v3/models/claude/api_key "sk-..."
consul kv put model-proxy-v3/models/claude/claude-opus-4-6 '["claude-opus-4-6", "", ""]'

consul kv put model-proxy-v3/models/free/upstream_mode "openai-completions"
consul kv put model-proxy-v3/models/free/base_url "http://localhost:4000"
consul kv put model-proxy-v3/models/free/api_key "sk-hello"
consul kv put model-proxy-v3/models/free/gpt-5.4-mini '["gpt-5.4-mini", "", ""]'
```

List the keys under a prefix with:

```bash
consul kv get -recurse -keys model-proxy-v3/models/free/
```

List all values of all keys:
```
for KEY in $(consul kv get -recurse -keys model-proxy-v3); do consul kv get $KEY; done
```

Watch if a key changed:
```
consul watch -type=key -key=model-proxy-v3/models/free/api_key
```

After updating Consul KV, trigger a reload:

```bash
curl http://localhost:8788/reload
```

On success, the proxy also dumps the reloaded config to `./config-dumps/` as a timestamped TOML file.

### 3. Develop Locally

```bash
npm run dev
```

or
```bash
git submodule update --init --recursive
git submodule update --remote --merge
npm run build-chatjimmy

npm run build
PROXY_CONFIG_PATH=./proxy_config.toml npx tsx dist/server.js
```

### 4. Deploy

#### Docker
```bash
docker build -t model-proxy-v3 .
docker run -p 8788:8788 -v $(pwd)/proxy_config.toml:/app/proxy_config.toml model-proxy-v3
```

#### PM2 (High Performance)
```bash
npm run build
pm2 start dist/server.js -i 4
```

### 5. Test

```bash
# Test specific provider
./tests/test_claude.sh
./tests/test_gemini.sh
./tests/test_deepseek.sh

# Test specific feature
./tests/test_thinking.sh
./tests/test_streaming.sh

# Test all available models
./tests/test_all.sh
```

**Test Configuration**: All tests use `proxy_config.toml` with category-based structure. See `docs/test_guideline.md` for details.

### Test Scripts

#### SSE Streaming Tests

**`test_sse_streaming_comprehensive.sh`** - Full SSE streaming test suite
- Tests 10 models across 4 endpoints:
  - `/v1/messages` (x-api-key header)
  - `/v1/chat/completions` (blocked - not allowed)
  - `/v1beta/models/{model}:streamGenerateContent` (x-goog-api-key header)
  - `/v1/interactions` (x-goog-api-key header)
- Validates SSE event detection and streaming response format
- Usage: `bash tests/test_sse_streaming_comprehensive.sh`

**`test_sse_streaming_gemini_only.sh`** - Gemini CLI streaming test
- Tests 9 models via Gemini CLI with streaming
- Models: qwen3-32b, qwen-max, minimax-m2.1/m2.5, moonshotai/kimi-k2.5, deepseek-v3.2, gemini-2.5-flash, claude-4.5-sonnet, z-ai/glm-4.7
- Usage: `bash tests/test_sse_streaming_gemini_only.sh`

### 6. Docs
- `docs/routing_refactor.md` - Routing architecture and implementation
- `docs/routing_config_revision.md` - Latest config structure revision (2026-02-27)
- `docs/config_loader.md` - Configuration loading guide
- `docs/test_results_after_refactoring.md` - Comprehensive test results (42 models tested)
- `docs/test_guideline.md` - Testing guide and configuration reference
- `docs/CONSOLIDATION.md` - Consolidated test scripts documentation

## 📚 API Reference

## API Specifications
this proxy implements claude and gemini API formats for multiple models:
- **Claude Messages API**: See `docs/claude_api_docs/messages-api.md`
- **OpenAI Responses API**: See `docs/openai-response.md` (passthrough or convert to chat completions)
- **Gemini Interactions API**: See `docs/interactions.md`
- **Gemini GenerateContent API**: See `docs/vertex-ai-gemini-api.md`
- **OpenAI Chat Completions**: Standard `/v1/chat/completions` format not for endpoints, just for upstream to Compatible API

For detailed routing behavior, see `docs/routing_refactor.md`.

### Models API

**Endpoint**: `GET /v1/models`

List available models from the target API.

**Example URL**:
```
GET /v1/models
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
POST /v1/messages
```

**Request with Thinking (String Format)**:
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

**Request with Thinking (Boolean Format - New)**:
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
    "type": true,
    "budget_tokens": 10000
  }
}
```

**Request with Thinking Disabled (Boolean Format)**:
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
    "type": false
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

---

## 🧠 Thinking and Reasoning

The proxy provides full Claude-style extended thinking support, bridging thinking/reasoning across Claude, OpenAI, and Gemini upstream modes. All upstream thinking formats are normalized to Claude's `thinking_delta` / `signature_delta` streaming events.

### Supported Thinking Modes

| Mode | Config | Supported Models | Behavior |
|:-----|:-------|:-----------------|:---------|
| **Manual** | `thinking: { type: "enabled", budget_tokens: N }` | All models with thinking support | Fixed token budget for reasoning |
| **Adaptive** | `thinking: { type: "adaptive" }` | Claude Opus 4.6, Sonnet 4.6 | Claude decides when/how much to think |
| **Disabled** | Omit `thinking` or set `type: "disabled"` / `false` | All models | Standard response, no thinking |
| **Boolean** | `thinking: { type: true, budget_tokens: N }` | All models | Shorthand for `"enabled"` |

### Effort Parameter

Claude-style `output_config.effort` and `reasoning_effort` are accepted on `/v1/messages`:

- `"low"` — minimize thinking (fastest)
- `"medium"` — moderate thinking depth
- `"high"` — always think deeply (default for adaptive)
- `"max"` — no constraints on thinking depth (Opus 4.6 only)
- `"xhigh"` — normalized to `"max"` (non-standard input support)

When both `reasoning_effort` and budget thresholds are present, effort takes priority.

### Provider-Specific Handling

**Claude Native (`anthropic-messages`)** — Passthrough:
- `thinking: { type: "enabled" | "adaptive", budget_tokens }` forwarded as-is
- `output_config.effort`, `reasoning_effort` forwarded as-is
- `thinking_delta` / `signature_delta` events passthrough in streaming

**OpenAI-Compatible (`openai-completions`)** — Thinking to reasoning mapping:
- `thinking` field is **stripped** (not in OpenAI chat completions schema)
- `budget_tokens` → `reasoning_effort` via budget thresholds or defaults
- Default mapping: ≥4096 → `"high"`, ≥2048 → `"medium"`, else `"low"`
- Explicit thresholds via `[upstream].budget_to_effort_*` override defaults
- Upstream response: `<thinking>` markers, `reasoning_content`, or `delta.thinking` parts are extracted and converted to Claude `thinking_delta` events
- `reasoning_item_id` / `delta.signature` → `signature_delta` events

**Gemini (`gemini-generatecontent` / `gemini-interactions`)**:
- Claude `thinking` → Gemini `thinking_level: "medium"` + `max_output_tokens` budget
- Gemini response `thought` blocks → Claude `thinking` content blocks with signature

**SDK Handler (`sdk://`)**:
- Same `thinking` → `reasoning_effort` mapping as `openai-completions`
- Handles both Claude-format and OpenAI-format `thinking` objects

### Thinking Configuration Request Formats

The proxy accepts both Claude and OpenAI format on the `/v1/messages` endpoint:

**Claude Format**:
```json
{
  "thinking": { "type": "enabled", "budget_tokens": 10000 }
}
```

**OpenAI Format** (passthrough before conversion):
```json
{
  "thinking": { "enabled": true, "budget_tokens": 10000 }
}
```

**Adaptive Format**:
```json
{
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "medium" }
}
```

### Streaming Events

For SSE streaming, the proxy normalizes all upstream formats to Claude's streaming events:

| Event | Description | Source |
|:------|:------------|:-------|
| `content_block_start` / `type: "thinking"` | Thinking block begins | All upstreams |
| `thinking_delta` | Incremental thinking tokens | `<thinking>` markers, `reasoning_content`, `delta.thinking` parts |
| `signature_delta` | Thinking signature for verification | `delta.signature`, `reasoning_item_id`, `signature` metadata |
| `content_block_stop` | Thinking block ends | All upstreams |

### Signature Verification

Thinking signatures are accumulated across multiple sources and emitted as `signature_delta` before `content_block_stop`:

- **Non-streaming**: Signature embedded in thinking block metadata
- **Streaming**: `signature_delta` event before `content_block_stop`
- **Sources**: `delta.signature`, `reasoning_item_id`, `response.signature`

### Known Limitations

1. Some upstreams (e.g., DeepSeek's Anthropic-compatible API) internally default models to thinking mode regardless of the request's `thinking` parameter. The proxy handles this by stripping `thinking` config when no prior assistant thinking blocks exist in the conversation.

2. For `openai-completions` upstreams, Gemini `thought` content is dropped during conversion.

3. `thinking: { type: "disabled" }` is stripped entirely for all upstreams.

4. When `openai-completions` upstream returns thinking in the response, the conversion is lossless for streaming (real-time `thinking_delta`), but depends on `<thinking>` markers or `reasoning_content` for non-streaming responses.

### `reasoning: true` Compatibility Notes (qnaigc / deepseek)

Test observations for model config using `"reasoning": true`:

- ✅ Proxy → qnaigc: **ok**
- ✅ Proxy → deepseek/anthropic-compatible endpoint: **ok**
- ❌ Direct deepseek/openai-compatible: **failed**

### Supported Models

- **DeepSeek**: R1, R1-0528, V3.2-exp-thinking, V3.1-terminus-thinking
- **Qwen**: Thinking variants (vl-30b, 30b-2507, next-80b, 235b-2507)
- **Doubao**: seed-1.6-thinking, 1.5-thinking-pro
- **Moonshot/Kimi**: kimi-k2-thinking
- **Gemini**: 2.5-pro-preview, 3.1-pro-preview (includes reasoning_content)
- **Claude**: All 4.x models (Opus, Sonnet, Haiku)

### thinking to reasoning_effort Conversion (for openai-completions)

When forwarding requests to `openai-completions` upstreams, the proxy converts Claude-style `thinking` to OpenAI `reasoning_effort` in all code paths (direct passthrough, claude→openai converter, and SDK handler) because the OpenAI `/v1/chat/completions` schema does not support a `thinking` field.

**Default mapping** (no explicit thresholds):
```
budget_tokens >= 4096 → "high"
budget_tokens >= 2048 → "medium"
< 2048               → "low"
```

**Optional explicit thresholds** (`proxy_config.toml`):
```toml
[upstream]
budget_to_effort_low = 8000       # < 8000 tokens → "low"
budget_to_effort_medium = 20000   # < 20000 tokens → "medium"
budget_to_effort_high = 0         # >= threshold or 0 = always "high"
```

**Behavior**:
- `thinking: { enabled: true, budget_tokens: N }` or Claude `thinking: { type: "enabled", budget_tokens: N }` → `reasoning_effort` derived from budget, `thinking` stripped
- `thinking: { enabled: false }` or `thinking: { type: "disabled" }` → stripped entirely, no `reasoning_effort`
- No `thinking` in request → nothing changed
- If `reasoning_effort` is already set by the request → budget mapping skipped, `thinking` stripped, existing effort preserved

### Responses API

**Endpoint**: `POST /v1/responses`

OpenAI Responses API support with format conversion to/from Chat Completions.

**Request Example**:
```json
{
  "model": "gpt-4o",
  "input": "What is the capital of France?",
  "background": false
}
```

**Response Example**:
```json
{
  "id": "resp_chatcmpl-abc123",
  "object": "response",
  "created": 1773286630,
  "status": "completed",
  "model": "gpt-4o",
  "output_items": [
    {
      "id": "msg_123",
      "type": "message",
      "status": "completed",
      "content": [{"type": "output_text", "text": "The capital of France is Paris."}]
    }
  ],
  "usage": {
    "input_tokens": 14,
    "output_tokens": 8,
    "total_tokens": 22
  }
}
```

**How It Works**:
- When `upstream_mode = "openai-completions"` (default): Converts Responses API request → Chat Completions → sends to upstream → converts response back to Responses API format
- When `upstream_mode = "openai-responses"`: Passes through directly to OpenAI Responses API upstream

**Key Differences from Chat Completions**:
- Uses `input` instead of `messages`
- Response contains `output_items` array instead of `choices`
- Uses `status: "completed"` instead of `finish_reason`
- Does NOT support streaming (use `background: true` for async processing)

**Known Limitations** (`openai-completions` conversion mode):

1. **Image inputs dropped**: `input_image` content parts are converted to a `[Image input]` string placeholder rather than forwarded as multipart `image_url` content to the upstream Chat Completions API (`responses-to-completions.ts`).

2. **Reasoning content discarded**: When the upstream returns a `thinking` content block, a `reasoning` output item is emitted in the response but without any content — the reasoning text is silently lost (`completions-to-responses.ts`).

3. **`developer` role may cause upstream errors**: The `developer` role is passed through as-is; most OpenAI-compatible upstreams do not support it and will return a validation error (`responses-to-completions.ts`).

4. **Stateful conversation not supported (`previous_response_id`, `conversation`, `store`)**: The proxy is stateless by design — it does not store or cache responses between requests, and it will not implement a conversation store. `previous_response_id` is silently dropped; the upstream receives only the current `input` with no prior history. The result is a context-free response that ignores all previous turns. This applies to both `openai-completions` and `openai-responses` modes (in the latter, the field is forwarded to the upstream, but non-OpenAI upstreams such as LiteLLM also have no conversation store and will silently ignore it).

Notice: set `CONVERSATION=true` in environment to enable stateful conversation experimental feature, it just cache conversion inner a proxy process instance.

   **Required client-side fix**: set `store: false` and pass the full conversation history in `input` on every request. This is the correct stateless usage pattern per the Responses API spec:
   ```json
   {
     "model": "gpt-4o",
     "store": false,
     "input": [
       {"type": "message", "role": "user",      "content": "What is the capital of France?"},
       {"type": "message", "role": "assistant",  "content": [{"type": "output_text", "text": "Paris."}]},
       {"type": "message", "role": "user",       "content": "And Germany?"}
     ]
   }
   ```
   Tool call turns use `function_call` / `function_call_output` items in the same array. See the [OpenAI Responses API docs](https://platform.openai.com/docs/api-reference/responses) for the full item schema.

   Other silently dropped fields: `background`, `context_management`.

5. **Streaming tool call name latency**: In SSE mode, the `response.output_item.added` event for a function call may emit an empty `name` field if the tool name arrives in a later chunk from the upstream (`handlers/responses.ts`).

**Configuration**:
```toml
[models.default]
upstream_mode = "openai-completions"  # Default: converts to chat completions
# upstream_mode = "openai-responses"   # Alternative: pass through to Responses API
```

**Test Results**: 5/6 models pass (83.3%) - see `tests/test_responses_both_sse_and_none.sh`

### Token Counting API

**Endpoint**: `POST /v1/messages/count_tokens`

Count tokens in messages, including thinking configuration.

**Example URL**:
```
POST /v1/messages/count_tokens
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
    "type": "enabled",  // or "type": true
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

### Embeddings API

**Endpoint**: `POST /v1/embeddings`

Generate vector embeddings for text input. Proxied to the upstream OpenAI-compatible API (`{defaultBaseUrl}/v1/embeddings`). The `provider` field is stripped from the upstream response.

**Example Request**:
```bash
curl http://localhost:8788/v1/embeddings \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen/qwen3-embedding-4b",
    "input": "Your text string goes here",
    "encoding_format": "float"
  }'
```

The `input` field also supports batch processing with arrays:
```json
{
  "model": "qwen/qwen3-embedding-4b",
  "input": ["text1", "text2", "text3"]
}
```

**Response**:
```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "embedding": [0.000136, 0.001807, ...],
      "index": 0
    }
  ],
  "model": "Qwen/Qwen3-Embedding-4B",
  "usage": {
    "prompt_tokens": 6,
    "total_tokens": 6
  }
}
```

**Configuration**:
```toml
[models.embedding]
upstream_mode = "anthropic-messages"
#base_url = "https://api.qnaigc.com"
#base_url = "https://openrouter.ai/api"
#api_key = "sk-..."
```

The embedding endpoint checks `[models.embedding]` in the proxy config first. If `base_url` and `api_key` are configured there, they take priority over defaults. Falls back to `[models.default]` / `[upstream]` when not set in `[models.embedding]`.

See `docs/test_embeding.md` for more details.

### Dashboard API

The proxy includes a built-in web dashboard for config editing and runtime stats.

**Page**:
- `GET /dashboard`

**Config APIs**:
- `GET /dashboard/api/config`
  - Returns sanitized config for dashboard editing (`models.*`, `composite`)
  - `api_key` values are never returned
  - Includes `read_only: true` when `PROXY_CONFIG_URL` is configured
- `PUT /dashboard/api/config`
  - Applies dashboard edits to local `proxy_config.toml`
  - Available only when using file config mode
  - Read-only/disabled when `PROXY_CONFIG_URL` is configured

**Stats APIs**:
- `GET /dashboard/api/stats/models`
  - Requests, input tokens, output tokens by model (DESC)
- `GET /dashboard/api/stats/agents`
  - Requests by `user-agent-prefix / tool-name`
- `GET /dashboard/api/stats/requests`
  - Requests by endpoint
  - Responses by upstream base URL
  - Response status codes split into:
    - from upstreams
    - to endpoints

### Token Stats (Normalized Mapping)

Dashboard/API token stats can be normalized to a single shape:

- `input_tokens`
- `cached_tokens`
- `cache_written_tokens`
- `output_tokens`
- `total_tokens`

| Endpoint family | input_tokens | cached_tokens | cache_writen_tokens | output_tokens | total_tokens |
|---|---:|---:|---:|---:|---:|
| Claude `/v1/messages` | `usage.input_tokens` | `usage.cache_read_input_tokens` | `usage.cache_creation_input_tokens` | `usage.output_tokens` | `input + cached + cache_writen + output` |
| OpenAI `/v1/chat/completions` | `usage.prompt_tokens` | `0` | `0` | `usage.completion_tokens` | `usage.total_tokens` |
| OpenAI `/v1/responses` | `usage.input_tokens` | `usage.input_tokens_details.cached_tokens` | `0` | `usage.output_tokens` | `usage.total_tokens` |
| Gemini `generateContent` | `usageMetadata.promptTokenCount` | `0` | `0` | `usageMetadata.candidatesTokenCount` *(or `responseTokenCount` in SSE)* | `usageMetadata.totalTokenCount` |
| Gemini `/v1/interactions` | `usage.total_input_tokens` | sum of `usage.cached_tokens_by_modality[*].token_count` *(if present)* | `0` | `usage.total_output_tokens` | `input_tokens + output_tokens` |
| Embeddings `/v1/embeddings` | `usage.prompt_tokens` | `0` | `0` | `0` | `usage.total_tokens` |
| Count-tokens endpoints (`/v1/messages/count_tokens`, `:countTokens`) | endpoint-specific input count | `0` | `0` | `0` | same as input |

Fallback rules:
- Missing fields are treated as `0`.
- Prefer provider-returned `total_tokens`; otherwise derive from normalized fields.

## 🔧 Configuration

### Environment Variables

Vars defined in `wrangler.toml` `[vars]` are automatically injected by Cloudflare Workers at runtime. When running via the Node.js server (`npm run server` / `dist/server.js`), you must set them via `process.env` — `wrangler.toml` is **not** read by `server.ts`.

For local Node.js runs, either pass inline:
```bash
VERSION=my-version LOG_LEVEL=debug node dist/server.js
```
or export them:
```bash
export VERSION="my-version"
export LOG_LEVEL="debug"
node dist/server.js
```

```toml
# wrangler.toml
[vars]
# OpenAI-compatible upstream

# Config file path or URL
PROXY_CONFIG_PATH = "./proxy_config.toml"
# PROXY_CONFIG_URL = "http://eureka-server/config/proxy_config.toml"

# Optional settings
LOCAL_TOKEN_COUNTING = "false"
ALLOWED_HOSTS = "127.0.0.1,localhost,api.qnaigc.com"
LOG_LEVEL = "debug"

# Default max_tokens for requests that don't include it (anthropic-messages mode)
# Some upstreams (e.g. DeepSeek) require max_tokens in every request
# DEFAULT_MAX_TOKENS = "8192"
```

### Model Configuration

#### Minimal Configuration (Unconfigured Models)

For models without specific configuration, use this minimal setup:

```toml
# proxy_config.toml
[upstream]
default_base_url = "https://api.qnaigc.com"
default_api_key = "sk-..."
upstream_mode = "openai-completions"

[models.default]
upstream_mode = "openai-completions"
```

All unconfigured models will automatically use these defaults. No need to list every model explicitly.

#### Full Configuration Example

```toml
# proxy_config.toml
[upstream]
upstream_mode = "openai-completions"
default_base_url = "https://api.qnaigc.com"
default_api_key = "sk-your-api-key"

[models.gemini]
upstream_mode = "gemini-generatecontent"
base_url = "https://api.example.com"
api_key = "sk-gemini-key"
"gemini-2.5-flash" = ["", "", ""]

[models.claude]
upstream_mode = "anthropic-messages"
base_url = "https://api.anthropic.com"
api_key = "sk-claude-key"
"claude-4.6-sonnet" = ["claude-opus-4-1-20250805-thinking", "", ""]

[models.default]
upstream_mode = "openai-completions"
"deepseek/deepseek-v3.2" = ["", "", ""]
```

**Configuration Structure**:
- **Category-based**: Group models by provider (`[models.gemini]`, `[models.claude]`, `[models.default]`)
- **Array format**: `["model-alias", "base-url", "api-key"]` - empty strings inherit from category
- **upstream_mode**: Explicit mode per category (`anthropic-messages`, `gemini-generatecontent`, `gemini-interactions`, `openai-completions`)
- **Model names**: Preserve original names (no normalization) - `"deepseek/deepseek-v3.2"`, `"gemini-2.5-flash"`
- **Inheritance chain**: Model array → Category defaults → [upstream] defaults

**Note**: Each model supports one upstream. Composite aliases can route across multiple configured models, but each individual model still maps to a single upstream.

#### Composite aliases

```toml
[composite]
##### refer to previous 'Composite aliases' examples
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
- `x-goog-api-key: <key>` (for Gemini endpoints)

#### API Key Priority (Enhanced 2026-03-03)

The proxy now intelligently prioritizes API keys based on upstream mode:

1. **For `openai-completions` upstream mode**:
   - Configuration API keys take priority over client-provided headers
   - This ensures compatibility with OpenAI-compatible APIs when clients send Gemini/Claude API keys
   - Uses `Authorization: Bearer <api-key>` header format

2. **For other upstream modes** (`anthropic-messages`, `gemini-generatecontent`, `gemini-interactions`):
   - Configuration API keys override request headers when available
   - Falls back to client-provided headers when no config API key is set

#### Gemini API Authentication
For Gemini API endpoints, authentication headers are automatically mapped:
- **OpenAI-Compatible Mode**: Uses `Authorization: Bearer <api-key>` header
- **Native Interactions Mode**: Uses `x-goog-api-key: <api-key>` header
- **Native GenerateContent Mode**: Uses `x-goog-api-key: <api-key>` header
- API keys can be provided via:
  - Request headers: `Authorization: Bearer <key>`, `x-api-key: <key>`, or `x-goog-api-key: <key>`
  - Configuration file: `api_key` in model or category config
  - Environment variable: `GEMINI_API_KEY` (for Gemini CLI compatibility)

#### Client IP Forwarding
The proxy forwards the client's real IP to upstream APIs via the `x-forwarded-for` header. Supports:
- **Cloudflare Workers**: Uses `cf-connecting-ip` header
- **Standard Proxies**: Uses `x-forwarded-for` header (takes first IP if multiple)
- **Nginx**: Uses `x-real-ip` header

## 🏗️ Architecture

### Project Structure

```
src/
├── index.ts                 # Main router and middleware
├── handlers/
│   ├── claude.ts           # Claude native API handler (anthropic-messages passthrough)
│   ├── messages.ts         # Messages API handler (openai-completions conversion)
│   ├── responses.ts        # Responses API handler
│   ├── models.ts           # Models API handler
│   ├── token-counting.ts   # Token counting handler
│   ├── openai.ts           # OpenAI completions handler
│   ├── gemini.ts           # Gemini API handler (dual-mode)
│   └── embeddings.ts       # Embeddings API handler
├── converters/
│   ├── claude-to-openai.ts # Request conversion
│   ├── openai-to-claude.ts # Response conversion
│   ├── streaming.ts        # Streaming response conversion
│   ├── claude-to-gemini.ts # Claude to Gemini conversion
│   ├── gemini-to-claude.ts # Gemini to Claude conversion
│   ├── gemini-streaming.ts # Gemini streaming transformer
│   └── responses-to-completions.ts # Responses API to Chat Completions
├── utils/
│   ├── routing.ts          # Auth header handling and URL building
│   ├── validation.ts       # Request validation
│   ├── errors.ts           # Error handling
│   ├── thinking.ts         # Thinking utilities
│   ├── config-loader.ts    # Proxy config TOML loader
│   ├── fetch-timeout.ts    # Upstream request timeout
│   ├── logger.ts           # Logging utilities
│   ├── sdk-handler.ts      # SDK-based request handling
│   ├── token-counting.ts   # Token counting utilities
│   └── beta-features.ts    # Beta feature validation
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

**Latest Revision (2026-03-03):** ✅ Enhanced Thinking Config & API Key Priority

**Key Enhancements:**

1. **Boolean Thinking Config Support**: Thinking configuration now accepts boolean values (`true`/`false`) in addition to string values (`"enabled"`/`"disabled"`), providing more intuitive API usage.

2. **Gemini `/v1/models/` Endpoint Support**: Added support for Gemini `/v1/models/{model}:generateContent` endpoints (in addition to existing `/v1beta/models/` support).

3. **API Key Priority for OpenAI-Compatible Upstream**: For `openai-completions` upstream mode, the proxy now prioritizes API keys from configuration over client-provided headers, ensuring compatibility with OpenAI-compatible APIs.

4. **Enhanced Auth Header Handling**: Added `formatApiKeyForUpstream()` utility for consistent API key formatting across different upstream modes.

**Thinking Config Examples:**
```json
// String format (existing)
"thinking": {
  "type": "enabled",
  "budget_tokens": 10000
}

// Boolean format (new)
"thinking": {
  "type": true,
  "budget_tokens": 10000
}
```

**Previous Revision (2026-02-28):** ✅ Gemini CLI Config Integration

Successfully tested proxy using **Gemini CLI configuration** from `~/.gemini/.env`. All models work with the CLI's base URL and API key settings.

**Gemini CLI Config Test Results:**

| Test Suite | Models Tested | Passed | Success Rate |
|------------|---------------|--------|--------------|
| Basic Models | 10 | 9 | 90% |
| Gemini Models | 3 | 3 | 100% |
| Claude Models | 6 | 5 | 83.3% |
| Thinking Models | 10 | 7 | 70% |
| **Total** | **29** | **24** | **82.8%** |

**Basic Models (90% success):**
- ✅ deepseek/deepseek-v3.1
- ✅ deepseek-r1
- ✅ minimax/minimax-m2.1
- ✅ moonshotai/kimi-k2.5
- ✅ minimax/minimax-m2.5
- ✅ qwen3-32b
- ✅ deepseek/deepseek-v3.2-exp
- ✅ z-ai/glm-4.7
- ✅ moonshotai/kimi-k2-0905
- ❌ z-ai/glm-5 (upstream issue)

**Gemini Models (100% success):**
- ✅ gemini-2.5-flash
- ✅ gemini-3.1-pro-preview
- ✅ gemini-3.0-flash-preview

**Claude Models (83.3% success):**
- ✅ claude-4.6-sonnet
- ✅ claude-4.5-opus
- ✅ claude-4.5-haiku
- ✅ claude-4.0-sonnet
- ✅ claude-3.7-sonnet
- ❌ claude-4.1-sonnet (invalid request)

**Thinking Models (70% success):**
- ✅ deepseek/deepseek-v3.2-exp-thinking
- ✅ deepseek/deepseek-v3.1-terminus-thinking
- ✅ deepseek-r1-0528
- ✅ qwen3-30b-a3b-thinking-2507
- ✅ qwen3-next-80b-a3b-thinking
- ✅ doubao-1.5-thinking-pro
- ✅ moonshotai/kimi-k2-thinking
- ❌ qwen3-vl-30b-a3b-thinking (upstream unavailable)
- ❌ qwen3-235b-a22b-thinking-2507 (upstream unavailable)
- ❌ doubao-seed-1.6-thinking (upstream unavailable)

**Key Findings:**
- ✅ Proxy works seamlessly with Gemini CLI config (`~/.gemini/.env`)
- ✅ Uses `GOOGLE_GEMINI_BASE_URL` and `GEMINI_API_KEY` from CLI config
- ✅ 82.8% overall success rate across 29 models from 6+ providers
- ✅ All Gemini models (100%) and most Claude models (83.3%) working
- ✅ All thinking models show step-by-step reasoning
- ✅ SSE streaming: Complete message boundaries guaranteed (fixed 2026-03-02)
- ✅ 5 failures: 1 upstream issue, 1 invalid request, 3 unavailable models

**Test Scripts:**
- `test_gemini_cli.sh` - Basic models test (10 models)
- `test_gemini_models_cli.sh` - Gemini models test (3 models)
- `test_claude_models_cli.sh` - Claude models test (6 models)
- `test_thinking_cli.sh` - Thinking models test (10 models)

---

**Previous Revision (2026-02-28):** ✅ Unconfigured Models Validated

Successfully tested proxy with **no specific model IDs configured** in `proxy_config.toml`. All models used fallback configuration from `[models.default]` and `[upstream]` sections.

**Test Results: 100% Success (24/24 tests passed)**

| Test Suite | Models | Tests | Passed | Success Rate |
|------------|--------|-------|--------|--------------|
| DeepSeek Models | 2 | 6 | 6 | 100% |
| Thinking Models | 4 | 12 | 12 | 100% |
| SSE Streaming | 2 | 6 | 6 | 100% |
| **Total** | **8** | **24** | **24** | **100%** |

**Key Findings:**
- ✅ Unconfigured models work perfectly with default settings
- ✅ All 3 endpoints supported: `/v1/messages`, `/v1/interactions`, `generateContent`
- ✅ SSE streaming works for all endpoints
- ✅ Thinking/reasoning models work without special configuration
- ✅ Fallback chain validated: `[models.default]` → `[upstream]` → hardcoded defaults

See `docs/test_results_unconfigured_models.md` for complete details.

---

**Config Refactor (2026-02-28):** ✅ ENV Variables Removed

Removed `FIXED_ROUTE_TARGET_URL` and `FIXED_ROUTE_PATH_PREFIX` environment variables. All configuration now in `proxy_config.toml`:

**Configuration hierarchy for unconfigured models:**
```
1. [models.default].upstream_mode / base_url / api_key
   ↓ (if missing)
2. [upstream].upstream_mode / default_base_url / default_api_key
   ↓ (if missing)
3. Hardcoded defaults: "openai-completions" / "https://api.qnaigc.com"
```

See `docs/config_env_removal.md` for migration guide.

---

**Previous Revision (2026-02-27):** ✅ Config Structure Updated

The routing logic and configuration structure have been revised to align implementation with documentation:
- **Category-based config**: Models grouped by provider with inheritance
- **Array format**: `["model-alias", "base-url", "api-key"]` with empty string inheritance
- **Explicit upstream_mode**: `anthropic-messages`, `gemini-generatecontent`, `openai-completions`
- **No normalization**: Model names preserved as-is (e.g., `"deepseek/deepseek-v3.2"`)

See `docs/routing_config_revision.md` for complete details.

---

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
- ✅ /v1/messages: SSE works (100% - all modes)
- ✅ /v1/interactions: SSE works (100% - OpenAI mode)
- ✅ /v1beta/models/*:generateContent: SSE works (100% - all modes)
- ✅ /v1beta/models/*:streamGenerateContent: SSE works (100% - all modes)

**SSE Implementation Details:**
- **Multi-token chunking**: Efficient batched streaming (recommended)
- **Complete message boundaries**: Proper `data: {...}\n\n` formatting
- **Buffer handling**: Ensures no partial SSE messages sent to clients
- **No `[DONE]` marker**: Streams end naturally via connection close (standard behavior)

**Note:** OpenAI-compatible mode provides consistent 100% SSE streaming across all endpoints.

#### Mode Comparison

**Native Mode:**
- ✅ Gemini: 100% success (6/6 tests)
  - All non-streaming: 100%
  - All streaming: 100%
  - All endpoints work perfectly
- ✅ Claude: 33% success (1/3 endpoints - /v1/messages only)
- ✅ Direct API access, preserves native features

**OpenAI-Compatible Mode:**
- ✅ All models: 100% success (6/6 tests)
- ✅ Full SSE streaming support (all endpoints)
- ✅ Consistent behavior across providers
- ✅ Recommended for production

#### Recent Test Results (2026-02-27)

**Latest Consolidated Test Suite:** 6 comprehensive test scripts

### Test Results Summary

| Test Suite | Success Rate | Details |
|------------|--------------|---------|
| **test_streaming.sh** | 100% (12/12) | All SSE streaming endpoints working |
| **test_all.sh** | 98.3% (59/60) | 30 models tested, only z-ai/glm-5 partial failure |
| **test_gemini.sh** | **100% (18/18)** | All Gemini models, both modes ✅ |
| **test_deepseek.sh** | 91.7% (11/12) | 4 DeepSeek models tested |
| **test_claude.sh** | 66.7% (8/12) | Native & OpenAI modes |
| **test_thinking.sh** | Partial | 10 thinking models (timeout at 240s) |

### Gemini Models - 100% Success ✅

**Native Mode (gemini-generatecontent): 9/9 passed**
- ✅ gemini-3.1-pro-preview: All 3 endpoints working
- ✅ gemini-3.0-flash-preview: All 3 endpoints working
- ✅ gemini-2.5-flash: All 3 endpoints working

**OpenAI-Compatible Mode: 9/9 passed**
- ✅ gemini-3.1-pro-preview: All 3 endpoints working
- ✅ gemini-3.0-flash-preview: All 3 endpoints working
- ✅ gemini-2.5-flash: All 3 endpoints working

**Bugs Fixed (2026-02-27):**
1. Model alias not applied for generateContent endpoint
2. URL path prefix issue (v1beta vs v1) in native mode

### Claude Models - 66.7% Success

**Native Mode (anthropic-messages): 2/3 passed**
- ✅ claude-4.6-sonnet: /v1/messages working
- ✅ claude-4.5-opus: /v1/messages working
- ❌ claude-4.1-sonnet: Service error

**OpenAI-Compatible Mode: 6/9 passed**
- ✅ claude-4.6-sonnet: All 3 endpoints working
- ✅ claude-4.5-opus: All 3 endpoints working
- ❌ claude-haiku-4-5: Model not available on upstream

### SSE Streaming - 100% Success

**All 4 models tested:** deepseek/deepseek-v3.2, gemini-2.5-flash, claude-4.6-sonnet, qwen-max-2025-01-25
- ✅ /v1/messages: 100% (4/4)
- ✅ /v1/interactions: 100% (4/4)
- ✅ /v1beta/models/{model}:streamGenerateContent: 100% (4/4)

### All Models Test - 98.3% Success

**30 models tested** from 6+ providers:
- ✅ DeepSeek: 100% (5 models)
- ✅ Moonshot/Kimi: 100% (2 models)
- ✅ MiniMax: 100% (3 models)
- ✅ Qwen: 93.3% (15 models, 14 passed)
- ✅ GLM/Z-AI: 66.7% (3 models, 2 passed)

**Key Achievements:** 
- All streaming endpoints work with proper SSE format detection
- Native mode routing fixed for Claude and Gemini models
- Model alias feature working correctly
- API key format parsing implemented
- Gemini 3.x preview models now supported
- 98.3% success rate across 30 models from 6+ providers

#### Thinking/Reasoning Models: 15+ models tested

**All thinking models:** ✅ 100% success rate with proper timeout settings (20s)

**Tested models:**
- DeepSeek: R1, R1-0528, V3.2-exp-thinking, V3.1-terminus-thinking
- Qwen: 4 thinking variants (vl-30b, 30b-2507, next-80b, 235b-2507)
- Doubao: seed-1.6-thinking, 1.5-thinking-pro
- Moonshot: kimi-k2-thinking
- Gemini: 3.1-pro-preview (includes reasoning_content)

#### Features Validated

1. ✅ **Category-based config** - Models grouped by provider with inheritance
2. ✅ **Model-specific routing** - Per-model upstreams with array format
3. ✅ **model_alias feature** - Maps client names to upstream names
4. ✅ **upstream_mode detection** - Explicit mode per category
5. ✅ **API key parsing** - Handles "x-api-key: sk-..." format
6. ✅ **Format conversions** - Claude↔OpenAI↔Gemini
7. ✅ **SSE streaming** - All endpoints, all modes (100%)
8. ✅ **Thinking models** - Natural reasoning support
9. ✅ **Vision models** - Image input support
10. ✅ **Multiple providers** - 30+ models from 6+ providers
11. ✅ **Gemini 3.x preview** - Latest experimental models
12. ✅ **Config inheritance** - Model → Category → Upstream defaults
13. ✅ **Unconfigured models** - Automatic fallback to defaults

#### Success Rates

| Test Category | Success Rate | Notes |
|---------------|--------------|-------|
| Unconfigured models | 100% (24/24 tests) | All endpoints, streaming, thinking |
| All models (30 models) | 96.7% (58/60 tests) | OpenAI-compatible mode |
| Perfect score models | 96.7% (29/30 models) | All tests pass |
| DeepSeek models | 100% | All variants |
| Gemini 2.x (OpenAI mode) | 100% | All endpoints |
| Gemini 2.x (Native mode) | 100% | All endpoints |
| Gemini 3.x Preview | 100% | OpenAI mode |
| Claude (Native mode) | 100% | /v1/messages endpoint |
| MiniMax models | 100% | M2.1, M2.5 |
| Qwen models | 93.3% | 14/15 models |
| SSE streaming | 100% | All modes |

#### Provider Success Rates

| Provider | Success Rate | Models Tested |
|----------|--------------|---------------|
| DeepSeek | 100% | 5 models |
| Moonshot/Kimi | 100% | 2 models |
| Qwen | 93.3% | 15 models |
| MiniMax | 100% | 3 models |
| GLM/Z-AI | 66.7% | 3 models |
| Gemini | 100% | 4 models (2.0/2.5/3.0/3.1) |

#### Detailed Test Documentation

## 📄 License

MIT

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## 🛠️ Technical Implementation

### Latest Changes (Current)

**Composite Fallback to Default Upstream**: Composite aliases now support unresolved target models by falling back to the default upstream route (`getDefaultModelRoute`) while preserving the target model as `modelAlias`. This allows aliases such as `code-small` to route even when the target is not explicitly declared in `models.*`.

**Messages Format Detection Fix (Claude blocks vs OpenAI passthrough)**: `/v1/messages` request detection now treats block-style Claude content (`content: [{type:"text"|"tool_use"|"tool_result"|"thinking", ...}]`) as Claude format, forcing Claude→OpenAI conversion for `openai-completions` upstreams. This prevents malformed passthrough payloads to `/v1/chat/completions`.

**Dashboard Side-Nav Active Style**: The active side navigation item in `/dashboard` now has a visible border (light gray) for clearer section focus.

**TOML Parser Regex Order Fix**: The `parseSimpleToml()` function in `config-loader.ts` checked `unquotedMatch` (regex `key = (.+)`) before `arrayMatch` (regex `key = [...]`). For model IDs containing only hyphens and underscores (e.g., `deepseek-v4-flash`), the greedy `unquotedMatch` captured the array value but silently discarded it since `models` sections are not in its handling scope. Models with dots (e.g., `gpt-5.4-mini`) were unaffected because `.` is outside the `[a-zA-Z0-9_-]` character class. Fixed by swapping the check order — `arrayMatch` is now evaluated before `unquotedMatch`, with a comment explaining the ordering constraint. This fixes composite model resolution (e.g., `code-small` → `deepseek-v4-flash`) where the candidate model key was previously never found in its category.

**Thinking Block Validation Field Fix**: `ThinkingBlock` type defines field `thinking: string`, but `validateClaudeContentBlock()` in `validation.ts` was checking `block.text` for `type: "thinking"` blocks. This caused validation to throw `text is required for thinking blocks` when Claude CLI sent requests with thinking content blocks in assistant messages (the field is `thinking`, not `text`). Fixed by changing the check to `block.thinking`.

**Upstream Error Diagnostics**: The proxy now reads and logs upstream error response bodies in `handleClaudeRequest` before throwing, making it possible to diagnose API-level errors (e.g., DeepSeek returning 400 about thinking mode).

**DeepSeek Thinking Mode Compatibility**: Some upstreams (e.g., DeepSeek's Anthropic-compatible API) internally default models to thinking mode and require prior `content[].thinking` blocks in the conversation even on the first request. The proxy now:
- Defaults `thinking` to `disabled` when the client doesn't set it
- Strips `thinking: { type: "enabled" }` when there are no prior assistant thinking blocks in the conversation history (avoids 400 errors on first requests)

**Full Request Body Logging**: Added debug-level logging of the full request body sent to upstreams in `handleClaudeRequest` for easier troubleshooting.

**Thinking Signature Support & Streaming Improvements**:
- **Signature Delta Events**: Added full `signature_delta` support for thinking block verification in streaming
- **OpenAI-to-Claude Conversion**: Enhanced conversion of OpenAI's `reasoning_item_id` and `signature` to Claude's thinking format
- **Streaming Thinking Extraction**: Improved thinking content extraction from `<thinking>` markers and `reasoning_content` fields
- **Thinking Block Lifecycle**: Proper `content_block_start/delta/stop` events for thinking blocks in streaming

**ChatJimmy SDK Path Mapping & Import Fixes**:
- **package.json**: Added chatjimmy-sdk imports configuration
- **tsconfig.json/tsconfig.server.json**: Added TypeScript path mappings for `chatjimmy-sdk` and `chatjimmy-sdk/*`
- **src/utils/sdk-handler.ts**:
  - Fixed SDK URL parsing (corrected prefix length from 5 to 6 characters)
  - Simplified chatjimmy SDK import to use only built dist version
  - Improved error messages for SDK import failures

tsconfig.json / tsconfig.server.json
```json
    "esModuleInterop": true,
    "baseUrl": "./",
    "paths": {
      "chatjimmy-sdk": ["submodules/chatjimmy/src/index.ts"],
      "chatjimmy-sdk/*": ["submodules/chatjimmy/src/*"]
    }
```

package.json
```json
  "imports": [
    {
      "pattern": "chatjimmy-sdk/*",
      "target": "./submodules/chatjimmy/src/*"
    }
  ]
```
or
```json
    {
      "pattern": "chatjimmy-sdk",
      "target": "./submodules/chatjimmy/src/index.ts"
    }
```

### ChatJimmy SDK Integration (2026-03-04)

**Direct source reference with path mapping**: ChatJimmy SDK is integrated via TypeScript path mapping instead of requiring separate build steps.

**SDK Handler**: `src/utils/sdk-handler.ts` provides SDK-based request handling:
- **SDK URL detection**: `sdk://` URLs use chatjimmy SDK clients instead of HTTP fetch
- **OpenAI-compatible mode**: `handleSdkOpenAIRequest()` uses `OpenAICompatibleClient`
- **Anthropic-compatible mode**: `handleSdkAnthropicRequest()` uses `OpenAICompatibleClient` as fallback
- **Streaming support**: SDK Anthropic stream is converted from OpenAI chunks to Claude SSE event format (`message_start`, `content_block_*`, `message_delta`, `message_stop`)
- **Streaming fallback**: If SDK stream is unavailable, falls back to non-stream response


### Enhanced Thinking Configuration (2026-03-03)
- **Type Definitions**: Updated `ThinkingConfigParam` type to accept `boolean` values (`true`/`false`) in addition to string values (`"enabled"`/`"disabled"`)
- **Normalization Utility**: Added `normalizeThinkingConfig()` function to standardize thinking config across the codebase
- **Token Counting**: Updated token counting logic to handle boolean thinking types
- **Validation**: Enhanced validation to accept boolean values while maintaining backward compatibility

### Thinking Signature Support (Latest)
- **Signature Delta Events**: Added `"signature_delta"` to `ClaudeStreamEvent.delta.type` for streaming signature verification
- **Streaming Signature Emission**: Implemented `signature_delta` event emission before `content_block_stop` for thinking blocks
- **Signature Accumulation**: Accumulates signatures from multiple sources: `delta.signature`, `reasoning_item_id`, and `signature` fields
- **OpenAI-to-Claude Conversion**: Converts OpenAI's `reasoning_item_id` and `signature` to Claude's `signature_delta` format
- **Anthropic Pass-Through**: Passes through `signature_delta` events from Anthropic upstream unchanged
- **Non-Streaming Compatibility**: Includes signature in thinking block metadata for non-streaming responses

**Files Modified**:
- `src/types/claude.ts` - Added `"signature_delta"` to stream event types
- `src/converters/streaming.ts` - Added signature accumulation and emission logic
- `src/converters/openai-to-claude.ts` - Enhanced signature extraction from response metadata

### Gemini v1 Endpoint Support
- **Path Pattern Matching**: Updated regex patterns to support both `/v1beta/models/` and `/v1/models/` endpoints
- **URL Building**: Enhanced URL construction logic for both v1beta and v1 endpoints
- **Model Extraction**: Improved model ID extraction from both endpoint versions

### API Key Management
- **Priority Logic**: Added intelligent API key priority based on upstream mode
- **Format Utility**: Created `formatApiKeyForUpstream()` function for consistent header formatting
- **Header Transformation**: Enhanced `transformAuthHeadersForUpstream()` to handle `Bearer` prefix stripping
- **Configuration Integration**: Better integration of config API keys with request processing

### Files Modified:
- `src/converters/claude-to-gemini.ts` - Added boolean thinking support for Gemini conversion
- `src/converters/claude-to-openai.ts` - Added boolean thinking support for OpenAI conversion
- `src/index.ts` - Enhanced routing for v1 endpoints, API key priority logic
- `src/types/claude.ts` - Updated ThinkingConfigParam type definition
- `src/utils/routing.ts` - Added formatApiKeyForUpstream(), enhanced path matching
- `src/utils/thinking.ts` - Added normalization utility, updated all thinking functions
- `src/utils/token-counting.ts` - Updated to handle boolean thinking types
- `src/utils/validation.ts` - Enhanced validation for boolean thinking values

## 🔗 Links

- [Claude API Documentation](https://docs.anthropic.com/claude/reference/)
- [OpenAI API Completions](https://platform.openai.com/docs/api-reference)
- [OpenAI API Responses](https://developers.openai.com/api/reference/resources/responses/index.md)
- [Google Gemini API Documentation](https://ai.google.dev/gemini-api/docs)
