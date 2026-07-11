# Judge by `gemini` for test cases coverage matrix review

TIMEOUT_MS=600000 node tests/multi-agents-composite.ts 1 1 4 --model deepseek/deepseek-v4-flash --judge gemini

=== Composite team (pinned via --judge=gemini) ===
  workers: Codex, Claude
  judge:   Gemini

Selection: 1 model(s) x 1 task(s)
  model: deepseek/deepseek-v4-flash
  task:  coverage_matrix

=========== Task: coverage_matrix | Model: deepseek/deepseek-v4-flash ===========
  workers: Codex + Claude
  judge:   Gemini
  tool calls: A=22, B=58
  elapsed: A=129002ms, B=224609ms
  verdict: Claude wins (high)
  reason:  Output A is empty, failing to address the task, while Output B provides a thorough, accurate, and specific coverage matrix with file paths, groupings, and identified gaps, fulfilling all criteria.

--- Winning output (Claude) ---
Now I have a thorough understanding of every test file. Here's the full coverage matrix:

---

## Coverage Matrix: `tests/`

### 1. API Endpoint Tests

| Test File | Endpoint Covered | Streaming? | Auth Variant | Notes |
|---|---|---|---|---|
| `tests/api/v1-messages.sh` | `POST /v1/messages` | ✅ (TC006) | `x-api-key` | 20 test cases (TC001–TC020): basic, multi-turn, system prompt, stop sequences, temperature, tools, thinking, images, token counting, error handling, perf comparison |
| `tests/api/responses.sh` | `POST /v1/responses` | ✅ | `Authorization: Bearer` | Non-stream, stream, tools, and `/v1/responses/compact`; tested against 2 models |
| `tests/api/interactions.sh` | `POST /v1/interactions` | ❌ | `Authorization: Bearer` | String input, multi-turn, response format verification; uses `gemini-2.5-flash` |
| `tests/api/cached-content.sh` | `POST /v1/messages`, `POST /v1/interactions`, `POST /v1beta/models/{model}:generateContent` | ❌ | `x-api-key`, `x-goog-api-key` | Tests `cached_content` / `cachedContent` parameter on all three endpoints |
| `tests/api/sdk/integration.js` | Internal routing logic | ❌ | N/A | Unit-style tests of `parseDynamicRoute` and `buildTargetUrl` for URL patterns without modelId |

### 2. Feature Tests

| Feature | Test File(s) | What's Covered | Gaps |
|---|---|---|---|
| **Routing — exact match** | `tests/features/routing/fixed.js` | `parseDynamicRoute` logic for `qnaigc.com`, `openai.com` endpoints | Static JS unit test, no live proxy integration |
| **Routing — model-based** | `tests/features/routing/model.sh` | Gemini (native) vs MiniMax/DeepSeek (openai-completions) routing via `/v1/messages` | Only `/v1/messages` endpoint; no `/v1/responses` routing test |
| **Routing — wildcard / catch-all** | `tests/features/routing/wildcard.sh` | Priority 1 (exact), Priority 2 (`prefix-*`), Priority 3 (`*` catch-all) | Thorough — covers all three priority levels |
| **Streaming — CLI** | `tests/features/streaming/cli.sh` | `gemini` CLI streaming across 4 models (qwen3, deepseek, gemini, claude) | Relies on the `gemini` CLI binary |
| **Streaming — SSE** | `tests/features/streaming/sse.sh` | SSE streaming on `/v1/messages`, `/v1/chat/completions`, `streamGenerateContent`, `/v1/interactions` across 7+ models | Thorough multi-model, multi-endpoint coverage |
| **Streaming — streamGenerateContent** | `tests/features/streaming/stream-generate.sh` | `:generateContent`, `:streamGenerateContent`, `?alt=sse` query param variants | Very thorough — 8 endpoint variants |
| **Thinking — basic** | `tests/features/thinking/basic.sh` | 10 thinking models × 3 endpoints × 2 (stream/non-stream) = 60 tests | Comprehensive |
| **Thinking — boolean** | `tests/features/thinking/boolean.js` | Unit test of `validateThinkingConfig`, `normalizeThinkingConfig`, `isThinkingEnabled` | Good — covers `true`/`false`/`"enabled"`/`"disabled"`/invalid |
| **Thinking — CLI** | `tests/features/thinking/cli.sh` | 9 thinking models via `gemini` CLI | |
| **Thinking — models** | `tests/features/thinking/models.sh` | 8 models × 3 endpoints, plus streaming + tool-use in thinking context | Also tests `stop_reason: tool_use` fix |
| **Token counting — all models** | `tests/features/token-counting/all-models.sh` | Short text, doc content, source files, model comparison — 4 suites | |
| **Token counting — js-tiktoken** | `tests/features/token-counting/js-tiktoken.js` | Low-level tiktoken encoding/decoding of Chinese text | Very basic demo |
| **Token counting — local perf** | `tests/features/token-counting/local-perf.ts` | Benchmark of 5 tiktoken encodings, 7 text types, 1000 iterations | Solid performance baseline |
| **Token counting — SDK** | `tests/features/token-counting/sdk.ts` | Programmatic TS test of `/v1/messages/count_tokens` endpoint across 5 models | |

### 3. Infrastructure Tests

| Test File | What's Covered |
|---|---|
| `tests/infra/config.sh` | Config loading and server startup with 2 models × 3 endpoints |
| `tests/infra/debug-config.js` | Manual TOML parsing and model routing analysis |
| `tests/infra/shell.sh` | Ad-hoc curl commands for tool-use, streaming, interactions |
| `tests/infra/tool-blocklist.ts` | Unit test of `eraseBlockedTools()` — Claude, OpenAI, Gemini shapes, `tool_choice` reset, empty/blocked-all edge cases |
| `tests/infra/version.sh` | Checks `/health` and `/` endpoints for version field |

### 4. Provider Tests

#### Claude (`tests/providers/claude/`)

| Test File | Covers | Details |
|---|---|---|
| `basic.sh` | `claude-4.6-sonnet`, `claude-4.5-opus`, `claude-4.1-sonnet` in both `anthropic-messages` and `openai-completions` modes | 3 endpoints each |
| `config.sh` | `claude-4.5-sonnet` with config-based routing | |
| `models.sh` | 6 claude models via `gemini` CLI | |
| `modes.sh` | `claude-4.5-sonnet` and `claude-4.5-haiku` in native vs openai-completions modes; `claude-4.1-opus` with alias | |

#### DeepSeek (`tests/providers/deepseek/`)

| Test File | Covers | Details |
|---|---|---|
| `basic.sh` | 4 deepseek models × 3 endpoints | |
| `models.sh` | `deepseek-v3.2`, `deepseek-r1` with streaming, plus `deepseek-r1` all-3-endpoints test | |

#### Gemini (`tests/providers/gemini/`)

| Test File | Covers | Details |
|---|---|---|
| `basic.sh` | 3 gemini models × 3 endpoints, both native and openai-compatible modes | |
| `endpoints.sh` | `gemini-2.5-flash` on all 3 endpoints with model-specific routing | |
| `models.sh` | `gemini-3.1-pro-preview`, `gemini-3.0-flash-preview` + `gemini-2.5-flash` with alias | |
| `modes.sh` | `gemini-2.5-flash` in both modes, 6 tests each (3 non-stream + 3 stream) | |
| `streaming.sh` | SSE streaming in both native and openai-compatible modes | |
| `cli.sh` | Gemini models via gemini CLI + User-Agent detection test | |
| `sdk/api.js` | Programmatic JS test of Gemini Interactions API | |
| `sdk/native.js` | Native Gemini Interactions API format | |
| `sdk/openai-compatible.js` | OpenAI-compatible Gemini wrapper | |
| `sdk/debug.js`, `sdk/simple.js`, `sdk/summary.js` | Debug/legacy tests | |

#### Other Providers

| Provider | Test File | Covers |
|---|---|---|
| **GLM** | `tests/providers/glm/basic.sh` | `z-ai/glm-5` on 3 endpoints with streaming |
| **Llama** | `tests/providers/llama/messages.sh` | 15 test cases (TC01–TC15) for `/v1/messages` with llama model |
| **MiniMax** | `tests/providers/minimax/basic.sh` | `minimax/minimax-m2.5` on 3 endpoints with streaming |

### 5. Multi-Model Integration Tests

| Test File | Description |
|---|---|
| `tests/multi-model/all-models.sh` | Fetches model list from `/v1/models` then tests each model × 2 (non-stream + stream) |
| `tests/multi-model/failed.sh` | Retests previously failed models with alternative key |
| `tests/multi-model/five-models.sh` | 5 models tested in both native and OpenAI-compatible modes |
| `tests/multi-model/three-models.sh` | 3 models across 2 endpoints with different upstream configs |
| `tests/multi-model/two-models.sh` | 2 models with `ALLOWED_HOSTS` env var |
| `tests/multi-model/oversea.sh` | 5 oversea models × 2 modes |

### 6. Multi-Agent SDK Tests

| Test File | Description |
|---|---|
| `tests/multi-agents-test.ts` | 3 agent SDKs (Codex, Claude, Gemini) × 8 models × tasks |
| `tests/multi-agents-composite.ts` | Composite agent setup: judge + 2 workers, seeded RNG, JSON output |

### 7. Performance & Harness

| Test File | Description |
|---|---|
| `tests/perf/benchmark.ts` | Stringify method comparison, converter benchmarks |
| `tests/run-single-test-case.js` | Runner for individual testcase suites |
| `tests/run-tests-loop-wrapper.js` | Wrapper that copies config, runs tests in a loop |
| `tests/scripts/transform-dump.py` | Python script for transforming dump data |

---

## Grouped Summary

| Group | Test Count (approx.) | Coverage |
|---|---|---|
| **API Endpoints** | ~40 scenarios | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/responses`, `/v1/interactions`, `/v1beta/models/{model}:generateContent`, `:streamGenerateContent`, `/v1beta/models/{model}:countTokens` |
| **Routing** | ~30 scenarios | Exact match, prefix-* wildcard, * catch-all, model-based routing, URL parsing |
| **Streaming** | ~50+ scenarios | SSE on all endpoints, alt=sse, streamGenerateContent, CLI streaming |
| **Thinking / Reasoning** | ~80+ scenarios | 10+ thinking models, 3 endpoints, stream + non-stream, tool-use + thinking |
| **Token Counting** | ~30+ scenarios | Short text, doc content, source files, model comparison, local tiktoken, perf |
| **Providers** | ~100+ scenarios | Claude (native + openai), DeepSeek, Gemini (native + openai + sdk), GLM, Llama, MiniMax |
| **Multi-Model** | ~50+ scenarios | All-models sweep, failed retest, 5-model, 3-model, 2-model, oversea |
| **Multi-Agent SDK** | ~50+ runs | Codex/Claude/Gemini SDKs × models × tasks, composite judge |
| **Infrastructure** | ~20 scenarios | Config loading, tool-blocklist, version check, shell helpers |
| **Performance** | ~5 scenarios | Stringify benchmarks |

---

## Coverage Gaps (Features in README with No Test File)

| README Feature | Has Test? | Notes |
|---|---|---|
| **`POST /v1/embeddings`** | ❌ **No test** | Listed in README endpoint table, locked to `openai-completions` — no test file exercises it |
| **`GET /v1/models`** | ⚠️ Implicit only | `/v1/models` is called by `all-models.sh` to fetch the model list, but there's no dedicated test that verifies response format, error handling, or caching |
| **`GET /dashboard`** | ❌ **No test** | Web dashboard JSON API (8 routes) has zero test coverage |
| **Composite aliases** | ❌ **No test** | Weighted random, primary/fallback routing, `token_limit` caps — none tested |
| **Fusion mode** | ❌ **No test** | Fan-out to panel models, judge + synth model — no test coverage |
| **Schedule aliases** | ❌ **No test** | Timetable routing, window matching, fallback target — no test coverage |
| **Sidecars (privacy filter, compression)** | ❌ **No test** | `PRIVACY_FILTER_URL`, `KOMPRESS_URL` env vars — no test exercises either sidecar |
| **Usage accounting / stats** | ❌ **No test** | Per-model token/request stats, terminal dashboard, `GET /dashboard/api/stats` |
| **Token limits (429 on cap)** | ⚠️ Partial | `v1-messages.sh` TC017 does rate-limit concurrency testing, but not the rolling-window token cap described in README |
| **`POST /v1/chat/completions`** | ⚠️ Tested as "should be blocked" | `sse.sh` tests that it returns "not allowed" (unless `DEV_PASS_THROUGH=true`) |
| **Claude-style thinking blocks → OpenAI `reasoning_effort`** | ❌ **No dedicated test** | Thinking tests exercise the endpoint but don't specifically verify the conversion to `reasoning_effort` |
| **`/v1/responses/compact`** | ✅ | Covered in `responses.sh` |
| **`/v1/messages/count_tokens`** | ✅ | `all-models.sh`, `sdk.ts`, `v1-messages.sh` (TC011–TC013) |
| **`GET /health`, `GET /`** | ✅ | `version.sh` |
| **Tool blocklist** | ✅ | `tool-blocklist.ts` — unit test with all 3 API shapes |

### Biggest Gaps (Ranked by Impact)

1. **Composite aliases & Fusion mode** — two of the most distinctive features in the README, zero test coverage. No test exercises weighted random selection, primary/fallback chains, fusion fan-out, or the synth model merge.
2. **Schedule aliases** — another top-level feature with no tests. No verification of window matching, fallback target selection, or timetable resolution.
3. **Dashboard API** — 8 REST endpoints (`GET/PUT /dashboard/api/config`, `POST /dashboard/api/global-token-limit`, 4 schedule CRUD routes, `POST /dashboard/api/test-model`, `GET /dashboard/api/stats`) — entirely untested.
4. **`POST /v1/embeddings`** — listed as a supported endpoint, locked to `openai-completions`, but never exercised.
5. **Sidecars** — privacy filter and compression sidecar logic is entirely untested.

=========== Summary (1 composite runs) ===========
Worker win counts (across all composite runs):
  Claude: 1
