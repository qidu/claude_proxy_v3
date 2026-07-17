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

1. **TC-ID collisions — RESOLVED (2026-07-01)**. Five colliding pairs were found and renumbered:
   - `10_auth/auth_headers.test.js`: TC1401–TC1408 → **TC1001–TC1008** (was colliding with `14_routing`)
   - `11_responses/responses_api.test.js`: TC1301–TC1309 → **TC1901–TC1909** (was colliding with `13_fusion`; TC11xx was unavailable since `09_composite` already occupies it)
   - `01_endpoints/generateContent.test.js`: TC301–TC312 → **TC1601–TC1612** (was colliding with `03_errors/validation.test.js`, undocumented until this pass)
   - `02_features/thinking.test.js`: TC401–TC416 → **TC1701–TC1716** (was colliding with `04_models/models.test.js`, undocumented until this pass)
   - `02_features/image_input.test.js`: TC601–TC606 → **TC1801–TC1806** (was colliding with `06_integration/integration.test.js`, undocumented until this pass)

   No known TC-ID collisions remain across the 20 test files as of this revision.

2. **Legacy script pile in `../tests/`** — ~100 shell scripts (`test_*.sh`) and loose `.js` files (`test_*.js`) are *not* picked up by `run-tests.js`. They look like part of the suite but aren't. Either migrate useful ones into `testcases/` or move them out of the test root.

3. **Overuse of `status === 200 || status >= 400` — PARTIALLY RESOLVED (2026-07-01)**. Tightened the assertions in `03_errors/validation.test.js`, `08_regression/regression.test.js`, `10_auth/auth_headers.test.js`, and `11_responses/responses_api.test.js` where the actual proxy source (`src/index.ts`, `src/utils/validation.ts`, `src/utils/errors.ts`, `src/utils/beta-features.ts`) makes the status code deterministic:
   - `validation.test.js` TC301 (missing model) → `=== 400`; TC306 (missing auth) → `=== 401`; TC307/TC309/TC311/TC812(regression TC812 covered separately) → deterministic 400s traced to `ValidationError`/`JSON.parse` failure paths; TC311 (chat-completions blocked) → `=== 500` (confirmed via source: a plain `Error` thrown at `index.ts:369` is not a `ClaudeProxyError`, so `createErrorResponse` defaults to 500, not a 4xx — this is flagged as a real bug candidate, not just a loose test).
   - `regression.test.js` TC806 (malformed JSON) → `=== 400`; TC812 (mixed string+object content blocks) → `=== 400` (Claude-format validation path rejects non-object array entries).
   - `auth_headers.test.js` TC1001–1004/1006/1008 narrowed from `200||>=400` to `!== 401` (a valid auth header must never trip the proxy's own auth check; the exact success/failure status beyond that is upstream-dependent). TC1005 (config-vs-header priority) intentionally kept as a flexible union — both outcomes are documented as valid.
   - `responses_api.test.js` TC1904 (image input), TC1905 (developer role), TC1906 (stateful fields dropped) narrowed from `200||>=400` to the union `[200, 400, 422]` since these are proxy-unvalidated pass-through fields — any failure is upstream, not proxy-side. TC1901/1907/1908/1909 (basic/streaming/tools/stateless) intentionally kept as the open union — genuinely upstream-dependent happy-path tests with no proxy-side validation gate.
   - Some cases remain intentionally loose because source inspection confirmed the outcome truly is upstream-dependent (e.g. `validation.test.js` TC303 invalid model name — falls back to `getDefaultModelRoute()`, no proxy-side rejection; TC305 temperature — Claude-range check is bypassed when the request is classified as OpenAI-format; TC310 invalid tool — no proxy-side tool-shape validation exists at all).
   - Remaining untouched loose assertions (TC801–805, 808–810, 813–816 in regression; and most of `06_integration`) were not touched in this pass — recommend a follow-up sweep applying the same source-tracing method.

3a. **Dashboard tool-blocklist / global-token-limit endpoints untested — RESOLVED (2026-07-01)**. `07_dashboard/dashboard_api.test.js` had no coverage of `GET /dashboard/api/tools/blocklist`, `POST /dashboard/api/tools/toggle-block`, or `POST /dashboard/api/global-token-limit` (all wired in `src/index.ts` and implemented in `src/handlers/dashboard.ts`). Added TC712–TC718:
   - TC712: `GET .../tools/blocklist` returns `{rows: [], blockedTools: []}` shape.
   - TC713/TC714: `POST .../tools/toggle-block` with `blocked:true`/`false` round-trips through a follow-up GET, confirming the in-memory `blockedTools` Set (`src/utils/dashboard-stats.ts`) is actually mutated — not persisted across restarts per `docs/README_DETAILS.md`, so each test cleans up after itself.
   - TC715/TC716: missing and whitespace-only `tool_name` both return `400 {error: 'tool_name is required'}` (traced to the `.trim()` check in `handleDashboardToggleToolBlock`).
   - TC717/TC718: `POST .../global-token-limit` with a value string and with `value: null` (the documented "clear" no-op via `value ?? null`); kept as a `200||400` union since `upsertGlobalTokenLimitFromDashboard`'s internal validation wasn't traced in this pass.
   - All three routes require the loopback-only admin-path gate (`src/index.ts` `ADMIN_PATHS`/`isAdminPath`, `x-client-address` header injected by `src/server.ts` from the real socket address) — satisfied automatically when tests run against `localhost:7777`, so no special headers were needed.

3b. **SSRF dynamic-route guard untested — RESOLVED (2026-07-01)**. New file `16_security/ssrf_dynamic_route.test.js` (registered in `run-tests.js`). Source-traced the actual guard in `src/index.ts`'s dynamic-routing block (`isDynamicRoute` → `parseDynamicRoute` → `getAllowedHostsFromConfig(proxyConfig)` → `isHostAllowed` → 403 or dispatch) and corrected a prior assumption in `gaps-of-testcases-konwn-round-2.md`/`-round-3.md`: the allowlist is **not** the `ALLOWED_HOSTS` env var (confirmed via grep that `env.ALLOWED_HOSTS` is never read anywhere in `src/`) — it's derived live from `proxy_config.toml`'s `[upstream].default_base_url` and every `[models.*].base_url` / per-model override, via `getAllowedHostsFromConfig` in `src/utils/config-loader.ts`. Added TC2001–TC2004:
   - TC2001: `/https/evil.example.com/v1/messages` → `403 {error.message: "Target host not allowed."}`.
   - TC2002: dynamically discovers a configured `base_url` host from `GET /dashboard/api/config` (mirrors the discovery pattern used by `09_composite`/`13_fusion`) and asserts a dynamic route to that host is NOT rejected by the SSRF-specific 403 (may still fail for unrelated reasons e.g. auth).
   - TC2003: `/https/onlyonesegment` (too few path segments, no recognizable Claude endpoint) → `400 {error.message: "Invalid dynamic route."}`.
   - TC2004: substring-suffix bypass attempt (`api.qnaigc.com.evil.com`, which contains an allowed hostname as a non-dot-boundary substring) → still `403`, confirming `isHostAllowed`'s exact/wildcard-suffix matching isn't fooled by naive substring tricks.
   - All 4 verified passing against the live proxy (`http://localhost:7777`) before being added to `run-tests.js`.

3c. **Privacy filter (`src/utils/privacy-filter.ts`) request-side redaction untested — RESOLVED (2026-07-01), with a scope caveat**. New file `16_security/privacy_filter.test.js` (registered in `run-tests.js`). The plugin is "entirely inert unless `PRIVACY_FILTER_URL` is set" (per its own docstring), and no live sidecar (`submodules/privacy-filter/serve.py`) is assumed to be running in the test environment — so this is a **unit-test-only** pass, following the `15_config_parse` dist-import pattern (`import('dist/utils/privacy-filter.js')`, no live proxy required for TC2101–TC2111). Added TC2101–TC2120:
   - TC2101: `getPrivacyFilterConfig` returns `null` when `PRIVACY_FILTER_URL` is unset (inert-by-default).
   - TC2102/TC2104/TC2105: rejects a public/external sidecar host, a malformed URL, and a non-http(s) protocol respectively (the sidecar URL itself gets an SSRF-style internal-host check via `isInternalHost` from `routing.ts`).
   - TC2103: accepts a `localhost` URL and asserts the documented defaults (`timeoutMs:40000`, `maxChars:1024000`).
   - TC2106/TC2107: `restoreText` sentinel (`⟦PII:n⟧`) substitution and no-op-when-absent.
   - TC2108: `redactBody` is a no-op (no fetch attempted) for a body with no extractable text refs.
   - TC2109 (the only test requiring the live proxy): sends PII-shaped content through `/v1/messages` and asserts no `⟦PII:n⟧` sentinel artifacts leak into the response — valid given the assumed test-environment default of no `PRIVACY_FILTER_URL` configured.
   - **Removed (2026-07-17)**: `endpoints` config + `PRIVACY_FILTER_ENDPOINTS` env var — `redactBody` already no-ops on bodies without extractable text refs, so the path gate was dead code. `fail_open` config + `PRIVACY_FILTER_FAIL_OPEN` env var — privacy filter is now fail-closed by construction (a privacy tool must never forward unredacted text on sidecar failure, so there is no opt-out). Renumbered TC2106→..., TC2109/TC2110→removed, etc.; the suite is now TC2101–TC2120 (20 tests).
   - **Known remaining gap**: end-to-end redaction (`redactBody` actually calling a live sidecar and getting real `redacted[]` text back, plus the streaming `createRestoreTransformStream` behavior) is still untested — would require standing up `submodules/privacy-filter/serve.py` or a stub HTTP server answering `/redact`, which was out of scope for this pass.
   - All 20 verified passing (`node run-tests.js 21` against `PROXY_URL=http://localhost:7777`) before being added to `run-tests.js`.

3d. **Kompress (`src/utils/kompress.ts`) request-side compression untested — RESOLVED (2026-07-01)**. New file `16_security/kompress.test.js` (registered in `run-tests.js`). Same dist-import unit-test approach as 3c (`import('dist/utils/kompress.js')`), since the plugin is inert unless `KOMPRESS_URL` is set and no live sidecar (`submodules/kompress/`) is assumed present. Added TC2201–TC2212:
   - TC2201: `getKompressConfig` returns `null` when `KOMPRESS_URL` is unset (inert-by-default).
   - TC2202: rejects a public/external sidecar host (same `isInternalHost` SSRF-style guard shared with `privacy-filter.ts`).
   - TC2203: accepts a `localhost` URL and asserts documented defaults — notably **`failOpen: true`** (the opposite of the privacy filter, which is fail-closed by construction with no opt-out, since "compression is an optimization, not a correctness boundary" per the source comment), `timeoutMs:40000`, `maxChars:1024000`, `keepRatio:0.5`, `minChars:200`, `maxLength:2048` (a fixed constant, not configurable), and a default 3-endpoint set that **excludes `/v1/interactions`** (the privacy filter has no `endpoints` config at all as of 2026-07-17).
   - TC2204: `KOMPRESS_FAIL_OPEN=false`/`'0'` explicitly disables fail-open; `'true'` keeps it enabled.
   - TC2205: `shouldCompressPath` matches `/v1/messages`, `/v1/chat/completions`, `/v1/responses`; confirms `/v1/interactions` and `/v1/embeddings` are NOT matched by default.
   - TC2206: `isCjkHeavy` classification — empty string and English text false; Chinese/Japanese/Korean text true; a mostly-English sentence containing a single CJK character (`中`) is also true, documenting the immediate-disqualification branch (any single CJK-range codepoint short-circuits to `true` regardless of the rest of the text).
   - TC2207/TC2208: `compressBody` fail-open (default) vs fail-closed (`KOMPRESS_FAIL_OPEN=false`) behavior when the sidecar is unreachable — fail-open silently returns the original text with `fragments:0`; fail-closed throws `'kompress sidecar unavailable'`.
   - TC2209/TC2210: `compressBody` pre-emptively skips fragments below `minChars` (200) and CJK-heavy fragments even with `failOpen:false` set (proving the skip happens before any fetch attempt, not merely masked by fail-open).
   - TC2211: `compressBody` is a no-op (same body reference, no fetch attempted) for a body with no compressible refs.
   - TC2212 (the only test requiring the live proxy): sends a long repeated-phrase message through `/v1/messages` and asserts the response is not a `500`, confirming the inert-by-default wiring doesn't itself break requests (kompress mutates outbound request text only — one-directional/lossy with no response-side artifact to check directly, unlike the privacy filter's restorable sentinels).
   - **Known remaining gap**: end-to-end compression (`compressFragment` actually calling a live sidecar and getting shortened text back) is still untested — would require standing up `submodules/kompress/` or a stub `/compress` HTTP server, out of scope for this pass.
   - All 12 verified passing (`node <cjs-converted-copy>` against `PROXY_URL=http://localhost:7777`) before being added to `run-tests.js`.

3e. **Conversation store (`src/utils/conversation-store.ts`, `CONVERSATION` env) untested — RESOLVED (2026-07-01)**. New file `16_security/conversation_store.test.js` (registered in `run-tests.js`). Unlike privacy-filter.ts/kompress.ts, the store itself has no inertness gate — the `CONVERSATION==='true'||==='1'` gate lives entirely in the sole consumer, `src/handlers/responses.ts` (confirmed via grep: `CONVERSATION` is read only there, not in `src/server.ts`, unlike `PRIVACY_FILTER_URL`/`KOMPRESS_URL` which server.ts reads explicitly — the handler receives it via the same `env` object passed through from `process.env`). That gated silent-drop behavior when `CONVERSATION` is unset is already covered live by `11_responses/responses_api.test.js` TC1906 ("stateful fields dropped"), so this file deliberately does not duplicate it and instead dist-imports `dist/utils/conversation-store.js` directly to test the store's own logic. Added TC2301–TC2305 (numbered non-sequentially in the suite to run TC2305 first — see below):
   - TC2301/TC2302: `saveConversation`/`getConversation` round-trip preserves `inputItems`/`outputItems` references and sets a future `expiresAt`; unknown key returns `undefined`.
   - TC2303/b/c/d: all four `normalizeInputToItems` branches — string wrapped as a single user-message item, array passed through by reference unchanged, plain object wrapped as a JSON-stringified user-message item, `null`/`undefined` both returning `[]`.
   - TC2304: re-saving an existing key overwrites the entry (confirms it's a `Map.set`, not an append/merge).
   - TC2305: `CONVERSATION_MAX_ENTRIES`-driven oldest-first eviction — set to `'3'` via `process.env` **before** the dynamic import (since `MAX_ENTRIES` is computed once at module load from `parseInt(process.env.CONVERSATION_MAX_ENTRIES ?? '10000', 10)`), and deliberately run **first** in the suite (before any other test's saves can occupy a slot in the shared module-level store) — saves 5 entries, asserts the oldest 2 are evicted and the newest 3 remain.
   - **Known remaining gap**: the 1-hour `CONVERSATION_TTL_MS` expiry path (lazy eviction in `getConversation`, opportunistic `evictExpired()` on every save) is a hardcoded constant with no injectable clock or env override — not exercised in a fast unit test, verified by code reading only. A true live end-to-end round-trip (`POST /v1/responses` → capture `response.id` → follow-up `POST` with `previous_response_id` set → confirm prior turn's content is prepended to what reaches upstream) is also still untested; attempting it against the live proxy during this pass was blocked by a genuine upstream `401` (`"login fail... carry the API secret key"`) using the test suite's placeholder bearer token, and separately the live proxy process was confirmed (via `/proc/<pid>/environ`) to have `CONVERSATION` unset, so conversation mode is disabled in the current test environment regardless.
   - All 8 verified passing (`node <cjs-converted-copy>` with no live proxy required) before being added to `run-tests.js`.

3f. **models.free auth-passthrough / fusion fan-out bound untested — RESOLVED (2026-07-01)**. New file `16_security/free_fanout.test.js` (registered in `run-tests.js`), addressing round-3 gap item 4a and `docs/security-review-2.md` H2. H2 documents that `models.free` intentionally lets the proxy's configured `api_key` override an unvalidated client bearer token (`route.section === 'free'` check at `src/index.ts:943,1197`; auth gate is presence-only per `src/index.ts:670-683`, no client-key allow-list exists anywhere in `src/`) and flags that fusion aliases multiply the resulting cost/DoS blast radius via panel+judge+synth fan-out. This is a documented design tradeoff, not a bug — the tests pin down the exact behavior and confirm the fan-out is bounded/deterministic rather than literally unbounded. Added TC2401–TC2406:
   - TC2401/TC2402 (live proxy): a bogus/invalid bearer token still reaches a real upstream and succeeds for a `models.free`-routed model (`opus48`), but is rejected `401` for a non-free (default-section) model (`gpt-5.4-mini`) — confirming the override is scoped to `route.section === 'free'` only, not a global auth bypass.
   - TC2403: `resolveFusionPlan` (dist-imported from `dist/utils/config-loader.js`) produces a deterministic 1:1 mapping between configured composite targets and upstream calls — a synthetic 50-panel-target alias yields exactly 50 panel + 1 judge + 1 synth = 52 calls, not a multiplied or combinatorial count.
   - TC2404: a panel/judge target whose literal name happens to match another composite alias (e.g. `outer`'s judge target is named `'inner'`, and `'inner'` is itself a 3-panel composite alias) is resolved as a literal model name via `resolveModelRouteFromConfig` (which only ever looks in `models.*` categories, never `proxyConfig.composite`) — NOT expanded into `inner`'s 3 panel targets. Confirms no combinatorial/recursive fan-out through nested alias references.
   - TC2405: a self-referential panel target (target name equals the alias's own name) resolves to a single flat route with no infinite recursion.
   - TC2406: `getModelRouteConfig`'s `route.section` field is `'free'` only for entries actually declared under `[models.free]` in config — confirming the flag that gates the `api_key` override is derived purely from server-side config structure, never from caller-controlled input.
   - All 6 verified passing (2 live against `PROXY_URL=http://localhost:7777`, 4 pure dist-import unit tests) before being added to `run-tests.js`.

3g. **Config-loader prototype-pollution denylist untested — RESOLVED (2026-07-01)**. New file `16_security/config_loader_pollution.test.js` (registered in `run-tests.js`), addressing round-3 gap item 4b and `docs/security-review-2.md` M4 (prototype-pollution-adjacent finding, marked FIXED). `src/utils/config-loader.ts` maintains a `DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])` denylist used by `assertSafeKey()` at all four entry-point key-iteration sites: composite alias name (`validateAndNormalizeComposite`), composite target key (`composite.X.__proto__`), models category name (`validateAndNormalizeDashboardModels`), and models entry key (`models.X.__proto__`). The comment explains this is defense in depth — `JSON.parse` makes `'__proto__'` an own non-magic property (unlike JS object-literal syntax, which invokes the setter), so the current `Object.entries`-based traversal already wouldn't see the key; but assigning through a variable key would invoke the setter and could reintroduce pollution if the code is ever refactored into a generic/recursive merge. Added TC2501–TC2515:
   - TC2501/TC2502/TC2503: `__proto__`/`constructor`/`prototype` rejected as composite alias names (e.g. `{"composite":{"__proto__":{...}}}`) — dist-import unit test against `applyDashboardConfigUpdate` from `dist/utils/config-loader.js`.
   - TC2504/TC2505/TC2506: same three keys rejected as composite target keys (e.g. `{"composite":{"myalias":{"__proto__":{...}}}}`).
   - TC2507/TC2508/TC2509: same three keys rejected as models category names (e.g. `{"models":{"__proto__":{...}}}`).
   - TC2510/TC2511/TC2512: same three keys rejected as models entry keys (e.g. `{"models":{"mycat":{"__proto__":"..."}}}`).
   - TC2513: control — a well-formed payload with no dangerous keys is accepted and the resulting config reflects the update.
   - TC2514/TC2515 (live proxy): two separate `PUT /dashboard/api/config` requests with `__proto__` at composite-alias and models-category injection points, confirmed via raw `fetch` with a raw JSON string body (NOT a JS object literal — `{ '__proto__': x }` uses the setter path and `JSON.stringify` silently drops it, sending an empty payload the server accepts 200; a real HTTP body always arrives via `request.json()` which calls `JSON.parse` and correctly creates the own enumerable property; curl-style raw-string bodies match the real-world parsing path). Both live requests correctly return `400 {"error":"Invalid key '__proto__' in ..."}` with matching error messages, cross-validating dist-import and live-endpoint behavior.
   - **Methodology note**: the JS object-literal vs JSON.parse distinction is the key insight here. `Object.prototype.polluted` was always `undefined` in every run (no actual prototype chain pollution occurred in any test, including the ones using JS object-literal syntax — because that syntax simply never creates an own property, so `assertSafeKey` is never invoked on it in the first place; this is why the current defense works, and why a refactor to variable-key assignment would be the risk vector the denylist guards against).
   - All 15 verified passing (13 pure dist-import unit tests + 2 live raw-fetch against `PROXY_URL=http://localhost:7777`) before being added to `run-tests.js`.

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
