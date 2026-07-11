# Tests

## Multi-Agent SDK Test

### `multi-agents-test.ts`

Runs three agent SDKs (OpenAI Codex, Anthropic Claude, Google Gemini) against eight models with diverse prefixes through the local proxy (`127.0.0.1:7777`).

#### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | For Claude | API key for the proxy. Used by Claude Agent. |
| `CODEX_API_KEY` | For Codex | API key for Codex Agent (uncomment `runCodexAgent` to enable). |
| `GEMINI_API_KEY` | For Gemini | API key for Gemini Agent (uncomment `runGeminiAgent` to enable). |

`multi-agents-test.ts` also supports 3 parameters to choose how many models x agents x tasks to run,
refer to ./logs/results/test_result_of_deepseek_v4_flash_all_agents_all_tasks.md for 1 model x all agents x all tasks.

#### Usage

```bash
# Required for at least one agent to run, the key should be valid key from proxy's upstream server.
export ANTHROPIC_API_KEY="sk-a-valid-key"

# Optional — only needed if you enable Codex or Gemini below
# export CODEX_API_KEY="your-codex-key"
# export GEMINI_API_KEY="your-gemini-key"

# Start the proxy first, then run the test
npx tsx tests/multi-agents-test.ts
```

By default all 3 agents is active. Comment some of them in `main()` to just enable left one.

---

## Gemini API Tests

This directory contains tests for the Gemini handler with support for both Gemini Interactions API and OpenAI-compatible endpoints.

## Test Files

### `test_gemini_native.js`
Tests the native Gemini Interactions API (`GEMINI_ENDPOINT_TYPE=native`):
- Uses native Gemini format (`input` field)
- Requires `x-goog-api-key` header
- Targets `generativelanguage.googleapis.com/v1beta/interactions`

### `test_gemini_openai_compatible.js`
Tests OpenAI-compatible Gemini wrappers (`GEMINI_ENDPOINT_TYPE=openai-compatible`):
- Uses Claude/OpenAI format (`messages` array)
- Requires `Authorization: Bearer` or `x-api-key` header
- Targets `/v1/chat/completions` endpoint

### `test_gemini_simple.js`
Legacy test for native Gemini format (updated with warnings)

## Configuration

### Environment Variables
```bash
# For native Gemini API
export GEMINI_ENDPOINT_TYPE=native
export GEMINI_BASE_URL=https://generativelanguage.googleapis.com
export GEMINI_API_VERSION=v1beta
export GEMINI_API_KEY=your_gemini_api_key

# For OpenAI-compatible Gemini
export GEMINI_ENDPOINT_TYPE=openai-compatible
export GEMINI_BASE_URL=https://api.qnaigc.com/v1
export GEMINI_API_KEY=your_openai_compatible_api_key
```

### wrangler.toml
```toml
# Default configuration (OpenAI-compatible)
GEMINI_ENDPOINT_TYPE = "openai-compatible"

# For native Gemini API
# GEMINI_ENDPOINT_TYPE = "native"
# GEMINI_BASE_URL = "https://generativelanguage.googleapis.com"
# GEMINI_API_VERSION = "v1beta"
```

## Running Tests

1. **Start the proxy**:
   ```bash
   npm run dev
   ```

2. **Set API key** in test files:
   - Replace `YOUR_GEMINI_API_KEY` with actual API key
   - Replace `YOUR_API_KEY` with actual API key

3. **Run tests**:
   ```bash
   # Native Gemini API
   GEMINI_ENDPOINT_TYPE=native node tests/test_gemini_native.js

   # OpenAI-compatible Gemini
   GEMINI_ENDPOINT_TYPE=openai-compatible node tests/test_gemini_openai_compatible.js

   # Legacy test (native format)
   GEMINI_ENDPOINT_TYPE=native node tests/test_gemini_simple.js
   ```

## Test Coverage

### Native Gemini API
- ✅ Claude format conversion (`messages` → `input`)
- ✅ Native Gemini format (`input` field)
- ✅ Streaming responses
- ✅ `x-goog-api-key` header support
- ✅ `Authorization: Bearer` fallback
- ✅ Environment variable API key

### OpenAI-compatible Gemini
- ✅ Claude to OpenAI format conversion
- ✅ Streaming responses
- ✅ `Authorization: Bearer` header support
- ✅ `x-api-key` header support
- ✅ Environment variable API key
- ✅ Tool support

## Endpoint Differences

### Native Gemini API
- Path: `/v1beta/interactions`
- Request format: `{ "input": "text" }`
- Response format: Gemini InteractionResponse
- Headers: `x-goog-api-key`
- Supports: GET, POST, DELETE, cancel operations

### OpenAI-compatible Gemini
- Path: `/v1/chat/completions`
- Request format: OpenAI format (`messages` array)
- Response format: OpenAI format
- Headers: `Authorization: Bearer` or `x-api-key`
- Supports: POST only (no GET/DELETE/cancel)

## Backward Compatibility

The refactoring maintains backward compatibility:
- Default `GEMINI_ENDPOINT_TYPE=openai-compatible`
- Existing `GEMINI_BASE_URL` and `GEMINI_API_VERSION` still work
- Auto-detection of request format for native endpoints
- Fallback header support
