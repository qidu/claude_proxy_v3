# Model Proxy v3

One proxy, three API schemas. Talk to **Claude**, **Gemini**, and **OpenAI-compatible**
models through a single endpoint, no matter which API format your client speaks.

The proxy accepts requests in the Claude, Gemini, or OpenAI Responses format,
converts them for whatever upstream provider you've configured, and converts the
response back. It also handles model aliasing, routing, fallback, and basic usage
accounting out of the box.

```
        Claude / Gemini / OpenAI client
                     │
                     ▼
              ┌─────────────┐
              │ Model Proxy │   ← routes by model name, converts formats
              └─────────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   Anthropic     Gemini      OpenAI-compatible
   upstream     upstream     upstream(s)
```

## Features

- **Three API formats in, any provider out** — accept requests in any of these schemas:
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
# Default upstream — used by any model that doesn't override it
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

# Everything else goes here (OpenAI-compatible)
[models.default]
upstream_mode = "openai-completions"
"*" = {}                                     # final catch-all
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
Press `c` to edit composite aliases, `t` to send a test request, `r` to reload config,
`Ctrl+C` to quit. A web dashboard is also available at `GET /dashboard`.

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

- **`base_url`**: per-entry override → section `base_url` → `[upstream] default_base_url`.
- **`api_key`**: per-entry override → section `api_key` → `[upstream] default_api_key`.
- **`upstream_mode`**: per-entry `mode` → section `upstream_mode` → `[upstream] upstream_mode`
  → `"openai-completions"`.
- The target-only form (`opus48 = {target = "..."}`) requires the section to define **both**
  `base_url` and `api_key`; the full form may leave either empty to inherit.

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
| `DEV_PASS_THROUGH` | `false` | `true` forwards `/v1/chat/completions` directly to the default upstream (skips model routing, applies validation only) |
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
