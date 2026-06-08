# Test Suite

Custom lightweight test runner — no Jest/Mocha. Tests are plain async functions in `.test.js` files, run directly with `node`. Shared helpers live in `utils/`.

## Running All Tests

Create a runner script (e.g., `run-tests.js` at project root):

```js
// run-tests.js
import { spawn } from 'child_process';

const TEST_DIR = './testcases';
const PROXY_URL = process.env.PROXY_URL || 'http://localhost:8788';
const API_KEY = process.env.API_KEY || 'sk-test-key';
const TEST_TIMEOUT = process.env.TEST_TIMEOUT || '30000';

const suites = [
  '01_endpoints/messages.test.js',
  '01_endpoints/messages_streaming.test.js',
  '01_endpoints/interactions.test.js',
  '01_endpoints/generateContent.test.js',
  '02_features/thinking.test.js',
  '02_features/tool_use.test.js',
  '02_features/image_input.test.js',
  '03_errors/validation.test.js',
  '04_models/models.test.js',
  '05_upstream_modes/upstream_modes.test.js',
  '06_integration/integration.test.js',
  '07_dashboard/dashboard_api.test.js',
  '08_regression/regression.test.js',
];

let passed = 0, failed = 0;

for (const suite of suites) {
  const child = spawn('node', [`${TEST_DIR}/${suite}`], {
    env: { ...process.env, PROXY_URL, API_KEY, TEST_TIMEOUT },
    stdio: 'inherit',
  });

  await new Promise((resolve) => child.on('close', (code) => {
    if (code === 0) passed++;
    else failed++;
    resolve();
  }));
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Total: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

Or use `tsx` for ESM:

```bash
# Run all tests
node --loader tsx run-tests.js

# Run with env
PROXY_URL=http://localhost:8788 API_KEY=sk-test node --loader tsx run-tests.js
```

## Running Tests Individually

```bash
# Run a single test file
node testcases/01_endpoints/messages.test.js

# Run with custom proxy URL
PROXY_URL=http://localhost:8788 node testcases/01_endpoints/messages.test.js

# Run with custom API key
API_KEY=your-key node testcases/01_endpoints/messages.test.js

# Adjust timeout (default 30s)
TEST_TIMEOUT=60000 node testcases/04_models/models.test.js
```

## Structure

| Directory | Description |
|---|---|
| `01_endpoints/` | Core API endpoint tests |
| `02_features/` | Feature-specific tests |
| `03_errors/` | Validation and error handling |
| `04_models/` | Multi-model smoke tests |
| `05_upstream_modes/` | Cross-format/conversion tests |
| `06_integration/` | Multi-component integration |
| `07_dashboard/` | Dashboard API and TUI backend |
| `08_regression/` | Previously fixed bugs and edge cases |
| `utils/` | Shared test helpers |

## Test Files

### 01_endpoints

- `messages.test.js` — POST /v1/messages, system prompts, multi-turn, parameters (temperature, top_p, top_k, stop_sequences), metadata, array content blocks
- `messages_streaming.test.js` — SSE streaming, event types, content deltas, streaming with system/multi-turn
- `interactions.test.js` — POST /v1/interactions, text/object input, multi-turn, system instruction, generation config, streaming, tools, thinking_level
- `generateContent.test.js` — POST /v1beta/models/{model}:generateContent, generation config, safety settings, system instruction, tools, streaming, multi-turn

### 02features

- `thinking.test.js` — Thinking/reasoning: enabled/disabled, boolean format, adaptive, reasoning_effort, output_config.effort, budget tokens, streaming
- `tool_use.test.js` — Tool/function calling: basic tool use, tool_choice variants (auto/any/none/specific), multiple tools, streaming, round-trip, OpenAI format
- `image_input.test.js` — Image content: base64, URL, text+image, multiple images, PNG, WebP

### 03errors

- `validation.test.js` — Missing/invalid parameters, authentication, malformed JSON, content-type mismatch, invalid tool definitions, rate limiting, blocked endpoints

### 04models

- `models.test.js` — DeepSeek, Qwen, MiniMax, Moonshot/Kimi models, thinking models, custom NVIDIA models, composite aliases, multi-endpoint routing, streaming

### 05upstream_modes

- `upstream_modes.test.js` — Claude/OpenAI/Gemini format conversion, token counting (with thinking), Responses API, embeddings, models list, mode conversion

### 06integration

- `integration.test.js` — Config load on startup, sequential stats accumulation, health check, CORS headers, models list, token counting, request timeout, timing stats, error format, streaming/non-streaming coexistence

### 07dashboard

- `dashboard_api.test.js` — GET/PUT /dashboard/api/config, /stats/models, /stats/agents, /stats/requests, POST /test-model (standard + composite alias), HTML page rendering, auth handling

### 08regression

- `regression.test.js` — Header write crash on exception (fix 3e05fb7), tool_choice auto (fix fdad843), config schema validation (fix 18a1db8), heatmap structure, malformed JSON, empty content, long system prompts, unicode, rapid requests/rate limiting, OpenAI format system, mixed content blocks, zero max_tokens

## Prerequisites

Tests run against a live proxy instance. The proxy must be started beforehand with all required upstream API keys and features configured.

### Common Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PROXY_URL` | `http://localhost:8788` | Proxy base URL |
| `API_KEY` | `sk-test-key` | Bearer token sent in `Authorization` header |
| `TEST_TIMEOUT` | `30000` | Per-request timeout in milliseconds |

### Per-Suite Requirements

#### `01_endpoints`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `messages.test.js` | `POST /v1/messages` | `deepseek/deepseek-v3.2`, `qwen3-32b` | Claude-format request/response, system prompts, temperature/top_p/top_k, stop_sequences, metadata |
| `messages_streaming.test.js` | `POST /v1/messages` (stream: true) | `deepseek/deepseek-v3.2`, `qwen3-32b` | SSE events (`message_start`, `content_block_delta`, `message_stop`) |
| `interactions.test.js` | `POST /v1/interactions` | `gemini-2.5-flash` | Gemini-format input, system_instruction, generation_config, tools, thinking_level, streaming |
| `generateContent.test.js` | `POST /v1beta/models/{model}:generateContent`, `POST /v1/models/{model}:generateContent`, streaming variant | `gemini-2.5-flash` | Gemini generateContent format, safety_settings, tools, multi-turn |

#### `02_features`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `thinking.test.js` | `POST /v1/messages` | `deepseek-r1`, `deepseek/deepseek-v3.2` | thinking.type (enabled/disabled/adaptive), boolean format, reasoning_effort, output_config.effort, budget_tokens, streaming |
| `tool_use.test.js` | `POST /v1/messages` | `deepseek/deepseek-v3.2`, `qwen3-32b` | All tool_choice variants (auto/any/tool/none), multiple tools, tool result round-trip, OpenAI-format tools, streaming |
| `image_input.test.js` | `POST /v1/messages` | `qwen3-32b` (vision-capable) | Image content blocks (base64 + URL), JPEG/PNG/WebP media types, multiple images |

#### `03_errors`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `validation.test.js` | `POST /v1/messages`, `POST /v1/chat/completions` (must return 4xx) | `deepseek/deepseek-v3.2` | Validation errors (missing model, empty messages, etc.), missing auth → 401, malformed JSON → 400, rate limiting |

#### `04_models`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `models.test.js` | `POST /v1/messages`, `POST /v1/interactions`, `POST /v1beta/models/{model}:generateContent` | `deepseek/deepseek-v3.2`, `deepseek-r1`, `qwen3-32b`, `qwen-max-2025-01-25`, `minimax/minimax-m2.1`, `minimax/minimax-m2.5`, `moonshotai/kimi-k2.5`, `moonshotai/kimi-k2-0905`, `nvidia/nemotron-3-ultra-550b-a55b`, `nvidia/nemotron-3-super-120b-a12b`, `deepseek/deepseek-v3.2-exp-thinking`, composite alias `code-small` | Upstream API keys for **DeepSeek, Qwen, MiniMax, Moonshot, NVIDIA** providers; composite aliases; multi-endpoint routing |

#### `05_upstream_modes`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `upstream_modes.test.js` | `POST /v1/messages`, `POST /v1/interactions`, `POST /v1/messages/count_tokens`, `POST /v1/responses`, `POST /v1/embeddings`, `GET /v1/models` | `deepseek/deepseek-v3.2`, `deepseek-r1`, `gemini-2.5-flash`, `qwen/qwen3-embedding-4b` | Token counting (with thinking), format conversion (Claude/OpenAI/Gemini), models list, embeddings, Responses API |

#### `06_integration`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `integration.test.js` | `GET /dashboard/api/config`, `GET /dashboard/api/stats/models`, `GET /dashboard/api/stats/requests`, `POST /v1/messages`, `GET /v1/models`, `POST /v1/messages/count_tokens` | `deepseek/deepseek-v3.2`, `qwen3-32b` | Stats accumulation, CORS headers, health check, client-side timeout handling, error format consistency |

#### `07_dashboard`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `dashboard_api.test.js` | `GET/PUT /dashboard/api/config`, `GET /dashboard/api/stats/models`, `GET /dashboard/api/stats/agents`, `GET /dashboard/api/stats/requests`, `POST /dashboard/api/test-model`, `GET /dashboard` | `deepseek/deepseek-v3.2`, any configured composite alias | Dashboard config read/write, stats endpoints, real upstream test-model, HTML page rendering, auth validation |

#### `08_regression`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `regression.test.js` | `POST /v1/messages` (non-streaming + streaming), `GET /dashboard/api/config`, `GET /dashboard/api/stats/requests` | `deepseek/deepseek-v3.2`, `qwen3-32b` | Header-write crash guard, tool_choice auto/any, config validation schema, heatmap/request stats structure, malformed JSON, empty content, unicode, rapid requests, OpenAI system format, mixed content blocks, zero max_tokens |

### Provider API Keys Required

The proxy configuration must have upstream API keys for all of the following providers (tests will 401/500 without them):

- **DeepSeek** — used by messages, thinking, tool_use, models, upstream_modes, integration, regression suites
- **Qwen (Alibaba)** — used by messages, streaming, tool_use, image_input, models, regression suites
- **MiniMax** — used by models suite
- **Moonshot/Kimi** — used by models suite
- **Gemini (Google)** — used by interactions, generateContent, upstream_modes suites
- **NVIDIA** — used by models suite

### Proxy Features That Must Be Enabled

- Auth/API key validation (Bearer token on all endpoints)
- SSE streaming on `/v1/messages`
- Tool/function calling with all `tool_choice` variants (auto, any, tool, none)
- Thinking/reasoning parameter support (Claude-style and OpenAI-compatible formats)
- Image content blocks (base64 and URL sources)
- Multi-format conversion (Claude ↔ OpenAI ↔ Gemini)
- Stats accumulation (model-level, agent-level, request-level, timing data)
- Dashboard config read/write
- Composite/alias model routing
- Rate limiting (or graceful handling of rapid requests)
- CORS headers
- Token counting endpoint (`/v1/messages/count_tokens`)
- Embeddings endpoint (`/v1/embeddings`)
- Responses API endpoint (`/v1/responses`)
- `POST /v1/chat/completions` explicitly blocked (returns 4xx error)
- Graceful error handling (no crash on invalid input, header-write-after-exception guard)

## Utilities (`utils/`)

- `test_helpers.js` — `sendRequest`, `sendStreamingRequest`, `assert`, `assertResponse`, `assertStreamingResponse`, `runTest`, `runTestSuite`, `testModelEndpoints`, `sleep`
- `model_config.js` — Model registries by provider (DeepSeek, Qwen, MiniMax, Moonshot, GLM, Gemini, NVIDIA), thinking models, tool-capable models, composite aliases, priority tiers

## Notes

- Tests hit `localhost:8788` by default (configurable via `PROXY_URL`)
- Tests are sequential — no parallelization or test isolation
- Some tests accept both 200 and >=400 as valid (graceful degradation)
- TUI interactive features are tested via the dashboard API they call; interactive TTY testing requires manual testing or a terminal automation tool