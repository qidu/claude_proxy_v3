# Coverage Gaps — Round 2

Reviewed `./testcases/` (18 files, 6,541 lines) against `src/index.ts`, `src/handlers/dashboard.ts`, `src/handlers/`, `src/utils/`, the existing `gaps-of-testcases-konwn.md` (2026-06-19), and the project README/docs. This file is an independent review that confirms the prior doc and adds additional findings.

**Bottom line:** the high-value paths (core endpoints, format conversion, validation schema, composite/fusion aliases, thinking, tools, auth header matrix, Responses API limitations) are well-covered. Coverage gaps cluster around **dashboard endpoints added after the original gaps doc, env-driven privacy/kompress features, SSRF/Consul-mode triggers, and a wide-spread weak-assertion pattern that lets regressions pass silently**. The loose-assertion pattern (`status === 200 || status >= 400`) is the most impactful coverage problem — it collapses ~30+ assertions into "doesn't crash".

---

## Status legend
- ✅ covered
- ⚠️ partial / shallow
- ❌ missing

---

## Route / endpoint coverage map

| Surface | Status |
|---|---|
| `POST /v1/messages` | ✅ `01_endpoints`, `02_features`, `08_regression` |
| `POST /v1/messages/count_tokens` | ✅ `06_integration` TC607 |
| `POST /v1/interactions` | ✅ `01_endpoints/interactions.test.js` |
| `POST /v1beta/...:generateContent`, `POST /v1/...:generateContent` | ✅ `01_endpoints/generateContent.test.js` |
| `POST /v1/embeddings` | ⚠️ `05_upstream_modes` TC908 — status only, no shape/dim assertion |
| `GET /v1/models` | ✅ `06_integration` TC605 |
| `POST /v1/responses` (+ `/input_tokens`, `/compact`) | ✅ `11_responses` |
| `POST /v1/chat/completions` (block path) | ✅ `03_errors` TC311 (assertion is loose — see Test quality §1) |
| `GET /dashboard` (HTML) | ✅ `07_dashboard` TC711 |
| `GET /dashboard/api/config` | ✅ `07_dashboard` TC701–702 |
| `PUT /dashboard/api/config` | ✅ `12_config_validation`, also exercised by `09_composite` TC1110 |
| `GET /dashboard/api/stats/models` / `agents` / `requests` | ✅ `07_dashboard` |
| `POST /dashboard/api/test-model` | ✅ `07_dashboard` TC708–710 |
| `GET /dashboard/api/tools/blocklist` | ❌ **Not tested** (route exists in `index.ts:602`) |
| `POST /dashboard/api/tools/toggle-block` | ❌ **Not tested** (`index.ts:606`) |
| `POST /dashboard/api/global-token-limit` | ❌ **Not tested** (`index.ts:620`) |
| `GET /health`, `GET /` | ✅ `06_integration` TC603 |
| `GET /favicon.ico` | ❌ Not tested (trivial, acceptable) |
| CORS preflight (`OPTIONS`) | ⚠️ No direct test — only CORS *response headers* asserted |
| `read_only: true` rejection of `PUT /config` (Consul mode) | ❌ Not tested |

---

## New gaps not in the existing doc

### 1. Privacy filter behavior untested

`src/utils/privacy-filter.ts` is wired in (`index.ts:750-752`) and `PRIVACY_FILTER_*` env vars exist in `server.ts`, but no test exercises the request-side redaction / sentinel→original unredaction loop. `gaps-of-testcases-konwn.md §J` notes only that `TC612` asserts api_key redaction in *dashboard output* — the request-side PII redaction on outbound traffic is never asserted.

### 2. Kompress (lossy request compression) untested

`src/utils/kompress.ts` and the `KOMPRESS_*` env vars (`server.ts:46-52`) have no direct test. The `kompressActive` branch in `index.ts:756-757` is never exercised.

### 3. Tool blocklist dashboard endpoints untested

`handleDashboardToolBlocklist` (`dashboard.ts:1301`) and `handleDashboardToggleToolBlock` (`dashboard.ts:1308`) are registered in the route table at `index.ts:602-609` but no test hits them. `src/utils/tool-blocklist.ts` therefore has zero coverage. Round-trip a tool toggle and assert the blocklist reflects the change.

### 4. Global token limit endpoint untested

`POST /dashboard/api/global-token-limit` (`dashboard.ts:1283`) is unrouted in tests. The runtime path that reads `proxyConfig.upstream.global_token_limit` and throws `OverLimitError` (`index.ts:666-678`) has no test that drives it past the threshold; the config-side setter also has no direct coverage.

### 5. Dynamic route SSRF guard untested

The `parseDynamicRoute` + `isHostAllowed` path (`index.ts:1086-1101`, `ALLOWED_HOSTS` env at `server.ts:27`) is never exercised — neither the allow branch (`/http/127.0.0.1/...`) nor the 403 deny branch (`/http/evil.example.com/...`).

### 6. Streaming empty content / interleaved cases

`08_regression` TC808 covers `streaming_empty_content` for the simple case; the more nuanced paths in `src/converters/streaming.ts` (empty text content with non-empty thinking, tool_use with no text, multiple concurrent content blocks) aren't covered.

### 7. Cache read / creation token stats on live responses

`README §821` and the prior gaps doc §I both flag this; the live `usage.cache_creation_input_tokens` / `usage.cache_read_input_tokens` fields are never asserted on a real response. The stats endpoints show aggregate counts but the per-response shape is unverified end-to-end.

### 8. `testModelEndpoints` helper is dead code

`utils/test_helpers.js:252-306` defines and exports `testModelEndpoints`, but `grep` shows it is not imported anywhere in the suite. Either remove it or wire it into `04_models/models.test.js` to replace some of the hand-rolled per-endpoint smoke calls.

### 9. Unused `runTest` imports in test files

Harmless but symptomatic: `runTest` is imported in `03_errors/validation.test.js:15`, `07_dashboard/dashboard_api.test.js:17`, `10_auth/auth_headers.test.js:18`, `11_responses/responses_api.test.js:24` but never called. Drop the import.

---

## Test quality issues that weaken coverage

### 1. The `status === 200 || status >= 400` pattern dominates multiple suites

This collapses "the proxy behaves correctly" to "the proxy does not crash". ~30+ test cases fall into this trap:

- `03_errors/validation.test.js:104, 164, 182, 204`
- `10_auth/auth_headers.test.js:46, 70, 92, 113, 152, 182, 212, 242`
- `11_responses/responses_api.test.js:48, 84, 115, 160, 189, 219, 240, 278, 308`
- `08_regression/regression.test.js` TC814–TC816 (per the prior gaps doc)

Net effect: a regression that flips a 200 to a 400 (or vice versa) will pass most of these tests. **This is the highest-impact coverage problem in the suite today**, and is not just a style issue — it directly reduces what the suite can prove. Recommended narrowing:

- For `validation.test.js`: each case should assert a *specific* 4xx (e.g. `400` for missing model, `401` for missing auth, `413` for oversize body, `429` for rate limit).
- For `auth_headers.test.js`: TC1401–TC1404, TC1406, TC1408 should assert `=== 200` when the documented behavior is "should reach upstream". Only TC1405 (config-vs-header priority) genuinely has two valid outcomes.
- For `responses_api.test.js`: TC1304 (image inputs), TC1305 (developer role), TC1306 (stateful fields dropped) are explicitly documented as "may be passed through or rejected" — narrow to the union `[200, 400, 422]` instead of the open `>= 400`.
- For regression TC811 (`streaming_empty_content`) and TC814–TC816: assert `=== 200` if the intent is "doesn't crash on a malformed input"; the proxy is *expected* to handle them gracefully.

### 2. TC-ID collisions — RESOLVED 2026-07-01

All five colliding pairs (the two originally flagged here, plus three more found during the fix pass: `generateContent.test.js` ↔ `validation.test.js`, `thinking.test.js` ↔ `models.test.js`, `image_input.test.js` ↔ `integration.test.js`) have been renumbered. See `gaps-of-testcases-konwn.md` §"Test quality issues" item 1 for the full before/after mapping. No known TC-ID collisions remain.

### 3. `fusion_metadata` vs `expose_metadata` naming mismatch (already flagged)

`13_fusion/fusion.test.js` TC1308 references `fusion_metadata`; the design doc and README use `expose_metadata`. Worth a one-line `grep` against the source before the next canonical run to confirm which name the code actually emits and align the test.

### 4. Duplicate "responses 200-or-400" coverage in two suites

`03_errors` and `11_responses` overlap heavily on the "request accepted without crash" path for `/v1/responses`. Not a bug, but it inflates the count and dilutes focus. Consider trimming the duplicate TC307-style assertions in `03_errors` once TC1301-style coverage in `11_responses` is solid.

### 5. `/v1/chat/completions` block path asserted only loosely

`03_errors/validation.test.js:228-231` (TC311) accepts `status >= 400 || text.toLowerCase().includes('not allowed')` — this can pass on a 500 with a generic error body, defeating the purpose of the block. Assert `=== 405` (or whatever the specific contract is per `src/handlers/chat-completions.ts`) and verify the body mentions `not allowed`.

### 6. `embeddings` response shape never asserted

`05_upstream_modes/upstream_modes.test.js` TC908 asserts status only. The README documents `data[0].embedding` as an array of numbers; the length/type/dim are never checked. With an embedding model configured, the test should assert `Array.isArray(response.body?.data?.[0]?.embedding)` and a numeric dim.

---

## Env-var coverage (largely confirms the prior gaps doc §C)

| Env var | Documented behavior | Tested? |
|---|---|---|
| `LOCAL_TIKTOKEN` | enables tiktoken counting | ⚠️ Implicit — token-count tests pass against running proxy |
| `TIKTOKEN_MODEL` | selects encoding | ❌ |
| `JSON_STRINGIFY_METHOD` | serializer choice | ❌ |
| `MODELS_CACHE_TTL` | `/v1/models` cache TTL | ❌ |
| `UPSTREAM_BODY_TIMEOUT_MS` | upstream fetch timeout | ❌ (TC607 tests client timeout, not upstream) |
| `ALLOWED_HOSTS` | SSRF whitelist | ❌ (no dynamic-route tests at all) |
| `DEV_MODE` | CORS allows all origins | ❌ |
| `ALLOWED_ORIGINS` | CORS allowlist | ⚠️ TC613 asserts `Access-Control-*` headers but not the allowlist behavior |
| `IMAGE_BLOCK_DATA_MAX_SIZE` | image size cap | ❌ |
| `DEV_PASS_THROUGH` | `/v1/chat/completions` passthrough mode | ❌ (TC711 only covers the 4xx *block* path) |
| `DEFAULT_MAX_TOKENS` | default `max_tokens` value | ⚠️ TC815 covers default-fallback only, not the env override path |
| `CONVERSATION` | stateful `previous_response_id` cache for Responses API | ❌ (no direct test of `src/utils/conversation-store.ts`) |
| `PROXY_CONFIG_URL` (Consul) | load config from Consul KV | ❌ |
| `GEMINI_API_KEY` | CLI compatibility fallback | ❌ |
| `PRIVACY_FILTER_*` | PII redaction in/out | ❌ (no direct test of `src/utils/privacy-filter.ts`) |
| `KOMPRESS_*` | lossy request compression | ❌ (no direct test of `src/utils/kompress.ts`) |

---

## Source modules with shallow or no direct coverage

| Source module | Coverage | Gap |
|---|---|---|
| `src/handlers/embeddings.ts` | ⚠️ TC908 asserts only status | No shape assertion on `data[0].embedding` length or type |
| `src/handlers/chat-completions.ts` | ⚠️ block path only | Passthrough (`DEV_PASS_THROUGH`) not exercised |
| `src/handlers/openai.ts` | ⚠️ indirect via upstream_modes | No direct test of the openai-completions passthrough path |
| `src/utils/privacy-filter.ts` | ⚠️ TC612 asserts redaction in dashboard output | No direct test of the request-side filter |
| `src/utils/kompress.ts` | ❌ none | Lossy compression path entirely untested |
| `src/utils/conversation-store.ts` | ❌ none | `CONVERSATION` env path, `previous_response_id` cache |
| `src/utils/tool-blocklist.ts` | ❌ none | Both `GET /tools/blocklist` and `POST /tools/toggle-block` unrouted |
| `src/utils/dashboard-stats.ts` | ⚠️ shape-only assertions | `heatmapEvents` dedup, restore semantics |
| `src/utils/fetch-timeout.ts` | ⚠️ client-side timeout only | `UPSTREAM_BODY_TIMEOUT_MS` not exercised |
| `src/utils/beta-features.ts` | ⚠️ TC816 crash-only | Real validation behavior untested |
| `src/utils/stringify.ts` | ❌ none | `JSON_STRINGIFY_METHOD` switch path |
| `src/utils/routing.ts` `parseDynamicRoute` + `isHostAllowed` | ❌ none | SSRF allow / deny branches both untested |

---

## What's actually well-covered (do not churn)

- `12_config_validation` (TC1201–TC1214): tight, targeted schema rules.
- `09_composite` (TC1101–TC1110): dynamic discovery from live config + cleanup after mutation; the `total_token_limit` 413 path is explicitly tested.
- `13_fusion` (TC1301–TC1308): new alias spec coverage is solid (modulo the `expose_metadata` field-name question).
- `02_features/thinking` (largest file, 506 lines): broad parameter matrix including effort normalization, budget tokens, custom thresholds, OpenAI thinking format.
- `02_features/tool_use`: all four `tool_choice` variants, round-trip, OpenAI format, streaming.
- `04_models`: smoke-tests the full provider matrix.
- `05_upstream_modes`: format conversion Claude ↔ OpenAI ↔ Gemini, Responses API, embeddings, models list.
- `10_auth` (modulo the loose-assertion problem): header priority matrix is well-designed.

---

## Recommended next moves (priority order)

1. **Tighten the loose-assertion tests** in `03_errors`, `10_auth`, `11_responses`. Even narrowing `|| status >= 400` to `=== 200 || in [400, 401, 403, 413, 429]` removes most of the false-green risk. ~30-minute sweep; biggest single coverage win available.
2. **Add 4 new dashboard tests**: `GET /dashboard/api/tools/blocklist`, `POST /dashboard/api/tools/toggle-block` (round-trip), `POST /dashboard/api/global-token-limit` (set + verify `getTokensInWindow` reset semantics), `OPTIONS` preflight with a non-allowed origin.
3. **Add SSRF / dynamic-route coverage**: hit `/http/evil.example.com/v1/messages` → 403, hit `/http/127.0.0.1/v1/messages` (with localhost in `ALLOWED_HOSTS`) → routed. Confirms both branches of the allowlist.
4. **Add Consul-mode trigger test**: stub `PROXY_CONFIG_URL`, assert `read_only: true` and `PUT /config` → 4xx. Closest in style to `12_config_validation`.
5. **Privacy filter / Kompress smoke test**: set the env vars, send a request with a known PII / long content, assert (a) the request still 200s, (b) the redaction sentinel is observable (either via a stub URL or via the upstream log).
6. **Cache token fields on a live response**: assert `usage.cache_creation_input_tokens` and/or `usage.cache_read_input_tokens` appear and sum correctly when prompt caching is triggered.
7. **Embeddings response shape**: assert `Array.isArray(data[0].embedding)` and a numeric dim in TC908.
8. **Renumber colliding TC-IDs** (shift `13_fusion` → TC14xx and `12_config_validation` → TC15xx) before the next canonical run.
9. **Verify the `expose_metadata` field name** the code actually emits, then align `13_fusion` TC1308's assertion.
10. **Remove dead helper / unused imports**: delete `testModelEndpoints` from `utils/test_helpers.js` or wire it into `04_models`; drop unused `runTest` imports from `03_errors`, `07_dashboard`, `10_auth`, `11_responses`.

---

## Notes

- This file supersedes nothing — it is a delta on top of `gaps-of-testcases-konwn.md` (the prior gaps doc). The two together give the full coverage picture.
- The prior doc's §B/C/D/F/G/H/I remain accurate as of this review.
- The TC-ID collision fix and the `expose_metadata` field-name verification should be the first mechanical cleanups before any new test work, so log correlation and reporting are clean for the next canonical run.