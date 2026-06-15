# Test Suite

Custom lightweight test runner — no Jest/Mocha. Tests are plain async functions in `.test.js` files, run directly with `node`. Shared helpers live in `utils/`.

## Running All Tests

Two runner scripts live at the project root:

- **`run-tests.js`** — single pass, prints results to stdout
- **`run-tests-loop-wrapper.js`** — repeating loop, writes a timestamped Markdown report to `./tests/`

```bash
# Single pass
node run-tests.js

# Loop (repeats until interrupted)
node run-tests-loop-wrapper.js

# With custom proxy URL and API key
PROXY_URL=http://localhost:8788 API_KEY=sk-test node run-tests.js
```

### Config Isolation

The runners automatically isolate the proxy config so tests never modify `proxy_config.toml`:

1. At startup, `proxy_config.toml` is **copied** to `test_proxy_config.toml`.
2. `TEST_CONFIG=test_` is passed to the proxy and to all child test processes, directing the proxy to load `test_proxy_config.toml`.
3. Any `PUT /dashboard/api/config` mutations during the run target only the test file.
4. At exit (including Ctrl-C and crashes), `test_proxy_config.toml` is **deleted**.

The proxy must be started with `TEST_CONFIG=test_` for this to work:

```bash
# Terminal 1 — proxy pointed at the test config
TEST_CONFIG=test_ node src/server.ts

# Terminal 2 — run tests (creates/manages test_proxy_config.toml)
node run-tests.js
```

## Running Tests Individually

```bash
# Run a single test file
node testcases/01_endpoints/messages.test.js

# With custom proxy URL
PROXY_URL=http://localhost:8788 node testcases/01_endpoints/messages.test.js

# With custom API key
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
| `09_composite/` | Composite alias behaviors (primary, fallback, share, token_limit) |
| `10_auth/` | Auth header flows (x-api-key, x-goog-api-key, Bearer, config priority) |
| `11_responses/` | Responses API coverage (input_tokens, compact, openai-responses mode, documented limitations) |
| `12_config_validation/` | Config schema validation via PUT /dashboard/api/config |
| `13_fusion/` | Fusion composite alias (parallel fan-out → judge → synthesis) |
| `utils/` | Shared test helpers |

## Test Files

### 01_endpoints

- `messages.test.js` — POST /v1/messages, system prompts, multi-turn, parameters (temperature, top_p, top_k, stop_sequences), metadata, array content blocks
- `messages_streaming.test.js` — SSE streaming, event types, content deltas, streaming with system/multi-turn
- `interactions.test.js` — POST /v1/interactions, text/object input, multi-turn, system instruction, generation config, streaming, tools, thinking_level
- `generateContent.test.js` — POST /v1beta/models/{model}:generateContent and /v1/models/{model}:generateContent, generation config, safety settings, system instruction, tools, streaming, multi-turn, v1beta/v1 streamGenerateContent (with SSE validation), :countTokens

### 02_features

- `thinking.test.js` — Thinking/reasoning: enabled/disabled, boolean format, adaptive, reasoning_effort, output_config.effort, budget tokens, streaming, output_config.task_budget.total, xhigh effort normalization, OpenAI thinking format, signature_delta events, custom budget_to_effort_* thresholds
- `tool_use.test.js` — Tool/function calling: basic tool use, tool_choice variants (auto/any/none/specific), multiple tools, streaming, round-trip, OpenAI format
- `image_input.test.js` — Image content: base64, URL, text+image, multiple images, PNG, WebP

### 03_errors

- `validation.test.js` — Missing/invalid parameters, authentication, malformed JSON, content-type mismatch, invalid tool definitions, rate limiting, blocked endpoints

### 04_models

- `models.test.js` — DeepSeek, Qwen, MiniMax, Moonshot/Kimi models, thinking models, custom NVIDIA models, composite aliases, multi-endpoint routing, streaming

### 05_upstream_modes

- `upstream_modes.test.js` — Claude/OpenAI/Gemini format conversion, token counting (with thinking), Responses API, embeddings, models list, mode conversion, /v1/responses/input_tokens, /v1/responses/compact, /config-reload, openai-responses mode

### 06_integration

- `integration.test.js` — Config load on startup, sequential stats accumulation, health check, CORS headers, models list, token counting, request timeout, timing stats, error format, streaming/non-streaming coexistence, model_timings field, api_key redaction, Access-Control-* CORS headers, PUT config persistence, /tmp/model_proxy_tokens.log persistence

### 07_dashboard

- `dashboard_api.test.js` — GET/PUT /dashboard/api/config, /stats/models, /stats/agents, /stats/requests, POST /test-model (standard + composite alias), HTML page rendering, auth handling

### 08_regression

- `regression.test.js` — Header write crash on exception (fix 3e05fb7), tool_choice auto (fix fdad843), config schema validation (fix 18a1db8), heatmap structure, malformed JSON, empty content, long system prompts, unicode, rapid requests/rate limiting, OpenAI format system, mixed content blocks, zero max_tokens

### 09_composite

- `composite.test.js` — Composite alias behaviors: basic routing, primary routing, fallback ordering, share-weighted distribution (alias discovered dynamically from live config), token_limit config presence, fallback to default upstream for unresolved targets, all configured aliases smoke test, same-name-as-model, share:0 exclusion, token_limit 413 path (creates a temporary alias with limit:1 via PUT then removes it)

### 10_auth

- `auth_headers.test.js` — Auth header flows: x-api-key for /v1/messages, x-goog-api-key for /v1/interactions and generateContent, Authorization: Bearer, API key priority (config over headers), x-api-key as Bearer for openai-completions upstream, missing auth 401

### 11_responses

- `responses_api.test.js` — Responses API: basic, /v1/responses/input_tokens, /v1/responses/compact, image input handling, developer role, stateful fields dropped, streaming, tool use, stateless usage pattern

### 12_config_validation

- `config_validation.test.js` — Config schema validation via PUT /dashboard/api/config: config_errors shape, non-array model value rejected, non-object composite target rejected, 2-element model array rejected, 4-element model array rejected, non-boolean primary rejected, non-finite share/fallback/total_token_limit rejected, non-object composite target value rejected, empty composite target `{}` accepted, non-object models payload rejected, api_key in models payload rejected, empty composite alias `{}` round-trips (survives parse/serialize — the state right after adding an alias via the TUI before targets are chosen)

### 13_fusion

- `fusion.test.js` — Fusion composite alias: TC1301 alias discovery in dashboard, TC1302 non-streaming response shape (id/content/usage), TC1303 streaming SSE event sequence, TC1304 recursion guard (x-fusion-depth: 1 rejected), TC1305 min_panel enforcement (99 > actual panel size fails), TC1306 config round-trip (fusion_options + role survive PUT/GET), TC1307 no-judge degrade (judge_required: false proceeds to synth), TC1308 expose_metadata field present in non-streaming response

## Prerequisites

Tests run against a live proxy instance. The proxy must be started beforehand with all required upstream API keys and features configured.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PROXY_URL` | `http://localhost:8788` | Proxy base URL |
| `API_KEY` | `sk-test-key` | Bearer token sent in `Authorization` header |
| `TEST_TIMEOUT` | `30000` | Per-request timeout in milliseconds |
| `TEST_CONFIG` | _(set by runner)_ | Config file prefix; proxy loads `./${TEST_CONFIG}proxy_config.toml`. Set to `test_` by the runners automatically. |

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

#### `09_composite`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `composite.test.js` | `POST /v1/messages`, `GET /dashboard/api/config`, `PUT /dashboard/api/config` | Any configured composite aliases (discovered dynamically from live config) | Composite alias routing (primary, fallback, share, token_limit, fallback to default upstream); TC1110 temporarily creates a low-limit alias via PUT and cleans it up |

#### `10_auth`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `auth_headers.test.js` | `POST /v1/messages`, `POST /v1/interactions`, `POST /v1beta/models/{model}:generateContent`, `POST /v1/responses`, `POST /v1/embeddings` | any configured model | x-api-key, x-goog-api-key, Authorization: Bearer, config API key priority |

#### `11_responses`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `responses_api.test.js` | `POST /v1/responses`, `POST /v1/responses/input_tokens`, `POST /v1/responses/compact` | `gpt-5.4-mini` (or any configured model) | Responses API basic, input_tokens, compact, image input handling, developer role, stateful fields silently dropped, streaming, tool use, stateless usage pattern |

#### `12_config_validation`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `config_validation.test.js` | `GET /dashboard/api/config`, `PUT /dashboard/api/config` | none (validation is purely schema-level, no upstream calls) | Dashboard config read/write, config schema validation (array length, field types, api_key rejection) |

#### `13_fusion`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `fusion.test.js` | `POST /v1/messages` (stream + non-stream), `GET /dashboard/api/config`, `PUT /dashboard/api/config` | `max-m3`, `max-m2.7-high` (or any two models available via the default upstream) | Fusion composite alias routing (fan-out, judge, synthesis), `fusion_options` config round-trip, recursion guard, `expose_metadata`, streaming SSE |

### Provider API Keys Required

The proxy configuration must have upstream API keys for all of the following providers (tests will 401/500 without them):

- **DeepSeek** — used by messages, thinking, tool_use, models, upstream_modes, integration, regression, auth, responses suites
- **Qwen (Alibaba)** — used by messages, streaming, tool_use, image_input, models, regression suites
- **MiniMax** — used by models suite (or minimax-m3 in active config for composite)
- **Moonshot/Kimi** — used by models suite (or kimi-2.7 in active config for composite)
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
- Composite tests discover aliases dynamically from the live config; no alias names are hard-coded
- Config-mutating tests (09_composite TC1110, 12_config_validation) restore original state after each test case
- TUI interactive features are tested via the dashboard API they call; interactive TTY testing requires manual testing or a terminal automation tool
