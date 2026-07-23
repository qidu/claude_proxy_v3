# Tests

## Coverage testcases prerequisite

Coverage test cases live in `../testcases` and must be run from the project root through the custom runner. Use `node run-tests.js --all` for all suites, or `node run-tests.js <index>` for selected suites. Bare `node run-tests.js` prints help only.

## Multi-Agent SDK Test

### `multi-agents-test.ts`

Runs five agent SDKs against the local proxy (`127.0.0.1:8788` by default, override with `PROXY_BASE`).

Agent order (used by the CLI `agent` selector):

| # | Agent   | SDK package                          | Transport                       |
|---|---------|--------------------------------------|---------------------------------|
| 1 | Codex   | `@openai/codex-sdk`                  | OpenAI Responses (`/v1/responses`) via `~/.codex/config.toml` |
| 2 | Claude  | `@anthropic-ai/claude-agent-sdk`     | Anthropic Messages (`/v1/messages`) via `ANTHROPIC_BASE_URL` |
| 3 | Gemini  | `@google/genai`                      | Gemini (`/v1beta/...`) via `httpOptions.baseUrl` |
| 4 | Pi      | `@earendil-works/pi-agent-core`      | Anthropic Messages (`/v1/messages`) via `createProvider` |
| 5 | OpenCode| `@opencode-ai/sdk`                   | OpenAI-compatible (`/v1`) via `OPENCODE_CONFIG_CONTENT` → spawns `opencode serve` |

The full run is `len(USER_TASKS) * len(MODELS) * 5` = 8 × 9 × 5 = 360 invocations (modulated by the CLI selection below).

#### Environment Variables

`API_KEY` (or any one of the agent-specific keys below) is required for the agent to authenticate against the proxy. The key is the value the proxy itself accepts and forwards to its upstream — supply a key that is valid for the upstream provider you are targeting.

| Variable             | Used by agent | Notes |
|----------------------|---------------|-------|
| `API_KEY`            | all           | Fallback if a per-agent key is not set. |
| `CODEX_API_KEY`      | Codex         | Codex reads this via `~/.codex/config.toml` (`env_key = "CODEX_API_KEY"`). |
| `ANTHROPIC_API_KEY`  | Claude, Pi    | Claude passes it via `env.ANTHROPIC_API_KEY`; Pi's `envApiKeyAuth` falls back to it after `PI_API_KEY`. |
| `GEMINI_API_KEY`     | Gemini        | Passed to `GoogleGenAI({ apiKey })`. |
| `PI_API_KEY`         | Pi            | First preference for `envApiKeyAuth`; if unset, `ANTHROPIC_API_KEY` / `API_KEY` are tried in order. |
| `OPENCODE_API_KEY`   | OpenCode      | Injected into `OPENCODE_CONFIG_CONTENT` and read by the spawned `opencode serve`. |
| `PROXY_BASE`         | all           | Override the proxy origin (default `http://127.0.0.1:8788`). |

If you only want to exercise one agent, set just its key. Other agents will be skipped because their SDK constructors will fail.

#### Usage

```bash
# Start the proxy first (it must listen on PROXY_BASE; default 127.0.0.1:8788)
npm run dev

# Set at least one key (or API_KEY for all agents)
export API_KEY="sk-a-valid-key"
# export CODEX_API_KEY="$API_KEY"
# export ANTHROPIC_API_KEY="$API_KEY"
# export GEMINI_API_KEY="$API_KEY"
# export PI_API_KEY="$API_KEY"
# export OPENCODE_API_KEY="$API_KEY"

# Run the full sweep
npx tsx tests/multi-agents-test.ts

# Or pick (M A T): Mth model, Ath agent, Tth task (1-based, wraps with %)
npx tsx tests/multi-agents-test.ts 1 1 1     # first model, first agent, first task
npx tsx tests/multi-agents-test.ts 9 4 0     # last model, Pi agent, all tasks
npx tsx tests/multi-agents-test.ts 0 4 0     # all models, Pi agent, all tasks
```

By default all 5 agents are enabled. To run a subset, comment the `runXxxAgent(task, model);` lines in `main()` for the agents you want to skip.

#### Per-agent notes

**Codex** — Writes `~/.codex/config.toml` with `base_url = ${PROXY_BASE}/v1` and `wire_api = "responses"`, then runs the prompt through `Codex().startThread(...).run(prompt)`. Requires `DEV_PASS_THROUGH=true` on the proxy so `/v1/chat/completions` (Codex's fallback) is also accepted.

**Claude** — Uses `claudeQuery()` with `allowedTools: ["Glob", "Read"]` and `maxTurns: 30`. `ANTHROPIC_BASE_URL` is set to the proxy origin (Claude SDK appends `/v1/messages`).

**Gemini** — A custom 20-turn tool-calling loop using `GoogleGenAI` with two `functionDeclarations` (`Glob`, `Read`) that call back into the shared `toolGlobSync` / `toolRead` helpers. Tools execute synchronously in the test process; results are appended as `functionResponse` parts.

**Pi (`@earendil-works/pi-agent-core`)** — Three subtleties:

1. The proxy only accepts `/v1/messages` for arbitrary models, so Pi is wired through `anthropicMessagesApi()` regardless of the underlying provider. A static model catalog is built from `MODELS` at startup (one entry per id, all routed through `provider: "anthropic"`).
2. Pi's anthropic client appends `/v1/messages` to `baseUrl` internally, so the provider's `baseUrl` must be the proxy origin **without** the `/v1` suffix — otherwise the request hits `/v1/v1/messages` and 404s.
3. `provider.auth` must be wrapped in an envelope (`{ apiKey: envApiKeyAuth(...) }`), not passed as the bare auth object — Pi looks for `auth.apiKey` and silently produces `"Provider is not configured"` if the envelope is missing. The `getApiKey` hook on the `Agent` also bypasses Pi's on-disk credential store (`~/.pi/agent/auth.json`) so a stale OAuth credential for another provider cannot shadow the env-supplied key.

**OpenCode (`@opencode-ai/sdk`)** — Three subtleties:

1. OpenCode's SDK does not speak to a provider directly — `createOpencode()` spawns `opencode serve`, which then forwards requests. Provider config is injected via `OPENCODE_CONFIG_CONTENT`; `baseURL` is `${PROXY_BASE}/v1`.
2. The `opencode` binary must be on `PATH` (not always installed alongside the SDK). The runner pre-checks `PATH` and logs `[OpenCode] 'opencode' binary not found on PATH — skipping. Install with: npm i -g opencode-ai` rather than timing out on the 5-second server-start wait. Install with `npm i -g opencode-ai` if you want this agent enabled.
3. Write-capable tools (`bash`, `edit`, `write`) are disabled in the session body so behavior stays read-only and comparable to the other workers; `read`, `grep`, `glob` are kept on.

#### OpenCode — example config & key requirements

A reference `~/.config/opencode/opencode.jsonc` for this proxy looks like:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "proxyv3": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "proxyv3",
      "options": {
        "baseURL": "http://localhost:8788/v1",
        "apiKey": "{env:API_KEY}",
        "headers": {
          "Authorization": "Bearer {env:API_KEY}"
        }
      },
      "models": {
        "minimax-m3": { "name": "minimax-m3" },
      }
    }
  },
  "model": "proxyv3/minimax-m3"
}
```

The two provider packages OpenCode can load — `@ai-sdk/anthropic` and `@ai-sdk/openai-compatible` — end up at different proxy endpoints with very different key requirements:

- **`@ai-sdk/anthropic`** → `/v1/messages`. The proxy's Anthropic Messages handler is open for the local test runner; any non-empty key is accepted (e.g. `API_KEY=sk-hi`). Use this when you just want to point OpenCode at the proxy and exercise the model catalog.
- **`@ai-sdk/openai-compatible`** → `/v1/chat/completions`. This path is only exposed in **pass-through mode** (`DEV_PASS_THROUGH=true` on the proxy). The proxy forwards the raw `Authorization: Bearer <key>` header to the upstream provider, so the key must be valid for the upstream you target (e.g. the dedicated `sk-cp-…` key for `minimax-m3`). A key that works for `/v1/messages` will be rejected with `401` here.
- In both cases the `options.apiKey` is what AI SDK uses to authenticate; the `options.headers.Authorization` entry is OpenCode's documented way to also stamp an explicit `Authorization: Bearer …` on the outgoing request and is required when the upstream does not infer auth from the URL.
- `promptCacheKey` is added by default by `@ai-sdk/openai-compatible`; some proxies/upstreams reject it. For `openai-compatible` on this proxy you can either add `options.setCacheKey = false` or set the header explicitly via the `headers` block above.

#### Result reference

For a sample run (1 model × all agents × all tasks), see `./logs/results/test_result_of_deepseek_v4_flash_all_agents_all_tasks.md`.

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
