# Coverage Gaps

Reviewed `./testcases/` against `docs/routing_refactor.md`, `docs/Refactor_gemini_interactions_to_openai_compatible.md`, and `./README.md`.

Bottom line: core endpoints, format conversion, thinking, tools, images, auth, and the composite alias flow are well-covered. Several documented behaviors — especially around **config schema validation, env-driven features, Consul mode, stats persistence, and the composite `total_token_limit` 413 path** — have no tests at all or only shallow negative coverage.

---

## Grouped by impact

### A. Config schema validation — significant gaps

The README L1037–1071 spells out a detailed config validation contract. Tests only assert that *some* error appears in `config_errors` (regression TC804 in `08_regression/regression.test.js`). The following specific error paths are **not** exercised:

| Documented rule | Source | Test coverage |
|---|---|---|
| `target` (1st element) cannot be empty | README L1047 | None |
| 1-element model array requires both `base_url` and `api_key` in category | README L1048 | None |
| 2-element array rejected (`got 2 elements`) | README L1050 | None |
| 4+-element array rejected (`got N elements`) | README L1051 | None |
| Empty `[]` array rejected | README L1052 | None |
| `share` must be finite number (string → error) | README L1066 | None |
| `primary` must be `true`/`false` | README L1067 | None |
| `fallback` must be finite number | README L1068 | None |
| `total_token_limit` must be finite number | README L1069 | None |
| Non-object target config → `invalid target config` | README L1071 | None |
| Empty target `{}` valid | README L1070 | Implicit via composite tests |

The `routing_refactor.md` § "Per-Model Configuration Array Format" L170–197 also documents that **empty arrays `[]` are invalid** and the **3-element format with `["", "", ""]` is required to inherit** — these parsing contracts have no tests.

### B. Composite `total_token_limit` 413 path

README L129: *"Once the accumulated total reaches the `limit`, subsequent requests return **HTTP 413** and are not forwarded upstream."*

`09_composite/composite.test.js` TC1105 only asserts a tiny request should **not** 413. The actual 413 path is never triggered, nor is:

- the limit being read from config and exposed in the dashboard
- per-alias in-memory usage reset to `0` on restart (README L129, L259–261)
- `share: 0` excluding a target from random selection (README L132)

### C. Environment-driven features — not tested

README L833–941 enumerates ~20 env vars. Only a handful are exercised:

| Env var | Documented behavior | Tested? |
|---|---|---|
| `LOCAL_TIKTOKEN` | enables tiktoken counting | Implicit (token-count tests pass against running proxy) |
| `TIKTOKEN_MODEL` | selects encoding | None |
| `JSON_STRINGIFY_METHOD` | serializer choice | None |
| `MODELS_CACHE_TTL` | `/v1/models` cache TTL | None |
| `UPSTREAM_BODY_TIMEOUT_MS` | upstream fetch timeout | None (TC607 tests client timeout, not upstream) |
| `ALLOWED_HOSTS` | SSRF whitelist | None |
| `DEV_MODE` | CORS allows all | None |
| `ALLOWED_ORIGINS` | CORS allowlist | None |
| `IMAGE_BLOCK_DATA_MAX_SIZE` | image size cap | None |
| `DEV_PASS_THROUGH` | `/v1/chat/completions` passthrough mode | None (TC711 only covers the 4xx *block* path; the passthrough path is untested) |
| `DEFAULT_MAX_TOKENS` | default when missing | None |
| `CONVERSATION` | stateful `previous_response_id` cache for responses | None |
| `PROXY_CONFIG_URL` (Consul) | load config from Consul KV | None |
| `GEMINI_API_KEY` | CLI compatibility fallback | None |

### D. Consul / remote config mode

README L135–189 and `routing_config_revision.md` describe `PROXY_CONFIG_URL`-based config loading, KV layout, `config-reload` semantics, and the `read_only: true` flag in dashboard config (README L789, L793). None of:

- Consul key layout
- `read_only: true` surfacing in `GET /dashboard/api/config` when `PROXY_CONFIG_URL` is set
- `PUT /dashboard/api/config` rejection in Consul mode

…are tested.

### E. Token log persistence — shallow

README L441–475 describes `/tmp/model_proxy_tokens.log` JSONL format, 7-day restore, deduplication by `ts:values:id`, and that **modelStats are NOT restored** (so the `total_token_limit` does not re-trigger across restarts). `06_integration` TC615 only checks the file exists / is written. The following are not covered:

- Line format (`date`, `timestamp`, `modelStats[]`, `heatmapEvents:{models,sequences}`)
- Restore reads only the latest dump per date
- `heatmapEvents` dedup on restore (across mixed legacy array + new object rows)
- `modelStats` is **not** restored
- Day-transition dump, midnight safety-net dump, Ctrl+O manual dump (TUI) — manual/TUI scope, may be acceptable

### F. Documented limitations — not tested

README documents several known limitations in the Responses API ("Known Limitations", L643–671). Two are tested (image placeholder TC1304, stateful fields dropped TC1306), but these are not:

- `developer` role causing upstream validation errors (TC1305 sends it through, doesn't assert upstream rejection)
- Streaming `response.output_item.added` emitting empty `name` for tool calls (README L671)
- Reasoning content silently discarded in `openai-completions` mode (README L647) — `completions-to-responses.ts`

### G. Auth header / upstream mode interaction gaps

- `gemini-interactions` mode with `x-goog-api-key` header forwarding — covered
- `gemini-generatecontent` mode with `x-goog-api-key` — covered
- **Default `openai-completions` upstream**: never overrides client headers (README L303) — not asserted
- **Non-default categories**: config keys override client headers (README L1103) — only tested for `openai-completions` upstream (TC1205)

### H. Gemini native path features

- Gemini `thought` content blocks → Claude `thinking` blocks with signature (README L491) — not directly tested
- Gemini `reasoning_content` → `signature_delta` (README L532, L566) — not directly tested
- Native interactions with `thinking_level` only tested as `generation_config.thinking_level='high'` (TC208); the streaming variant of native interactions with `thinking_level` is not exercised

### I. Other untested behaviors mentioned in README "Latest Changes"

README L1571–1700 "Technical Implementation / Latest Changes" describes several fixes and features; most have no regression test:

- **Composite model with same name as base model** [C] suffix — covered in TC1108 ✅
- **TOML parser regex order fix** (README L1593) — not tested
- **`ThinkingBlock` `text` → `thinking` field validation fix** (README L1595) — not tested
- **DeepSeek thinking defaulting** (README L1599) — not tested
- **`formatApiKeyForUpstream()` utility** (README L1226) — only indirectly via TC1206
- **Dashboard side-nav active style** (README L1587) — UI, acceptable
- **Client IP forwarding** (`cf-connecting-ip`, `x-forwarded-for`, `x-real-ip`) (README L1117) — not tested
- **Cache read / creation tokens normalization** (README L821) — not tested; only Claude-format cache fields are referenced in stats shape, never asserted on a live response
- **Beta feature validation** (`src/utils/beta-features.ts`) — not tested
- **Config dump to `./config-dumps/<timestamp>.toml`** on `POST /config-reload` (README L189) — not tested

---

## Recommended additions (priority order)

1. **`tests/12_config_validation.test.js`** — direct tests against `proxy_config.toml` for the schema rules in §A. These run in-process with a Node-side validator (no live upstream required).
2. **Composite `total_token_limit` 413 test** — extend `09_composite/composite.test.js` with a low-limit alias and a large request that triggers 413; also assert `share: 0` exclusion.
3. **Consul-mode dashboard assertions** — set `PROXY_CONFIG_URL`, assert `read_only: true` and that `PUT` returns 4xx.
4. **Token log format/restart tests** — drive a known sequence, restart, and assert that the live counter (not `modelStats`) drives the next 413; assert line shape and `heatmapEvents` dedup.
5. **Env-var feature tests** — at minimum: `IMAGE_BLOCK_DATA_MAX_SIZE` (oversized image rejected), `DEV_PASS_THROUGH` (`/v1/chat/completions` forwards), `MODELS_CACHE_TTL` (second call hits cache).
6. **Documented-limitation negative tests** — `developer` role upstream error, empty `name` in streaming tool-call `output_item.added`, reasoning content discarded under `openai-completions`.
7. **Client IP forwarding** — assert that an inbound `x-forwarded-for` / `cf-connecting-ip` is reflected on the upstream fetch request (test stub or test-mode logging).
8. **Native-Gemini `thought` → Claude `thinking`** — set up a Gemini model + `thought` content in a stubbed upstream response and assert the conversion shape and signature.
