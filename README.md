# Model Proxy v3

One proxy, three API schemas. Talk to **Claude**, **Gemini**, and **OpenAI-compatible**
models through a single endpoint, no matter which API format your client speaks.

The proxy accepts requests in the Claude, Gemini, or OpenAI Responses format,
converts them for whatever upstream provider you've configured, and converts the
response back. It also handles model aliasing, routing, fallback, and basic usage
accounting out of the box.

```
                  Claude / Gemini / OpenAI SDK
                               │
                               ▼
                        ┌─────────────┐
    sidecar plugins <-  │ Model Proxy │   ←  routes by model id or wildcard
                        └─────────────┘
                               │
                  ┌────────────┼────────────┐
                  ▼            ▼            ▼
             Anthropic     Gemini      OpenAI-Compatible
             upstream     upstream     upstream(s)
```

## Features

- **Four API formats in, any provider out** — accept requests in any of these schemas:
  - `/v1/messages` — Claude Messages API
  - `/v1beta/models/{model}:generateContent` — Gemini GenerateContent API
  - `/v1/interactions` — Gemini Interactions API
  - `/v1/responses` — OpenAI Responses API
- **Model-based routing** — route each model name to its own upstream URL, API key,
  and protocol via a simple TOML config. Exact model keys are supported in every
  `[models.*]` category; provider wildcards (`claude-*`) and the final catch-all
  (`*`) are scoped as described in [Model Routing](#model-routing).
- **Composite aliases** — group several models under one name with weighted random,
  primary/fallback, or automatic retry-on-failure routing.
- **Fusion mode** — fan one request out to multiple models in parallel, then have a
  "synth" model write the final answer.
- **Schedule aliases** — timetable-based routing: pick which model (or composite)
  serves a request based on server-local hour-of-day and day-of-week, with a
  fallback target for any time outside the configured windows.
- **Extended thinking / reasoning** — Claude-style thinking blocks, with conversion to
  OpenAI `reasoning_effort` for upstreams that need it.
- **Usage accounting** — per-model token and request stats, viewable in a web dashboard
  or a live terminal UI.
- **Token limits** — global and per-alias rolling-window caps that return HTTP 429 when hit.
- **Sidecars** — optional privacy-filter and compression sidecars for redacting or
  shrinking request payloads before they reach the upstream.
- **Runs anywhere** — Node.js server, Docker, PM2, or Cloudflare Workers.

## Quick Start

### 1. Install

```bash
git clone <repo-url>
cd model_proxy_v3
npm install
```

### 2. Configure

Copy the example config and edit it:

```bash
cp proxy_config.toml_example proxy_config.toml
```

A minimal `proxy_config.toml` looks like this:

```toml
# Global upstream defaults — applied ONLY to models that are NOT claimed by
# any `[models.*]` category section below. A model name that falls through
# every section's exact / wildcard / catch-all lookup gets routed here.
[upstream]
default_base_url = "https://api.your-provider.com"
# default_api_key = "your-key"   # config fallback; caller auth still wins outside [models.free]

# Claude models, spoken to in native Anthropic format
[models.claude]
upstream_mode = "anthropic-messages"
base_url = "https://api.anthropic.com"
api_key = "your-claude-key"
"claude-sonnet-4-6" = {}                    # exact entry; inline table {target, base_url, api_key, mode} — empty fields inherit from section
"claude-*" = {}                             # prefix wildcard — catch-all for every other claude-* model

# Gemini models, spoken to in native Gemini format
[models.gemini]
upstream_mode = "gemini-generatecontent"
base_url = "https://generativelanguage.googleapis.com"
api_key = "your-gemini-key"
"gemini-*" = {}

# Everything else goes here (OpenAI-compatible). Empty entry fields inherit
# from the section, then from `[upstream]` defaults.
[models.default]
upstream_mode = "openai-completions"
base_url = "https://api.your-provider.com"   # section base_url overrides [upstream].default_base_url
"*" = {}                                     # final catch-all for this section
"deepseek/deepseek-v3.2" = {}
```

Key ideas:

- **Categories** group models by provider: `[models.claude]`, `[models.gemini]`,
  `[models.default]`, etc.
- **`upstream_mode`** picks the protocol: `anthropic-messages`, `gemini-generatecontent`,
  `gemini-interactions`, `openai-completions`, or `openai-responses`.
- **`sdk://` target URLs** route supported Claude/OpenAI upstream calls through the
  local SDK handler instead of plain HTTP fetch, while still using the configured
  `upstream_mode` for request/response shape.
- **Per-model overrides** use an inline table: `"my-model" = {target = "real-name", base_url = "...", api_key = "..."}`.
  Empty fields inherit from the category.

> **Note — `anthropic-messages` and extended thinking:**
> When `upstream_mode = "anthropic-messages"` is used with a third-party Anthropic-compatible
> endpoint (e.g. MiniMax at `api.minimaxi.com/anthropic`), the proxy passes the client's
> `thinking` field through as-is. If the client sends `{"type": "adaptive"}` the upstream
> model will respond with thinking blocks; if the client omits `thinking` entirely, the proxy
> injects `{"type": "disabled"}` as a safe default (needed for DeepSeek-compatible endpoints
> that otherwise default to thinking mode). On a **fresh conversation** (no prior assistant
> turns containing thinking blocks), a client-sent `{"type": "enabled"}` will be silently
> dropped — use `"adaptive"` instead, which the model handles autonomously.

> **Note — `thinking.budget_tokens` vs `max_tokens`:** on `POST /v1/messages` and
> `POST /v1/messages/count_tokens`, when `thinking` is enabled the validator reduces
> `thinking.budget_tokens` down to `max_tokens` if the budget would otherwise exceed it.
> If you send `anthropic-beta: interleaved-thinking-2025-05-14`, the budget is left
> unchanged (interleaved thinking may consume the full context window). If `max_tokens`
> is below `1024` with thinking enabled and a non-null budget, validation throws with
> a message explaining the minimum.

> **Note — `kimi-k2.7-code` and `thinking_budget` collision:** Moonshot's
> `kimi-k2.7-code` maps `reasoning_effort: "medium"` to a fixed
> `thinking_budget = 32768`, so any request with `max_tokens ≤ 32768` fails with
> `InvalidParameter: max_completion_tokens [N] must be greater than thinking_budget [32768]`.
> Under `[upstream]`, set `budget_to_effort_high = 0` — the proxy then emits
> `reasoning_effort: "high"` for any thinking budget. if set 
> `budget_to_effort_low = 32768`
> `budget_to_effort_medium = 65536`
> `budget_to_effort_high = 128000`
> map `reasoning_effort: "low"` would avoid the limit of `kimi-k2.7-code`.
- **Wildcards** (`claude-*`) apply only in the provider/default sections listed in
  [Model Routing](#model-routing); the **catch-all** (`*`) is only the final
  `[models.default]` fallback for anything not claimed earlier.

See [`proxy_config.toml_example`](./proxy_config.toml_example) for a fully commented config
covering every section and option.

### 3. Run

```bash
npm run server        # starts on http://localhost:8788
```

Send a request:

```bash
curl http://localhost:8788/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-key" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

The proxy reads `proxy_config.toml` from the working directory by default. Point it
elsewhere with `PROXY_CONFIG_PATH=./other.toml npm run server`. Change the port with
`PORT=7777`.

### 4. Watch live stats (optional)

Start with the terminal dashboard:

```bash
TUI=true npm run server
```

You get a live view of configured models, token usage, response times, and tool stats.
Press `c` to edit composite aliases, `s` to edit schedule aliases, `t` to send a test
request, `r` to reload config, `Ctrl+C` to quit. A web dashboard is also available at
`GET /dashboard`.

When `TUI=true` or `DUMP=true` is set, token stats are appended to
`model_proxy_tokens.jsonl` in the working directory. Each line is one JSON dump:

```json
{
  "date": "2026-07-15",
  "timestamp": 1784112345,
  "lastDumpTs": 1784109999,
  "modelStats": [
    {
      "model": "claude-sonnet-4-6",
      "requests": 12,
      "failed_requests": 0,
      "input_tokens": 12345,
      "cached_tokens": 0,
      "cache_written_tokens": 0,
      "output_tokens": 6789,
      "total_tokens": 19134
    }
  ],
  "toolStats": [
    { "name": "Read", "agent": "unknown", "req": 3, "resp": 1, "len": 2048, "blocked": 0 }
  ],
  "heatmapEvents": {
    "models": { "ab12": "claude-sonnet-4-6" },
    "sequences": [{ "ts": 1784112300, "values": 19134, "id": "ab12" }]
  }
}
```

Fields:
- `date`: local `YYYY-MM-DD` bucket for the dump.
- `timestamp`: dump time in Unix seconds.
- `lastDumpTs`: previous dump timestamp. `0` means a full snapshot; non-zero means
  `heatmapEvents` is a delta since that timestamp.
- `modelStats`: cumulative per-model totals for that date.
- `toolStats`: optional cumulative per-tool/per-agent totals.
- `heatmapEvents`: token events used for the Tokens Panel and rolling global token
  limit. Current files use the compact `{models, sequences}` shape, where model
  names are mapped to short ids and each sequence stores `{ts, values, id}` in Unix
  seconds. Older files with `heatmapEvents: [{timestamp, values, model}]` are still
  accepted.
- `compositeLimitWindows`: optional persisted per-alias rolling-window state, written
  by day-rollover/full-snapshot dumps.

On startup, the proxy avoids double-counting persisted stats as follows:
- `modelStats`, `toolStats`, and `compositeLimitWindows` are loaded only from the
  latest dump for each retained date because they are cumulative snapshots.
- `modelStats` from those latest per-day dumps are summed across days to rebuild the
  all-time dashboard totals.
- `heatmapEvents` are loaded from all retained rows, because delta rows and multiple
  proxy instances can contain different events. The loader skips events older than
  the retention cutoff, skips events at or before a row's non-zero `lastDumpTs`, and
  deduplicates by `timestamp:values:modelId` before adding them to memory.

## API Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /v1/messages` | Claude Messages API |
| `POST /v1/messages/count_tokens` | Count tokens (Claude/OpenAI format) |
| `POST /v1/responses` | OpenAI Responses API |
| `POST /v1beta/models/{model}:generateContent` | Gemini content (also `:streamGenerateContent`, `:countTokens`) |
| `POST /v1/interactions` | Gemini Interactions API |
| `POST /v1/embeddings` | Embeddings (proxied to an OpenAI-compatible upstream) |
| `GET /v1/models` | List available models |
| `GET /dashboard` | Web dashboard for config + stats |

A Gemini `/v1/models/{model}:...` variant exists for each `/v1beta/models/{model}:...`
endpoint. `:countTokens` is supported too: native Gemini routes forward to Gemini
`countTokens`, while non-Gemini upstream modes are bridged through the proxy's token-counting path.
Full request/response examples live in the [API reference docs](#documentation).

### Supported `upstream_mode`

Each endpoint can be routed to one or more upstream API families (`upstream_mode`).
The mode is selected by the route's `defaultMode` / model config:

| Client endpoint | `anthropic-messages` | `openai-completions` | `openai-responses` | `gemini-generatecontent` | `gemini-interactions` |
|---|---|---|---|---|---|
| `POST /v1/messages` | **Native passthrough** to `/v1/messages`; request stays Claude Messages format end-to-end. | **Direct transform**: Claude Messages → Chat Completions → Claude Messages. If input is already OpenAI-shaped, it can pass through. | **Direct transform**: Claude/OpenAI-chat-shaped request → Responses `input` → Claude Messages. Basic tools and streaming are supported; `max_tokens` is rewritten to `max_completion_tokens`. | **Direct transform**: Claude Messages → Gemini generateContent → Claude Messages. | **Direct transform**: Claude Messages → Gemini Interactions/generateContent-compatible upstream → Claude Messages. |
| `POST /v1/responses` | **Direct transform**: Responses `input`/`instructions` → Claude Messages → Responses. Text and tool-use are supported for non-streaming and streaming. | **Direct transform**: Responses → Chat Completions → Responses. For `api.qnaigc.com`, keeps legacy `max_tokens`; otherwise uses `max_completion_tokens`. | **Native passthrough** to `/v1/responses`. | **Direct transform via Claude Messages**: Responses → Claude Messages → Gemini generateContent → Claude Messages → Responses. | **Direct transform via Claude Messages**: Responses → Claude Messages → Gemini Interactions/generateContent → Claude Messages → Responses. |
| `POST /v1/chat/completions` | Not supported. | **Native passthrough** only when `DEV_PASS_THROUGH=true`; otherwise rejected. Uses the resolved per-model route when configured. | **Transform passthrough** only when `DEV_PASS_THROUGH=true`; Chat Completions body is converted to Responses `input` and forwarded to `/v1/responses` using the resolved per-model route. | Not supported. | Not supported. |
| `POST /v1beta/models/{model}:generateContent` / `:streamGenerateContent` | **Indirect transform via `openai-completions`**: generateContent → Chat Completions → Claude Messages → generateContent. Forwards upstream to `/v1/messages`; text, tool calls, and streaming text deltas return as Gemini `candidates[].content.parts`; tool calls become `functionCall` parts. | **Direct transform**: generateContent → Chat Completions → generateContent. Forwards upstream to `/v1/chat/completions`. | **Indirect transform via `openai-completions`**: generateContent → Chat Completions → Responses `input` → generateContent. Forwards upstream to `/v1/responses`; `system`/`developer` messages become Responses `instructions`; content-part arrays are normalized to text. | **Native passthrough** to `:generateContent` / `:streamGenerateContent` using the configured Gemini API version. | **Native Gemini-family route**; forwards to Gemini generateContent/stream endpoint using Interactions-compatible mode. |
| `POST /v1/interactions` | **Indirect transform via `openai-completions`**: Interactions → Chat Completions → Claude Messages → Interactions. Forwards upstream to `/v1/messages`; text, tool calls, and streaming text deltas return in Interactions shape. | **Direct transform**: Interactions → Chat Completions → Interactions. Forwards upstream to `/v1/chat/completions`. | **Indirect transform via `openai-completions`**: Interactions → Chat Completions → Responses `input` → Interactions. Forwards upstream to `/v1/responses`; `system`/`developer` messages become Responses `instructions`; content-part arrays are normalized to text. | **Native Gemini-family route**; forwards to Gemini generateContent/stream endpoint. | **Native Gemini-family route**; forwards to Gemini generateContent/stream endpoint using Interactions-compatible mode. |
| `GET /v1/models` | Passthrough model listing; no `upstreamMode` conversion is applied. | Passthrough model listing; no `upstreamMode` conversion is applied. | Passthrough model listing; no `upstreamMode` conversion is applied. | Passthrough model listing; no `upstreamMode` conversion is applied. | Passthrough model listing; no `upstreamMode` conversion is applied. |
| `POST /v1/embeddings` | Not supported. | **Only supported mode**; forwards to OpenAI-compatible embeddings upstream. | Not supported. | Not supported. | Not supported. |

Notes:
- **Native passthrough** means the client endpoint and upstream API family already match, so the request body is not converted to another provider's format.
- **Direct transform** means the proxy converts directly between the client endpoint format and the selected upstream family, then converts the response directly back to the client endpoint shape.
- **Direct transform via Claude Messages** means Responses uses Claude Messages as its internal bridge before calling Gemini; it does not go through `openai-completions`.
- **Indirect transform via `openai-completions`** means Gemini endpoint input first becomes OpenAI Chat Completions, then becomes Claude Messages or OpenAI Responses. This reuses the Chat Completions middle mode while preserving the original Gemini endpoint response shape.
- Direct transforms are preferred long-term for endpoint fidelity. The current `/v1/interactions` → `anthropic-messages` / `openai-responses` routes use the indirect `openai-completions` bridge for code reuse; see [Routing transform review](./docs/routing-review.md) for tradeoffs and recommendations.

### OpenAI prompt caching fields

The proxy only preserves OpenAI prompt-caching controls when the target mode can carry them without changing prompt structure. Cross-mode conversion preserves the top-level routing key, but not request-wide cache policy or content-block breakpoints.

| Client endpoint | `upstream_mode` | `prompt_cache_key` | `prompt_cache_options` | `prompt_cache_breakpoint` |
|---|---|---|---|---|
| `POST /v1/responses` | `openai-responses` | Preserved | Preserved | Preserved |
| `POST /v1/responses` | `openai-completions` | Preserved | Dropped | Dropped during `input` → `messages` conversion |
| `POST /v1/chat/completions` | `openai-completions` | Preserved | Preserved | Preserved |
| `POST /v1/chat/completions` | `openai-responses` | Preserved | Dropped | Dropped during `messages` → Responses `input` / `instructions` conversion |

### Dashboard API

The `/dashboard` web UI is driven by a small JSON API. Dashboard/admin routes
are restricted to loopback clients by the Node server adapter. To also require a
bearer token for the JSON API, set:

```toml
[dashboard]
api_key = "your-dashboard-key"
```

When `dashboard.api_key` is configured, every `/dashboard/api/*` route requires
`Authorization: Bearer <dashboard.api_key>`. `GET /dashboard` remains loadable
from loopback without auth. The browser dashboard prompts for the key on the
first API `401`, sends dashboard API requests sequentially, stores the key in
browser `localStorage`, and expires the saved key after 7 days. The `/dashboard`
HTML response uses no-cache headers so browser users get the latest dashboard
script. If `dashboard.api_key` is omitted or empty, dashboard APIs keep the old
loopback-only behavior.

| Endpoint | Purpose |
|---|---|
| `GET /dashboard/api/config` | Read current config snapshot; `?reload=1` re-reads the TOML file |
| `PUT /dashboard/api/config` | Replace the whole config snapshot (also auto-saves the TOML) |
| `POST /dashboard/api/global-token-limit` | Set / update the global rolling-window token cap |
| `POST /dashboard/api/schedule/alias` | Add a new `[schedule]` alias (body: `{alias: string}`) |
| `DELETE /dashboard/api/schedule/alias/:alias` | Remove a `[schedule]` alias |
| `POST /dashboard/api/schedule/alias/:alias/target` | Upsert a target's window list (body: `{target, windows}`) |
| `DELETE /dashboard/api/schedule/alias/:alias/target/:target` | Remove a target from an alias |
| `POST /dashboard/api/test-model` | Send a test request through a configured model |
| `GET /dashboard/api/stats/models` | Per-model token and request stats |
| `GET /dashboard/api/stats/agents` | Per-agent request stats |
| `GET /dashboard/api/stats/requests` | Endpoint, upstream, status-code, timing, and tool-response stats |
| `GET /dashboard/api/tools/blocklist` | Read the current tool blocklist |
| `POST /dashboard/api/tools/toggle-block` | Block or unblock a tool by name |

The four `schedule/*` routes are the dedicated CRUD for `[schedule]` aliases;
mutations also round-trip through the TOML file so the change persists across restarts.

**Stats are keyed by resolved upstream model id, not the alias/target key.**
A `[models.*]` entry like `max-m3 = {target = "MiniMax-M3", ...}` is looked up
under the key `max-m3`, but every request routed through it — including
`requests`/`failed_requests` counts and all token counters — is recorded
against `MiniMax-M3` (the resolved `target`), because that's the model id
actually sent upstream. If a `[models.*]` entry has no explicit `target`
(so key == resolved model id), this distinction doesn't matter. But when
`target` differs from the key, check stats under the `target` value, not
the alias key, if a row looks stuck at zero requests/tokens despite live traffic.

## Model Routing

### Category lookup priority

Each `[models.<category>]` section groups models by provider. An incoming model name is
resolved against the configured sections in three priority levels (highest first):

| Priority | Lookup | Where it's checked |
|:--------:|:-------|:-------------------|
| 1 | **Exact key** match | All `[models.*]` sections |
| 2 | **`prefix-*` wildcard** | `models.claude`, then `models.gemini`, then `models.gpt` |
| 3 | **`*` catch-all** | `models.default` |

- An exact entry always wins over a wildcard in the same category — e.g. an explicit
  `claude-sonnet-4-6` is matched before `claude-*`.
- Only provider wildcard sections (`models.claude`, `models.gemini`, `models.gpt`) and
  optional `models.default` wildcards are checked for `prefix-*` matches. Other sections,
  including `models.free` and `models.embedding`, are exact-only.
- Only `prefix-*` (hyphen before `*`) is a wildcard; the `*` is substituted so the
  upstream sees the real model name. A bare `*` key is the final `models.default`
  catch-all and preserves the original model name.

| Section | Exact | `prefix-*` | `*` catch-all |
|:--------|:-----:|:----------:|:-------------:|
| `models.claude` | ✅ | ✅ | ❌ |
| `models.gemini` | ✅ | ✅ | ❌ |
| `models.free` | ✅ | ❌ | ❌ |
| `models.default` | ✅ | ✅ (optional) | ✅ (recommended) |
| `models.embedding` | ✅ | ❌ | ❌ |

### `base_url` / `api_key` override rules

Each model entry is an inline table `{target, base_url, api_key}`. Resolution walks an
inheritance chain — anything left empty falls back to the level above:

- **`base_url`**: per-entry override → section `base_url` → `[upstream] default_base_url`
  → `http://localhost`.
- **Configured `api_key`**: per-entry override → section `api_key` → `[upstream] default_api_key`.
  This only resolves the configured fallback key; runtime caller-vs-config priority is section-specific below.
- **`upstream_mode`**: per-entry `mode` → section `upstream_mode` → `[upstream] upstream_mode`
  → `"openai-completions"`.
- The target-only form (`opus48 = {target = "..."}`) inherits `base_url` from the section,
  then `[upstream] default_base_url`; `api_key` may be inherited from the section or
  `[upstream] default_api_key`, or supplied by the caller for non-`free` sections.

> **What `[upstream] default_base_url` is for:** it is the global upstream endpoint used
> when no per-entry or section `base_url` is configured, including models that fall through
> every section's exact / wildcard / catch-all lookup.

> **`base_url` may include the full endpoint path.** If `base_url` already contains a known
> full upstream endpoint path, the proxy uses it as-is instead of appending the endpoint
> suffix again. This lets you point a model at the exact URL an upstream expects (e.g.
> `base_url = "https://api.anthropic.com/v1/messages"` with
> `upstream_mode = "anthropic-messages"`) without producing a doubled path like
> `.../v1/messages/v1/messages`. Recognised full-endpoint markers (case-insensitive):
> `/v1/messages`, `/anthropic/messages`, `/v1/chat/completions`, `/chat/completions`, `/v1/interactions`,
> `/v1/responses`, `/openai/responses`, and
> `/v1beta/models/{model}:generateContent` (`:streamGenerateContent`, `:countTokens`).


**Who wins — caller's key vs. configured `api_key`** — this depends on the section:

| Section | Caller's auth header | Configured `api_key` |
|:--------|:---------------------|:---------------------|
| `[models.free]` | **Ignored** | Section/per-entry key **always wins** — the proxy authenticates upstream on the caller's behalf (this is what makes the FREE tier work). |
| `[models.default]` | **Wins** | Used only when the caller sends no key. May come from the entry, section, or `[upstream] default_api_key`. |
| `[models.claude]`, `[models.gemini]` | **Wins** | Same as `default` — caller's key passes through; configured keys are fallbacks only. |
| `[models.embedding]` | **Overridden for embeddings** | Section `api_key` wins for `/v1/embeddings` requests when configured. |

Composite and fusion aliases don't route directly: each target is resolved through its own
`[models.*]` section, so the rules above apply per target. The rule is keyed on
`route.section === 'free'`, so it holds uniformly across direct, composite, and fusion paths.

## Composite Aliases & Fusion

Group multiple models under one name in a `[composite]` section:

```toml
[composite]
# Weighted random: ~70% to model-a, ~30% to model-b
"smart" = {"model-a" = {share = 70}, "model-b" = {share = 30}}

# Primary with fallback, plus a daily token cap
"gpt" = {token_limit = {num = 80000, duration = "1d"}, "gpt-5-mini" = {primary = true}, "gpt-5.4-mini" = {fallback = 1}}
```

- `share` — weighted random selection across targets.
- `primary` / `fallback` — try primary first, fall back in order on failure.
  When a target returns a non-200 upstream error, its effective share is reduced in memory
  by half for later requests, down to a floor of one tenth of its configured share:
  - **Primary target**: decay fires when the `primary = true` target fails. Subsequent
    requests use a weighted pick between the primary (at its reduced share) and the other
    targets, so a heavily degraded primary is less likely to be tried first.
  - **Fallback targets** (no primary): when the alias has two or more `fallback`-numbered
    targets and the first-tried one fails, its effective share is decayed by the same rule.
    The next request picks the first attempt by weighted share, so a degraded fallback-1
    can be overtaken by fallback-2.
  - Decay is runtime-only — `proxy_config.toml` is never modified and state resets when
    the proxy process restarts.
- `token_limit` — `{num, duration}` rolling-window cap (`1h`/`1d`/`1w`/`1m`); returns HTTP 429 when exceeded.

**Fusion** fans a request out to multiple "panel" models in parallel and routes through an
optional "judge" and an optional but recommended "synth" model that writes the final answer.
If no synth is configured, the judge is used as synth; if no judge exists, the first panel is used:

```toml
[composite]
"answer" = {opus = {fusion = 1, role = "panel"}, sonnet = {fusion = 1, role = "panel"}, "judge-m" = {fusion = 1, role = "judge"}, "synth-m" = {role = "synth"}}
```

For the full set of composite/fusion options and the TUI editor workflow, see
[`docs/design_fusion_composite_alias.md`](./docs/design_fusion_composite_alias.md).

> **Cycles are not allowed.** A composite alias may target another composite alias, but the
> chain must terminate at a real `[models.*]` entry — `A → B → C → A` is rejected at load time
> with a `[FATAL]` log, marked with a red `x` in the TUI / dashboard, and the cyclic target is
> omitted from the snapshot. See [CHANGELOG.md](./CHANGELOG.md) for the full safety rules.

## Schedule Aliases

A `[schedule]` alias is the **top-most layer**: it picks *one* target for the request
based on a timetable (server-local hour-of-day and day-of-week), then hands that target
down to whatever routing rule resolves it (`[models.*]` or another `[composite]`).
There is no weighting or fan-out here — exactly one target is selected per request.

```toml
[schedule]
"saver" = {"maxplan" = [{from = 9, to = 12}, {from = 14, to = 18}], "code-small" = [{from = 0, to = 9, days = "weekday"}], "max-m3" = [{days = "weekend"}], "max-m2.7-high" = []}
```

In the example above, on weekday mornings `code-small` serves, on weekday office
hours `maxplan` serves, on weekends `max-m3` serves, and `max-m2.7-high` (the
**fallback** with an empty `[]` window list) handles anything that falls between
the configured windows.

**Window syntax — every entry is `{from?, to?, days?}`:**

| Field | Range | Default | Meaning |
|---|---|---|---|
| `from` | `0..24` (inclusive of start) | `0` | Hour-of-day the window opens (server-local time). |
| `to`   | `0..24` (exclusive of end) | `24` | Hour-of-day the window closes. `24` is a legal value (end-of-day). |
| `days` | `"weekday"`/`"weekdays"`, `"weekend"`/`"weekends"` (any casing), or `[mon, tue, ...]` | everyday | When the window applies, evaluated against server-local day-of-week. Any other string (including hand-typed typos) normalizes to "everyday" rather than raising an error. |

A target with **`windows = []`** is a **fallback**: it serves when no other target
matches the current time. If multiple empty-window targets are configured, the first one listed is used.
If no fallback exists and no window matches, schedule does not select a target; the
request falls through to normal routing with the original model name, including
`[models.default]` / `*` catch-all routing when configured.

**Selection rules (in order, first match wins):**

1. The current `(hour, day-of-week)` matches one of the target's `windows` → that target.
2. Otherwise, the target with `windows = []` (the fallback) → that target.
3. Otherwise, no schedule target is selected and normal/default routing handles the original model name.

**Windows are unioned across the alias**, not per-target: a single window belongs to
exactly one target. If two targets cover overlapping hours, the *first one listed*
in the TOML wins for the overlap.

**A schedule target is itself routed through the rest of the config** — `maxplan`,
`code-small`, `max-m3`, `max-m2.7-high` above are ordinary `[composite]` or
`[models.*]` entries. Schedule is *transparent composition*: it doesn't replace
composite/fusion/models, it just decides which of them serves this request at this
moment.

**Manage via the dashboard / TUI:**

- Web UI: open `GET /dashboard`, scroll to the **Schedule** section, edit aliases and
  their window lists inline — each window has `from`/`to` number inputs and a
  **days dropdown** (Every day / Weekdays / Weekend). Save persists to `proxy_config.toml`.
- TUI: press `s` to open `ScheduleAliasesOverlay` (mirror of the composite editor
  at `c`). `a` adds an alias, `m` adds a target under the selected alias (a
  concrete `[models.*]` entry or another composite/fusion alias — wildcard
  patterns like `*`/`claude-*` and the alias itself are excluded from the
  picker), `d` deletes, `e` opens a step-by-step window editor (from → to → a
  Every day/Weekdays/Weekend picker, repeat to add more windows, or choose
  "Set as fallback" to clear all windows), arrow keys navigate, `Esc` closes.
- HTTP: the four `/dashboard/api/schedule/*` routes listed in [Dashboard API](#dashboard-api).

**Auth / section flag:** schedule targets inherit whatever `route.section === 'free'`
or "caller's key wins" rule their underlying `[models.*]` section imposes — schedule
selects the target, but the target's section still governs upstream auth.

## Routing Hierarchy (Logic Levels)

The proxy has **three logic levels**, stacked bottom-up. Each level chooses *which
level below* gets to serve this request:

```
                        ┌────────────────────────────────┐
   Level 3 (top)        │  [schedule]                   │  ← timetable (hour-of-day, day-of-week)
                        │  "what should serve *now*?"   │
                        ├────────────────────────────────┤
   Level 2 (middle)     │  [composite]                  │  ← share / primary+fallback / fusion fan-out
                        │  "split across N targets?"    │
                        ├────────────────────────────────┤
   Level 1 (base)       │  [models.*]                   │  ← exact name / prefix-* wildcard / * catch-all
                        │  "which upstream?"             │
                        └────────────────────────────────┘
```

### Level 1 — `[models.*]` custom / target models

Direct routing to an upstream. Three lookup modes, tried in priority order:

- **Exact key** — `"claude-sonnet-4-6" = {...}` resolves only that exact name.
- **Prefix wildcard** — `"claude-*" = {...}` resolves any `claude-*` and substitutes
  the `*` with the real suffix.
- **`*` catch-all** — `"*" = {}` (typically in `[models.default]`) resolves anything
  that wasn't claimed by an earlier mode, preserving the original model name.

Each entry picks its `upstream_mode` / `base_url` / `api_key` from an inheritance
chain (per-entry → section → `[upstream]` defaults). Custom/target models are the
*only* level that actually talks to an upstream — Levels 2 and 3 must always
resolve down to a Level-1 entry before a single byte is sent.

### Level 2 — `[composite]` aliases (share or fan-out)

Logical grouping of two or more Level-1 entries under one name. Two strategies:

- **`share`-weighted distribution** — `{"max-m2.7-high" = {share = 100}, "max-m3" = {share = 100}}`
  splits each request randomly across targets by weight. One or more may be marked
  `primary` (the default target) or `fallback` (consulted in order if the primary fails).
  This is one request → one target.
- **`fusion` fan-out** — every target with `fusion = 1, role = "panel"` runs in parallel
  against the same request; an optional `role = "judge"` scores them; and an optional but recommended
  `role = "synth"` merges them into one final response. Without synth, fusion uses the judge, then the first panel. `fusion_options` configures
  `min_panel`, `panel_timeout_ms`, `judge_required`, `expose_metadata`, `max_concurrent`.
  This is one request → many targets → one response.

A composite alias **does not route directly**. Each target it names is resolved
through its own `[models.*]` section, so per-target `base_url`, `api_key`, and
section-based auth rules all still apply. Section flag `route.section === 'free'`
is computed per-target, so a composite made of free-tier targets stays free-tier end-to-end.

### Level 3 — `[schedule]` timetable

The highest layer. Each request asks: *given the current server-local hour and
day-of-week, which [composite] or [models.*] entry should serve me right now?*
The chosen target then flows through Levels 2 → 1 exactly as if the caller had
asked for that target by name. Schedule is **transparent**: it adds *when* without
overriding *how*.

| Level | Section | Selects by | Cardinality | Re-routes to |
|:-----:|:--------|:-----------|:------------|:-------------|
| 3 | `[schedule]` | Timetable windows | 1 → 1 (one target picked per request) | Level 2 or 1 |
| 2 | `[composite]` (share / primary+fallback) | Weighted random or fallback order | 1 → 1 | Level 1 |
| 2 | `[composite]` (fusion) | Role + `fusion_options` | 1 → N → 1 (panel×N + judge + synth) | Level 1 |
| 1 | `[models.*]` | Exact / `prefix-*` / `*` catch-all | 1 → 1 (one upstream) | — (sends) |

Three concrete examples of the same caller request resolving differently per layer:

- **Level 1 only** — `model: "claude-sonnet-4-6"` → matched exactly in `[models.claude]`
  → sent to `api.anthropic.com`.
- **Level 2 (share)** — `model: "maxplan"` → `[composite].maxplan` picks
  `max-m2.7-high` or `max-m3` by weight → that target resolved in `[models.*]`
  → sent to its upstream.
- **Level 2 (fusion)** — `model: "smarter"` → `[composite].smarter` fans out to
  three panel targets in parallel, judges them, and a `synth` target merges the
  result → each leg resolved in its own `[models.*]`.
- **Level 3 (schedule)** — `model: "saver"` at 10 AM Tuesday → `[schedule].saver`
  picks the `maxplan` target (its `from = 9, to = 12` window matches) →
  `[composite].maxplan` picks one of its targets by weight → that target resolved
  in `[models.*]` → sent.

## Deployment

**Docker**

```bash
cp proxy_config.toml_example proxy_config.toml
docker build -t model-proxy-v3 .
docker run -p 8788:8788 -v $(pwd)/proxy_config.toml:/app/proxy_config.toml model-proxy-v3
```

**PM2** (multiple workers)

```bash
npm run build
pm2 start dist/server.js -i 4
```

**Cloudflare Workers**

```bash
npm run dev       # local
npm run deploy    # publish
```

## Configuration Reference

Most users only need `proxy_config.toml`. Optional environment variables tune behavior.
On the Node server (`npm run server` / `dist/server.js`) these come from the process
environment; on Cloudflare Workers they come from `[vars]` in `wrangler.toml`.

**`[upstream]` config fields**

| Field | Example | Purpose |
|---|---|---|
| `default_base_url` | `"https://api.example.com"` | Global upstream endpoint fallback when a route has no per-entry or section `base_url`, and for models not claimed by any `[models.*]` section. |
| `default_api_key` | `"sk-..."` | Global configured-key fallback when a route has no per-entry or section `api_key`. For non-`free` sections, caller auth headers still win at request time; for `[models.free]`, the configured key wins. Typically left unset in production. |
| `global_token_limit` | `"1B 1d"` | Rolling-window token cap across all models. Format: `"<num><K/M/B> <duration>"` where duration is `1h`/`1d`/`1w`/`1m`. Returns HTTP 429 when exceeded. |
| `budget_to_effort_low` | `32768` | Thinking-budget threshold (tokens) below which `reasoning_effort: "low"` is emitted for upstreams that use effort levels instead of token budgets. |
| `budget_to_effort_medium` | `65536` | Threshold above `low` and below this → `reasoning_effort: "medium"`. |
| `budget_to_effort_high` | `128000` | Threshold above `medium` → `reasoning_effort: "high"`. Set to `0` to always emit `"high"`. |

**Core / server**

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8788` | Listen port (Node server) |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `ALLOWED_ORIGINS` | `*` | CORS origins |
| `DEFAULT_MAX_TOKENS` | `8192` | `max_tokens` for requests that omit it |
| `TUI` | unset | `true` launches the terminal dashboard + enables stat persistence |
| `DUMP` | unset | `true` enables token-log persistence without the TUI |
| `DEV_MODE` | unset | `true` enables development behaviors |

**Config source**

| Variable | Default | Purpose |
|---|---|---|
| `PROXY_CONFIG_PATH` | `./proxy_config.toml` | Path to the local config file |
| `PROXY_CONFIG_URL` | unset | Remote/Consul config URL (read-only dashboard when set) |

**Token counting & upstream**

`sdk://...` model `base_url` values are handled by the local SDK adapter instead of
HTTP fetch for supported Claude/OpenAI-shaped upstream calls. For example, a model
entry can set `base_url = "sdk://chatjimmy.ai/api"` and keep the appropriate
`upstream_mode` for the client/upstream protocol shape.

| Variable | Default | Purpose |
|---|---|---|
| `LOCAL_TIKTOKEN` | `false` | Count tokens locally instead of calling upstream |
| `TIKTOKEN_MODEL` | unset | tiktoken encoding to use, e.g. `o200k_base` |
| `UPSTREAM_BODY_TIMEOUT_MS` | `600000` | Upstream body timeout (also judge/synth timeout in fusion) |
| `MODELS_CACHE_TTL` | unset | Seconds to cache the upstream `/v1/models` list |
| `JSON_STRINGIFY_METHOD` | `json` | Serialization method for outgoing bodies |
| `DEV_PASS_THROUGH` | `false` | `true` enables `/v1/chat/completions`. The proxy resolves the request model first; `openai-completions` routes forward the Chat Completions body as-is, while `openai-responses` routes convert it to Responses format and forward to `/v1/responses`. |
| `CONVERSATION` | unset | `true` enables experimental in-process stateful conversation cache |
| `IMAGE_BLOCK_DATA_MAX_SIZE` | `10485760` | Max inline image bytes accepted |
| `ALLOWED_HOSTS` | `127.0.0.1,localhost` | SSRF allowlist for dynamic per-request upstream hosts |

**Privacy-filter sidecar** (inert unless `PRIVACY_FILTER_URL` is set)

| Variable | Default | Purpose |
|---|---|---|
| `PRIVACY_FILTER_URL` | unset | Sidecar base URL, e.g. `http://127.0.0.1:8799`. Unset = off |
| `PRIVACY_FILTER_ENDPOINTS` | `/v1/messages,/v1/chat/completions,/v1/responses,/v1/interactions` | Proxy paths to filter |
| `PRIVACY_FILTER_FAIL_OPEN` | `false` | `false` = fail-closed (never leak PII upstream on sidecar error) |
| `PRIVACY_FILTER_TIMEOUT_MS` | `40000` | Per-call timeout to the sidecar |
| `PRIVACY_FILTER_MAX_CHARS` | `1024000` | Skip redaction above this total text size |

**Compression sidecar** (inert unless `KOMPRESS_URL` is set)

| Variable | Default | Purpose |
|---|---|---|
| `KOMPRESS_URL` | unset | Sidecar base URL, e.g. `http://127.0.0.1:7777`. Unset = off |
| `KOMPRESS_ENDPOINTS` | `/v1/messages,/v1/chat/completions,/v1/responses` | Proxy paths to compress |
| `KOMPRESS_FAIL_OPEN` | `true` | `true` = fail-open (forward original text on sidecar error) |
| `KOMPRESS_TIMEOUT_MS` | `40000` | Per-call timeout to the sidecar |
| `KOMPRESS_MAX_CHARS` | `1024000` | Skip compression above this total text size |
| `KOMPRESS_KEEP_RATIO` | `0.5` | Fraction of tokens to keep (lower = more aggressive) |
| `KOMPRESS_MIN_CHARS` | `200` | Skip fragments shorter than this |

The full list (including the Consul-backed config and hardcoded upstream-mode defaults)
is documented in the comments at the top of [`wrangler.toml`](./wrangler.toml) and in
[`docs/README_DETAILS.md`](./docs/README_DETAILS.md).

## Testing

```bash
# Coverage testcases: run from the project root; the runner builds an isolated test config.
node run-tests.js --all

# Agent SDK / provider tests live under ./tests and need the proxy running first.
node tests/multi-agents-test.ts
node tests/multi-agents-composite.ts
npm run test:unit

# Point testcases at a specific proxy / key
PROXY_URL=http://localhost:8788 API_KEY=sk-test node run-tests.js --all
```

- Coverage test cases live in [`testcases/`](./testcases/README.md); use `node run-tests.js --all` or selected suite indices.
- Agent-SDK and provider tests live in [`tests/`](./tests/README.md).

## Documentation

The [`docs/`](./docs/) folder has deep-dives on specific topics:

- **Routing** — `proxy_config.toml_example`, `docs/routing_refactor.md`, `docs/routing_config_revision.md`
- **Config loading** — `docs/config_loader.md`
- **Thinking / reasoning** — `docs/claude-extended-thinking.md`, `docs/claude-adaptive-thinking.md`
- **API formats** — `docs/claude-api-reference.md`, `docs/gemini-api-reference.md`, `docs/openai-api-reference.md`
- **Fusion & composite design** — `docs/design_fusion_composite_alias.md`

## License

This project is licensed under the [MIT License](./LICENSE).
