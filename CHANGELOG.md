# Changelog

Historical changes to `model_proxy_v3`. For current usage documentation, see
[README.md](./README.md).

## Latest Changes

Newest merged work, reverse-chronological.

### Tool Blocklist (TUI `P` key)

Added a Tool Blocklist overlay in the TUI that lists every observed
`(tool, agent)` pair with `req` / `resp` / `len` counters. Press `Enter` to
toggle the block state for the highlighted tool; blocked tools are marked
with a red `✗` and stop accumulating stats (existing pre-block counts are
preserved). Blocklist state is in-memory only and resets at proxy restart.
See the **Tool Blocklist (`P`)** section in README for full details.

### TUI keybinding change

The model test picker's "test all (30m)" / "stop test timer" toggle is now
`W`. The `P` key on the main view now opens the Tool Blocklist overlay.

### Security Hardening

A batch of defensive fixes applied after review of the proxy boundary. All
user-facing behavior changes.

- **SSRF protection on internal sidecar URLs** — `PROXY_CONFIG_URL` (Consul
  config source) and `PRIVACY_FILTER_URL` (PII-redaction sidecar) are now
  validated against a new `isInternalHost()` helper (`src/utils/routing.ts`).
  The URL must resolve to `localhost` / `127.x.x.x`, an RFC-1918 range
  (`10/8`, `172.16/12`, `192.168/16`), a link-local range (`169.254/16`,
  `fe80::/10`), an IPv6 ULA (`fc00::/7`), `*.local` (mDNS), or `::1`.
  Anything else (public DNS names, public IPs, exotic schemes) is rejected
  at startup with a descriptive error. This closes the path where a
  misconfigured or attacker-controlled `PROXY_CONFIG_URL` could be used to
  exfiltrate the proxy's outbound traffic.
- **No request body in client-facing error messages** — `handleTargetApiError`
  (`src/utils/errors.ts`) used to append a 300-char preview of the upstream
  request body to the `invalid_request_error` message returned to the client.
  That body can contain user prompts, tool arguments, or PII. The preview is
  now logged server-side only via `logger.debug('errors', ...)`; the client
  gets a generic message.
- **No internal error messages from SDK handlers** — `handleSdkOpenAIRequest`
  and `handleSdkAnthropicRequest` (`src/utils/sdk-handler.ts`) caught
  exceptions and returned `error.message` verbatim to the caller, which
  could leak stack frames, file paths, or upstream error bodies. They now
  return `"An internal error occurred"`; the original error continues to be
  logged.
- **Stricter `anthropic-beta` header handling** — `validateBetaFeatures()`
  (`src/utils/beta-features.ts`) silently forwarded any unknown beta feature
  name upstream. Unknown features are now dropped. Additionally,
  CRLF/control chars are stripped from the header value before forwarding,
  so a header value like `prompt-caching\r\nX-Injected: 1` cannot be used
  to inject extra response headers.
- **Tighter API-key logging** — the partial-key formatter in
  `transformAuthHeadersForUpstream` (`src/utils/routing.ts`) used
  `first16...last8` for `x-goog-api-key`, `x-api-key`, and `Authorization`.
  Reduced to `first4...` (or `***` if shorter than 4 chars). The previous
  window could expose enough entropy to brute-force the prefix.
- **Hardened host allowlist** — wildcard entries in `ALLOWED_HOSTS`
  (`*.example.com`) now require a literal `.` separator before the domain,
  so `*.example.com` no longer matches the apex `example.com`. The wildcard
  rule now correctly rejects suffixes that are not real subdomains.

### Misc bug fixes (bundled with the hardening pass)

- `crypto.randomUUID()` replaces `Math.random()` for `resp_*` and `msg_*`
  IDs in `completions-to-responses.ts` and `responses.ts`.
- `dashboard.ts` uses `??` (not `||`) for `PROXY_CONFIG_PATH`, so an
  explicitly empty string is preserved as a real path instead of falling
  through to `null`.

### Per-(tool, agent) stats and persistence changes

- `agentToolStats` and `blockedTools` fields are now part of the dashboard
  snapshot (`src/handlers/dashboard.ts`) — `agentToolStats` is built by the
  new `getAgentToolPanelStats()` in `src/utils/dashboard-stats.ts`, which
  joins the three source maps (`agentStats`, `toolRequestChars`,
  `upstreamResponseToolStats`) into a per-(tool, agent) row keyed by
  `${tool}\0${agent}`.
- `recordToolRequestChars()` and `recordUpstreamResponseToolNames()` now
  take an `agent` argument; `createResponseToolTrackingTransformStream()`
  now takes an `agent` argument and threads it into the `flush()` callback.
  The Claude request handler (`src/index.ts`) passes the user-agent prefix
  through both call sites.
- `dumpTodayTokens()` writes a new `toolStats` field (per-(tool, agent) rows
  with `name`, `agent`, `req`, `resp`, `len`, `blocked`) in the JSONL token
  log. `loadTokenStatsFromLog()` restores those rows back into the three
  source maps on startup (latest dump per date wins, and the `blocked` flag
  is applied via `blockTool()` so the blocklist survives a restart).
- The cumulative `modelStats` Map (powers TUI "Top Models" +
  `getModelTotalTokens()`) is now also restored from the latest dump per
  date, and is **accumulated** across the latest per-date dumps (each
  per-date dump is that day's totals, so summing reconstructs true
  all-time). Previously only the daily `modelStats` map was restored, and
  the cumulative map was not restored at all.
- `recordAgentStat()`, `recordToolRequestChars()`, and
  `recordUpstreamResponseToolNames()` short-circuit on `blockedTools` so
  blocked tools no longer grow their counters.
- **Blocked tools are erased from the request body before forwarding**: a
  new `eraseBlockedTools()` helper in `src/utils/tool-blocklist.ts` runs at
  the body-parsing chokepoint in `src/index.ts` (right after the privacy
  filter). It strips tool definitions matching the blocklist from the
  `tools` array, supports the Claude / OpenAI / Gemini shapes, deletes the
  `tools` field entirely if the filter would empty it, and resets
  `tool_choice` to `'auto'` if it forces a blocked tool. Past `tool_use` /
  `tool_result` blocks in message history are intentionally left untouched.

### ChatJimmy SDK Made Optional (2026-06-17)

- **src/utils/sdk-handler.ts**: The submodule is imported through a
  non-literal dynamic specifier, so `tsc` no longer treats it as a static
  build/typecheck dependency. The existing try/catch surfaces a missing
  submodule only when an `sdk://` route is hit at runtime.
- **package.json / tsconfig.json / tsconfig.server.json**: Removed the
  unused `chatjimmy-sdk` `imports` entry and TypeScript `paths` aliases
  (nothing in `src/` imported that alias; the handler references `dist/`
  by relative path).
- **Net effect**: clone, `npm install`, `npm run typecheck`, `npm run
  build`, and `npm run server` all succeed without the submodule. See
  [Optional: ChatJimmy SDK](./README.md#optional-chatjimmy-sdk-sdk-models).

### Model Response Time Tracking

The proxy now tracks per-model response time (min/avg/max in ms) alongside
existing per-endpoint timing.

- **Recording**: `recordModelTiming(modelId, elapsedMs)` is called inside
  `runAttempt()` after each request completes (both success and error),
  using the config key (`attemptModelId`) as the timing key — same key
  used by `recordModelStat`/`recordModelUsage`
- **Storage**: `requestModelTimingStats` map (same shape as
  `requestEndpointTimingStats`: `min_time_ms`, `max_time_ms`,
  `total_time_ms`, `count`)
- **Snapshot**: `getDashboardSnapshot()` and `handleDashboardRequestStats()`
  expose `model_timings` in `requestStats`
- **TUI Custom Models**: each configured model shows `[min/avg/maxs]`
  after its description, resolved by matching `routeModel` (upstream name)
  from the config array
- **TUI Composite Aliases**: each target shows `[min/avg/maxs]` after its
  properties, resolved by matching `routeModel` from `compositeResolved`
- **Dashboard HTML**: Model Statistic table has 3 new columns (min(s),
  avg(s), max(s)) joined from `model_timings` keyed by the resolved
  upstream model name

### Composite Fallback to Default Upstream

Composite aliases now support unresolved target models by falling back to
the default upstream route (`getDefaultModelRoute`) while preserving the
target model as `modelAlias`. This allows aliases such as `code-small` to
route even when the target is not explicitly declared in `models.*`.

### Messages Format Detection Fix (Claude blocks vs OpenAI passthrough)

`/v1/messages` request detection now treats block-style Claude content
(`content: [{type:"text"|"tool_use"|"tool_result"|"thinking", ...}]`) as
Claude format, forcing Claude→OpenAI conversion for `openai-completions`
upstreams. This prevents malformed passthrough payloads to
`/v1/chat/completions`.

### Dashboard Side-Nav Active Style

The active side navigation item in `/dashboard` now has a visible border
(light gray) for clearer section focus.

### Config Reload Endpoint Rename

The config reload endpoint is now `/config-reload` (previously `/reload`).

### Token Counting Toggle Simplification

Removed `LOCAL_TOKEN_COUNTING`. Local token counting is now controlled
only by `LOCAL_TIKTOKEN` (`true`/`1` enables tiktoken-based local
counting). If API-based token counting fails, the proxy falls back to
byte-based counting for user text.

### TOML Parser Regex Order Fix

The `parseSimpleToml()` function in `config-loader.ts` checked
`unquotedMatch` (regex `key = (.+)`) before `arrayMatch` (regex `key =
[...]`). For model IDs containing only hyphens and underscores (e.g.,
`deepseek-v4-flash`), the greedy `unquotedMatch` captured the array
value but silently discarded it since `models` sections are not in its
handling scope. Models with dots (e.g., `gpt-5.4-mini`) were unaffected
because `.` is outside the `[a-zA-Z0-9_-]` character class. Fixed by
swapping the check order — `arrayMatch` is now evaluated before
`unquotedMatch`, with a comment explaining the ordering constraint. This
fixes composite model resolution (e.g., `code-small` → `deepseek-v4-flash`)
where the candidate model key was previously never found in its category.

### Thinking Block Validation Field Fix

`ThinkingBlock` type defines field `thinking: string`, but
`validateClaudeContentBlock()` in `validation.ts` was checking `block.text`
for `type: "thinking"` blocks. This caused validation to throw `text is
required for thinking blocks` when Claude CLI sent requests with thinking
content blocks in assistant messages (the field is `thinking`, not `text`).
Fixed by changing the check to `block.thinking`.

### Upstream Error Diagnostics

The proxy now reads and logs upstream error response bodies in
`handleClaudeRequest` before throwing, making it possible to diagnose
API-level errors (e.g., DeepSeek returning 400 about thinking mode).

### DeepSeek Thinking Mode Compatibility

Some upstreams (e.g., DeepSeek's Anthropic-compatible API) internally
default models to thinking mode and require prior `content[].thinking`
blocks in the conversation even on the first request. The proxy now:

- Defaults `thinking` to `disabled` when the client doesn't set it
- Strips `thinking: { type: "enabled" }` when there are no prior
  assistant thinking blocks in the conversation history (avoids 400
  errors on first requests)

### Full Request Body Logging

Added debug-level logging of the full request body sent to upstreams in
`handleClaudeRequest` for easier troubleshooting.

### Thinking Signature Support & Streaming Improvements

- **Signature Delta Events**: Added full `signature_delta` support for
  thinking block verification in streaming
- **OpenAI-to-Claude Conversion**: Enhanced conversion of OpenAI's
  `reasoning_item_id` and `signature` to Claude's thinking format
- **Streaming Thinking Extraction**: Improved thinking content extraction
  from `<thinking>` markers and `reasoning_content` fields
- **Thinking Block Lifecycle**: Proper `content_block_start/delta/stop`
  events for thinking blocks in streaming

### Gemini `:countTokens` Endpoint

Added routing for `POST /v1beta/models/{model}:countTokens` and
`POST /v1/models/{model}:countTokens`. The request body is proxied as-is
to the upstream Gemini API and the raw JSON response (`totalTokens`) is
returned. Previously these paths fell through to an "Unsupported fixed
route" error (HTTP 500).

### OpenAI Handler Error Propagation Fix

`handleOpenAIRequest` previously threw a plain `Error` on upstream
non-2xx responses, which the outer error handler converted to HTTP 500
regardless of the actual upstream status. For streaming requests, it
silently returned HTTP 200 with the error wrapped in an SSE frame. Both
paths now use `handleTargetApiError()`, propagating the correct upstream
status code (401, 403, 429, etc.) to the client — matching the behavior
of the Claude and Gemini handlers.

---

## 2026-03-04 — ChatJimmy SDK Integration

**Optional, lazily-loaded submodule**: ChatJimmy SDK lives in
`submodules/chatjimmy` and is loaded at runtime via dynamic import only
when an `sdk://` model is requested. It is not required to build or run
the proxy.

**SDK Handler**: `src/utils/sdk-handler.ts` provides SDK-based request
handling:

- **SDK URL detection**: `sdk://` URLs use chatjimmy SDK clients instead
  of HTTP fetch
- **OpenAI-compatible mode**: `handleSdkOpenAIRequest()` uses
  `OpenAICompatibleClient`
- **Anthropic-compatible mode**: `handleSdkAnthropicRequest()` uses
  `OpenAICompatibleClient` as fallback
- **Streaming support**: SDK Anthropic stream is converted from OpenAI
  chunks to Claude SSE event format (`message_start`, `content_block_*`,
  `message_delta`, `message_stop`)
- **Streaming fallback**: If SDK stream is unavailable, falls back to
  non-stream response

---

## 2026-03-03 — Enhanced Thinking Configuration

- **Type Definitions**: Updated `ThinkingConfigParam` type to accept
  `boolean` values (`true`/`false`) in addition to string values
  (`"enabled"`/`"disabled"`)
- **Normalization Utility**: Added `normalizeThinkingConfig()` function to
  standardize thinking config across the codebase
- **Token Counting**: Updated token counting logic to handle boolean
  thinking types
- **Validation**: Enhanced validation to accept boolean values while
  maintaining backward compatibility

## 2026-03-03 — Thinking Signature Support

- **Signature Delta Events**: Added `"signature_delta"` to
  `ClaudeStreamEvent.delta.type` for streaming signature verification
- **Streaming Signature Emission**: Implemented `signature_delta` event
  emission before `content_block_stop` for thinking blocks
- **Signature Accumulation**: Accumulates signatures from multiple
  sources: `delta.signature`, `reasoning_item_id`, and `signature` fields
- **OpenAI-to-Claude Conversion**: Converts OpenAI's `reasoning_item_id`
  and `signature` to Claude's `signature_delta` format
- **Anthropic Pass-Through**: Passes through `signature_delta` events
  from Anthropic upstream unchanged
- **Non-Streaming Compatibility**: Includes signature in thinking block
  metadata for non-streaming responses

**Files modified** (covers the Model Response Time Tracking, Thinking
Signature Support, and adjacent changes):

- `src/utils/dashboard-stats.ts` — added `requestModelTimingStats` map,
  `recordModelTiming()`, `getRequestModelTimingStatsDesc()`
- `src/index.ts` — `recordModelTiming(attemptModelId, elapsedMs)` called
  inside `runAttempt()` for all requests
- `src/handlers/dashboard.ts` — `model_timings` in snapshot/API, 3 new
  columns (min/avg/max) in HTML model stats table and CSV export
- `src/tui.ts` — timing display (`[min/avg/maxs]`) in Custom Models
  section and Composite Aliases overlay
- `src/types/claude.ts` - Added `"signature_delta"` to stream event types
- `src/converters/streaming.ts` - Added signature accumulation and
  emission logic
- `src/converters/openai-to-claude.ts` - Enhanced signature extraction
  from response metadata

## 2026-03-03 — Gemini v1 Endpoint Support

- **Path Pattern Matching**: Updated regex patterns to support both
  `/v1beta/models/` and `/v1/models/` endpoints
- **URL Building**: Enhanced URL construction logic for both v1beta and
  v1 endpoints
- **Model Extraction**: Improved model ID extraction from both endpoint
  versions

## 2026-03-03 — API Key Management

- **Priority Logic**: Added intelligent API key priority based on
  upstream mode
- **Format Utility**: Created `formatApiKeyForUpstream()` function for
  consistent header formatting
- **Header Transformation**: Enhanced
  `transformAuthHeadersForUpstream()` to handle `Bearer` prefix stripping
- **Configuration Integration**: Better integration of config API keys
  with request processing

**Files modified** (covers the Enhanced Thinking Configuration, Gemini v1
Endpoint Support, and API Key Management changes):

- `src/converters/claude-to-gemini.ts` - Added boolean thinking support
  for Gemini conversion
- `src/converters/claude-to-openai.ts` - Added boolean thinking support
  for OpenAI conversion
- `src/index.ts` - Enhanced routing for v1 endpoints, API key priority
  logic
- `src/types/claude.ts` - Updated ThinkingConfigParam type definition
- `src/utils/routing.ts` - Added `formatApiKeyForUpstream()`, enhanced
  path matching
- `src/utils/thinking.ts` - Added normalization utility, updated all
  thinking functions
- `src/utils/token-counting.ts` - Updated to handle boolean thinking
  types
- `src/utils/validation.ts` - Enhanced validation for boolean thinking
  values

---

## 2026-02-28 — Gemini CLI Config Integration

Successfully tested proxy using **Gemini CLI configuration** from
`~/.gemini/.env`. All models work with the CLI's base URL and API key
settings.

**Gemini CLI Config Test Results:**

| Test Suite       | Models Tested | Passed | Success Rate |
|------------------|---------------|--------|--------------|
| Basic Models     | 10            | 9      | 90%          |
| Gemini Models    | 3             | 3      | 100%         |
| Claude Models    | 6             | 5      | 83.3%        |
| Thinking Models  | 10            | 7      | 70%          |
| **Total**        | **29**        | **24** | **82.8%**    |

**Basic Models (90% success):**

- deepseek/deepseek-v3.1
- deepseek-r1
- minimax/minimax-m2.1
- moonshotai/kimi-k2.5
- minimax/minimax-m2.5
- qwen3-32b
- deepseek/deepseek-v3.2-exp
- z-ai/glm-4.7
- moonshotai/kimi-k2-0905
- z-ai/glm-5 (upstream issue)

**Gemini Models (100% success):**

- gemini-2.5-flash
- gemini-3.1-pro-preview
- gemini-3.0-flash-preview

**Claude Models (83.3% success):**

- claude-4.6-sonnet
- claude-4.5-opus
- claude-4.5-haiku
- claude-4.0-sonnet
- claude-3.7-sonnet
- claude-4.1-sonnet (invalid request)

**Thinking Models (70% success):**

- deepseek/deepseek-v3.2-exp-thinking
- deepseek/deepseek-v3.1-terminus-thinking
- deepseek-r1-0528
- qwen3-30b-a3b-thinking-2507
- qwen3-next-80b-a3b-thinking
- doubao-1.5-thinking-pro
- moonshotai/kimi-k2-thinking
- qwen3-vl-30b-a3b-thinking (upstream unavailable)
- qwen3-235b-a22b-thinking-2507 (upstream unavailable)
- doubao-seed-1.6-thinking (upstream unavailable)

**Key Findings:**

- Proxy works seamlessly with Gemini CLI config (`~/.gemini/.env`)
- Uses `GOOGLE_GEMINI_BASE_URL` and `GEMINI_API_KEY` from CLI config
- 82.8% overall success rate across 29 models from 6+ providers
- All Gemini models (100%) and most Claude models (83.3%) working
- All thinking models show step-by-step reasoning
- SSE streaming: complete message boundaries guaranteed (fixed 2026-03-02)
- 5 failures: 1 upstream issue, 1 invalid request, 3 unavailable models

**Test scripts:**

- `test_gemini_cli.sh` - Basic models test (10 models)
- `test_gemini_models_cli.sh` - Gemini models test (3 models)
- `test_claude_models_cli.sh` - Claude models test (6 models)
- `test_thinking_cli.sh` - Thinking models test (10 models)

## 2026-02-28 — Unconfigured Models Validated

Successfully tested proxy with **no specific model IDs configured** in
`proxy_config.toml`. All models used fallback configuration from
`[models.default]` and `[upstream]` sections.

**Test Results: 100% Success (24/24 tests passed)**

| Test Suite      | Models | Tests | Passed | Success Rate |
|-----------------|--------|-------|--------|--------------|
| DeepSeek Models | 2      | 6     | 6      | 100%         |
| Thinking Models | 4      | 12    | 12     | 100%         |
| SSE Streaming   | 2      | 6     | 6      | 100%         |
| **Total**       | **8**  | **24**| **24** | **100%**     |

**Key Findings:**

- Unconfigured models work perfectly with default settings
- All 3 endpoints supported: `/v1/messages`, `/v1/interactions`,
  `generateContent`
- SSE streaming works for all endpoints
- Thinking/reasoning models work without special configuration
- Fallback chain validated: `[models.default]` → `[upstream]` →
  hardcoded defaults

See `docs/test_results_unconfigured_models.md` for complete details.

## 2026-02-28 — ENV Variables Removed

Removed `FIXED_ROUTE_TARGET_URL` and `FIXED_ROUTE_PATH_PREFIX` environment
variables. All configuration now in `proxy_config.toml`:

**Configuration hierarchy for unconfigured models:**

```
1. [models.default].upstream_mode / base_url / api_key
   ↓ (if missing)
2. [upstream].upstream_mode / default_base_url / default_api_key
   ↓ (if missing)
3. Configurable fallback: "openai-completions" / "https://api.qnaigc.com"
   (hardcoded in src/utils/config-loader.ts, src/index.ts, and src/tui.ts;
    override by setting [upstream].default_base_url or [models.default].base_url
    in proxy_config.toml — there is no env var to override this final fallback)
```

See `docs/config_env_removal.md` for migration guide.

## 2026-02-27 — Config Structure Updated

The routing logic and configuration structure have been revised to align
implementation with documentation:

- **Category-based config**: Models grouped by provider with inheritance
- **Array format**: `["model-alias", "base-url", "api-key"]` with empty
  string inheritance
- **Explicit upstream_mode**: `anthropic-messages`,
  `gemini-generatecontent`, `openai-completions`
- **No normalization**: Model names preserved as-is (e.g.,
  `"deepseek/deepseek-v3.2"`)

See `docs/routing_config_revision.md` for complete details.

## 2026-02-25 — Comprehensive Testing (Production Ready)

See [README.md § Testing](./README.md#-testing) for the consolidated test
result tables and provider success rates. Detailed per-suite breakdowns
live in `docs/test_results_*.md` and `docs/*_test_results.md`.
