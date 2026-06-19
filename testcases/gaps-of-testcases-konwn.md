# Coverage Gaps

Reviewed `./testcases/` against `docs/routing_refactor.md`, `docs/Refactor_gemini_interactions_to_openai_compatible.md`, `docs/design_fusion_composite_alias.md`, and `./README.md`.

**Bottom line:** core endpoints, format conversion, thinking, tools, images, auth, the composite alias flow, the fusion alias, and the config schema validation contract are all well-covered as of 2026-06-19. Remaining gaps cluster around **env-driven features, Consul mode, stats persistence, the documented Responses API limitations, native-Gemini `thought` conversion, and a few `Latest Changes` regression targets**.

This document is reconciled against the current test files. The previous version was written before `12_config_validation/` and `13_fusion/` existed, and before `08_regression/` and `09_composite/` were extended.

---

## Status legend
- ✅ covered
- ⚠️ partial / shallow
- ❌ missing

---

## Resolved since previous revision

| Area | Previous status | Now covered by |
|---|---|---|
| §A — Config schema validation (most rules) | ❌ none | ✅ `12_config_validation/config_validation.test.js` TC1201–TC1214 (14 cases) |
| §B — Composite `total_token_limit` 413 path | ❌ never triggered | ✅ `09_composite/composite.test.js` TC1110 (creates `__test_ttl413__` alias with `limit:1`, asserts 413 + `over_limit_error` shape) |
| §B — `share: 0` excludes target | ❌ not tested | ✅ `09_composite/composite.test.js` TC1109 (asserts `gpt-all` alias has all targets at `share: 0`) |
| §F — Stateful fields silently dropped in Responses API | ❌ not tested | ✅ `11_responses/responses_api.test.js` TC1306 (asserts `previous_response_id` does not reach upstream) |
| §F — `developer` role passed through | ❌ not tested | ⚠️ `11_responses/responses_api.test.js` TC1305 (asserts it doesn't crash, but does **not** assert upstream rejection — see "still open" below) |
| §I — Client IP header forwarding | ❌ not tested | ⚠️ `08_regression/regression.test.js` TC814 (asserts proxy doesn't crash on `x-forwarded-for` / `cf-connecting-ip` / `x-real-ip` variants; does **not** verify the IP actually reaches upstream) |
| §I — `DEFAULT_MAX_TOKENS` | ❌ not tested | ⚠️ `08_regression/regression.test.js` TC815 (asserts missing `max_tokens` doesn't crash; the env-var override path itself is not exercised) |
| §I — Beta feature validation | ❌ not tested | ⚠️ `08_regression/regression.test.js` TC816 (asserts unknown `anthropic-beta` value doesn't crash) |
| §D — `read_only` flag present in dashboard config | ❌ not tested | ✅ `07_dashboard/dashboard_api.test.js` (asserts field exists) — but see §D below for the *trigger* path |
| §D — `/config-reload` endpoint | ❌ not tested | ✅ `05_upstream_modes/upstream_modes.test.js` TC913 (asserts endpoint responds) |

---

## Grouped by remaining impact

### A. Config schema validation — mostly resolved, two small holes

`12_config_validation/config_validation.test.js` (TC1201–TC1214) directly tests 14 of the documented schema rules from README L1037–1071, including: non-array target (TC1202), empty target `{}` (TC1211), 2-element (TC1204) and 4-element (TC1205) array rejection, non-boolean `primary` (TC1206), non-finite `share` / `fallback` (TC1207/1208), non-finite `total_token_limit` (TC1209), non-object target (TC1210), non-object models payload (TC1212), `api_key` rejection in models payload (TC1213), empty-alias round-trip (TC1214).

Two documented rules still have no direct test:

| Documented rule | Source | Test coverage |
|---|---|---|
| `target[0]` cannot be empty (first element of model array) | README L1047 | ❌ None (TC1203 covers empty `[]`, not empty-string in `[0]`) |
| 1-element model array requires `base_url` + `api_key` in category | README L1048 | ❌ None |

### C. Environment-driven features — almost entirely untested

README L833–941 enumerates ~20 env vars. Most have no direct test:

| Env var | Documented behavior | Tested? |
|---|---|---|
| `LOCAL_TIKTOKEN` | enables tiktoken counting | ⚠️ Implicit — token-count tests pass against running proxy |
| `TIKTOKEN_MODEL` | selects encoding | ❌ |
| `JSON_STRINGIFY_METHOD` | serializer choice | ❌ |
| `MODELS_CACHE_TTL` | `/v1/models` cache TTL | ❌ |
| `UPSTREAM_BODY_TIMEOUT_MS` | upstream fetch timeout | ❌ (TC607 tests client timeout, not upstream) |
| `ALLOWED_HOSTS` | SSRF whitelist | ❌ |
| `DEV_MODE` | CORS allows all origins | ❌ |
| `ALLOWED_ORIGINS` | CORS allowlist | ⚠️ TC613 asserts `Access-Control-*` headers but not the *allowlist behavior* |
| `IMAGE_BLOCK_DATA_MAX_SIZE` | image size cap | ❌ |
| `DEV_PASS_THROUGH` | `/v1/chat/completions` passthrough mode | ❌ (TC711 only covers the 4xx *block* path; the passthrough path is entirely untested) |
| `DEFAULT_MAX_TOKENS` | default `max_tokens` value | ⚠️ TC815 covers default-fallback only, not the env override path |
| `CONVERSATION` | stateful `previous_response_id` cache for Responses API | ❌ (no direct test of `src/utils/conversation-store.ts`) |
| `PROXY_CONFIG_URL` (Consul) | load config from Consul KV | ❌ |
| `GEMINI_API_KEY` | CLI compatibility fallback | ❌ |

### D. Consul / remote config mode — only the read-side is covered

The "passive" surface is tested (`read_only` field present, `/config-reload` responds), but the *trigger* is not:

- ❌ Setting `PROXY_CONFIG_URL` to a stub URL and asserting the proxy reports `read_only: true` in `GET /dashboard/api/config`.
- ❌ Asserting `PUT /dashboard/api/config` returns 4xx when `read_only: true`.
- ❌ Consul key layout / KV semantics (would need a stub Consul or in-process test).
- ❌ Config dump to `./config-dumps/<timestamp>.toml` on `POST /config-reload` (README L189) — not asserted.

### E. Token log persistence — shallow

`06_integration/integration.test.js` TC615 only checks the file exists / is non-empty. The full contract from README L441–475 is uncovered:

- ❌ JSONL line shape: `date`, `timestamp`, `modelStats[]`, `heatmapEvents:{models,sequences}`.
- ❌ Restore reads only the latest dump per date.
- ❌ `heatmapEvents` dedup on restore (across mixed legacy array + new object rows).
- ❌ `modelStats` is **not** restored across restart (this is load-bearing for the `total_token_limit` 413 behavior — the live in-memory counter must be the source of truth, not the persisted aggregate).
- Day-transition dump, midnight safety-net dump, Ctrl+O manual dump (TUI) — manual/TUI scope, acceptable to leave untested.

### F. Documented Responses API limitations — partial

Two of the README "Known Limitations" are now exercised (stateful fields TC1306, developer role TC1305), but with weak assertions:

- ⚠️ TC1305 (`developer` role) only asserts the request "doesn't crash" — does not assert the documented upstream validation error.
- ❌ Streaming `response.output_item.added` emitting empty `name` for tool calls (README L671).
- ❌ Reasoning content silently discarded in `openai-completions` mode (README L647) — `src/converters/completions-to-responses.ts`.

### G. Auth header / upstream mode interaction gaps

- ✅ `gemini-interactions` mode with `x-goog-api-key` header forwarding — covered in `10_auth/auth_headers.test.js`.
- ✅ `gemini-generatecontent` mode with `x-goog-api-key` — covered.
- ❌ Default `openai-completions` upstream never overrides client headers (README L303) — not asserted.
- ⚠️ Non-default categories config keys override client headers (README L1103) — only tested for `openai-completions` upstream; `gemini-generatecontent` and `gemini-interactions` upstream-mode override behavior is not asserted.

### H. Gemini native path features

- ❌ Gemini `thought` content blocks → Claude `thinking` blocks with signature (README L491) — never asserted on a live response. (The reverse Claude→Gemini conversion is also untested at the content-block level.)
- ❌ Gemini `reasoning_content` → `signature_delta` (README L532, L566) — not directly tested.
- ❌ Native interactions with `thinking_level` in *streaming* mode (TC208 covers the non-streaming variant only).

### I. Other untested behaviors from README "Latest Changes"

| Item | Source | Status |
|---|---|---|
| Composite model with same name as base model `[C]` suffix | README | ✅ TC1108 |
| TOML parser regex order fix | README L1593 | ❌ |
| `ThinkingBlock` `text` → `thinking` field validation fix | README L1595 | ❌ |
| DeepSeek thinking defaulting | README L1599 | ❌ |
| `formatApiKeyForUpstream()` utility | README L1226 | ⚠️ Indirect via TC1206 |
| Dashboard side-nav active style | README L1587 | UI — acceptable |
| Client IP forwarding (forwarded to upstream) | README L1117 | ⚠️ TC814 (crash-only) |
| Cache read / creation tokens normalization | README L821 | ❌ (referenced in stats shape, never asserted on a live response) |
| Beta feature validation | `src/utils/beta-features.ts` | ⚠️ TC816 (crash-only) |
| Config dump to `./config-dumps/<timestamp>.toml` on `/config-reload` | README L189 | ❌ |

### J. Source modules with shallow or no direct coverage

| Source module | Coverage | Gap |
|---|---|---|
| `src/handlers/embeddings.ts` | ⚠️ TC908 asserts only status, not response shape/dim | No shape assertion on `data[0].embedding` length or type |
| `src/handlers/chat-completions.ts` | ⚠️ block path only | Passthrough (`DEV_PASS_THROUGH`) not exercised |
| `src/handlers/openai.ts` | ⚠️ indirect via upstream_modes | No direct test of the openai-completions passthrough path |
| `src/utils/privacy-filter.ts` | ⚠️ TC612 asserts redaction in dashboard output | No direct unit test of the filter |
| `src/utils/conversation-store.ts` | ❌ none | `CONVERSATION` env path, `previous_response_id` cache |
| `src/utils/dashboard-stats.ts` | ⚠️ shape-only assertions | `heatmapEvents` dedup, restore semantics |
| `src/utils/fetch-timeout.ts` | ⚠️ client-side timeout only | `UPSTREAM_BODY_TIMEOUT_MS` not exercised |

---

## Test quality issues worth flagging

1. **TC-ID collisions** — `10_auth/auth_headers.test.js` uses TC1201–TC1208, while `12_config_validation/config_validation.test.js` *also* uses TC1201–TC1214. Similarly, `11_responses/responses_api.test.js` uses TC1301–TC1310 and `13_fusion/fusion.test.js` *also* uses TC1301–TC1308. This breaks log correlation and reporting. Renumber one of each pair (recommended: shift `13_fusion` to TC14xx and `12_config_validation` to TC15xx, since they were added later).

2. **Legacy script pile in `../tests/`** — ~100 shell scripts (`test_*.sh`) and loose `.js` files (`test_*.js`) are *not* picked up by `run-tests.js`. They look like part of the suite but aren't. Either migrate useful ones into `testcases/` or move them out of the test root.

3. **Overuse of `status === 200 || status >= 400`** in regression and integration tests (TC814, TC815, TC616, several others). This collapses the assertion to "doesn't crash" and will mask real failures. Most of these should assert a specific 200 or a specific 4xx class when the proxy is expected to behave deterministically.

4. **`fusion_metadata` vs `expose_metadata` naming** — `13_fusion/fusion.test.js` TC1308 header references `fusion_metadata` while the design doc and README use `expose_metadata`. Worth a one-line verification that the test asserts the actually-emitted field name.

5. **Last canonical run (2026-06-15) showed 60/157 failures** — most are 401s from endpoint suites against a misconfigured live proxy, not coverage gaps. The next clean run should be checked after the test environment is set up; the numbers above reflect *test design*, not live results.

---

## Recommended additions (priority order)

1. **Token log format + restart** — drive a known sequence, parse the JSONL line, assert `date` / `timestamp` / `modelStats[]` / `heatmapEvents:{models,sequences}` shape; assert `modelStats` is **not** reloaded after restart.
2. **Env-var feature battery** — `IMAGE_BLOCK_DATA_MAX_SIZE` (oversize image → 4xx), `DEV_PASS_THROUGH` (`/v1/chat/completions` forwards when enabled), `MODELS_CACHE_TTL` (second `/v1/models` call hits cache), `UPSTREAM_BODY_TIMEOUT_MS` (upstream stalls are killed).
3. **Consul-mode test** — set `PROXY_CONFIG_URL` to a local stub, restart proxy, assert `read_only: true` in `GET /dashboard/api/config` and `PUT` rejected with 4xx; assert `./config-dumps/<timestamp>.toml` is written on `/config-reload`.
4. **Gemini native `thought → thinking` conversion** — fixture a Gemini-style response with a `thought` content block and assert the Claude-shaped output includes a `thinking` block with signature.
5. **Auth upstream-mode override for non-default categories** — assert `gemini-generatecontent` upstream key from config wins over a client `x-goog-api-key` header.
6. **Cache token normalization on live response** — assert `cache_creation_input_tokens` / `cache_read_input_tokens` appear and match sums of input tokens.
7. **Documented Responses API limitations** — `developer` role upstream rejection, streaming `output_item.added` empty `name` for tool calls, reasoning content discarded under `openai-completions`.
8. **Fix TC-ID collisions** — renumber the colliding suites (see Test quality issues §1).
