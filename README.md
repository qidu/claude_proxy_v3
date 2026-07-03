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
  and protocol via a simple TOML config. Wildcards (`claude-*`) and catch-alls (`*`) supported.
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
upstream_mode = "openai-completions"
default_base_url = "https://api.your-provider.com"
default_api_key = "your-api-key"

# Claude models, spoken to in native Anthropic format
[models.claude]
upstream_mode = "anthropic-messages"
base_url = "https://api.anthropic.com"
api_key = "your-claude-key"
"claude-*" = {}                              # catch-all for every claude-* model

# Gemini models, spoken to in native Gemini format
[models.gemini]
upstream_mode = "gemini-generatecontent"
base_url = "https://generativelanguage.googleapis.com"
api_key = "your-gemini-key"
"gemini-*" = {}

# Everything else goes here (OpenAI-compatible). Each `[models.*]` section must
# define its own `base_url` — `[upstream] default_base_url` does NOT fall through
# to fill in a missing section base_url.
[models.default]
upstream_mode = "openai-completions"
base_url = "https://api.your-provider.com"   # section base_url is required; not inherited from [upstream]
"*" = {}                                     # final catch-all for this section
"deepseek/deepseek-v3.2" = {}
```

Key ideas:

- **Categories** group models by provider: `[models.claude]`, `[models.gemini]`,
  `[models.default]`, etc.
- **`upstream_mode`** picks the protocol: `anthropic-messages`, `gemini-generatecontent`,
  or `openai-completions`.
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
- **Wildcards** (`claude-*`) and the **catch-all** (`*` in `[models.default]`) handle
  anything you don't list explicitly.

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
endpoint. Full request/response examples live in the [API reference docs](#documentation).

### Dashboard API

The `/dashboard` web UI is driven by a small JSON API. All routes require a
`Bearer <API_KEY>` header (where `API_KEY` is the proxy's configured auth key).

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
| `GET /dashboard/api/stats` | Per-model token and request stats |

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
| 2 | **`prefix-*` wildcard** | `models.claude`, then `models.gemini` |
| 3 | **`*` catch-all** | `models.default` |

- An exact entry always wins over a wildcard in the same category — e.g. an explicit
  `claude-sonnet-4-6` is matched before `claude-*`.
- Only `prefix-*` (hyphen before `*`) is a wildcard; the `*` is substituted so the
  upstream sees the real model name. A bare `*` key is the catch-all and preserves the
  original model name.

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

- **`base_url`**: per-entry override → section `base_url`. **That's it — `[upstream] default_base_url`
  is NOT a fallback for any category.** Each `[models.*]` section must define its own
  `base_url` (section-level), or every model entry in that section must define its own
  per-entry `base_url`. A section that does neither will fail to resolve at routing time
  rather than silently inheriting from `[upstream] default_base_url`.
- **`api_key`**: per-entry override → section `api_key` → `[upstream] default_api_key`.
- **`upstream_mode`**: per-entry `mode` → section `upstream_mode` → `[upstream] upstream_mode`
  → `"openai-completions"`.
- The target-only form (`opus48 = {target = "..."}`) requires the section to define **both**
  `base_url` and `api_key`; the full form may leave either empty to inherit.

> **What `[upstream] default_base_url` is for:** it is the *global* upstream endpoint
> applied **only** to models that are **not claimed by any `[models.*]` category section** —
> i.e. a model name that falls through every section's exact / wildcard / catch-all lookup
> gets routed to `default_base_url`. It is intentionally **not** a chain link that
> individual sections fall through to: a missing section-level `base_url` (or per-entry
> `base_url` for an entry that omits one) is a configuration error, not something to mask
> with the global default. Always configure `base_url` at the section level (recommended)
> or per-entry.


**Who wins — caller's key vs. configured `api_key`** — this depends on the section:

| Section | Caller's auth header | Configured `api_key` |
|:--------|:---------------------|:---------------------|
| `[models.free]` | **Ignored** | Section/per-entry key **always wins** — the proxy authenticates upstream on the caller's behalf (this is what makes the FREE tier work). |
| `[models.default]` | **Wins** | Used only as a fallback when the caller sends no key. |
| `[models.claude]`, `[models.gemini]` | **Wins** | Same as `default` — caller's key passes through; config is a fallback. |
| `[models.embedding]` | **Wins** | Same — configured key is the fallback. |

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
- `token_limit` — `{num, duration}` rolling-window cap (`1h`/`1d`/`1w`/`1m`); returns HTTP 429 when exceeded.

**Fusion** fans a request out to multiple "panel" models in parallel and routes through an
optional "judge" and a required "synth" model that writes the final answer:

```toml
[composite]
"answer" = {opus = {fusion = 1}, sonnet = {fusion = 1}, "judge-m" = {role = "judge"}, "synth-m" = {role = "synth"}}
```

For the full set of composite/fusion options and the TUI editor workflow, see
[`docs/design_fusion_composite_alias.md`](./docs/design_fusion_composite_alias.md).

## Schedule Aliases

A `[schedule]` alias is the **top-most layer**: it picks *one* target for the request
based on a timetable (server-local hour-of-day and day-of-week), then hands that target
down to whatever routing rule resolves it (`[models.*]` or another `[composite]`).
There is no weighting or fan-out here — exactly one target is selected per request.

```toml
[schedule]
"saver" = {
  "maxplan"        = [{from = 9, to = 12}, {from = 14, to = 18}],
  "code-small"     = [{from = 0, to = 9, days = "weekday"}],
  "max-m3"         = [{days = "weekend"}],
  "max-m2.7-high"  = []
}
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
| `days` | `"weekday"`/`"weekdays"`, `"weekend"`/`"weekends"` (any casing), or `[mon, tue, ...]` | every day | When the window applies, evaluated against server-local day-of-week. Any other string (including hand-typed typos) normalizes to "every day" rather than raising an error. |

A target with **`windows = []`** is the **fallback**: it serves when no other target
matches the current time. Each alias may have **at most one fallback** target.
If no fallback exists and no window matches, the alias resolves to `undefined` and the
client receives `404 model not found`.

**Selection rules (in order, first match wins):**

1. The current `(hour, day-of-week)` matches one of the target's `windows` → that target.
2. Otherwise, the target with `windows = []` (the fallback) → that target.
3. Otherwise, the alias resolves to `undefined` (no such model right now).

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
  against the same request; an optional `role = "judge"` scores them; and a required
  `role = "synth"` merges them into one final response. `fusion_options` configures
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

| Variable | Default | Purpose |
|---|---|---|
| `LOCAL_TIKTOKEN` | `false` | Count tokens locally instead of calling upstream |
| `TIKTOKEN_MODEL` | unset | tiktoken encoding to use, e.g. `o200k_base` |
| `UPSTREAM_BODY_TIMEOUT_MS` | `600000` | Upstream body timeout (also judge/synth timeout in fusion) |
| `MODELS_CACHE_TTL` | unset | Seconds to cache the upstream `/v1/models` list |
| `JSON_STRINGIFY_METHOD` | `json` | Serialization method for outgoing bodies |
| `DEV_PASS_THROUGH` | `false` | `true` forwards `/v1/chat/completions` directly to the default upstream (`openai-completions` validation only) |
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
# Start the proxy first (e.g. on PORT=7777), then:
node run-tests.js

# Point at a specific proxy / key
PROXY_URL=http://localhost:8788 API_KEY=sk-test node run-tests.js
```

- Coverage test cases live in [`testcases/`](./testcases/README.md).
- Agent-SDK and provider tests live in [`tests/`](./tests/README.md).

## Documentation

The [`docs/`](./docs/) folder has deep-dives on specific topics:

- **Routing** — `proxy_config.toml_example`, `docs/routing_refactor.md`, `docs/routing_config_revision.md`
- **Config loading** — `docs/config_loader.md`
- **Thinking / reasoning** — `docs/claude-extended-thinking.md`, `docs/claude-adaptive-thinking.md`
- **API formats** — `docs/claude-api-reference.md`, `docs/gemini-api-reference.md`, `docs/openai-api-reference.md`
- **Fusion & composite design** — `docs/design_fusion_composite_alias.md`

## License

See the repository for license details.
