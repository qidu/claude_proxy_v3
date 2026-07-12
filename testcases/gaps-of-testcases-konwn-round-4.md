# Coverage Gaps — Round 4 (2026-07-12)

Reconciled `gaps-of-testcases-konwn.md`, `-round-2.md`, `-round-3.md` against the
current tree: 27 suites in `run-tests.js`, including the `16_security/` suite
(9 files, TC2001–TC2910) which landed after round-3 and closes most of the
previously flagged gaps.

## Status of previously flagged gaps

### RESOLVED since round-3

| Prior gap | Evidence |
|---|---|
| Tool blocklist dashboard endpoints untested | `07_dashboard/dashboard_api.test.js` TC712–TC716 — GET blocklist shape, toggle-block round-trip (true and false), cleanup after each |
| `POST /dashboard/api/global-token-limit` untested | `07_dashboard/dashboard_api.test.js` TC717–TC718 (value string + `value: null` clear) |
| SSRF dynamic-route allow/deny untested | `16_security/ssrf_dynamic_route.test.js` TC2001–TC2004: deny 403 with exact error message, allow branch via config-derived host, malformed route 400, substring-host bypass rejected. Both branches + a bypass case — better than what round-2 asked for |
| privacy-filter request-side redaction untested | `16_security/privacy_filter.test.js` TC2101–TC2112 (unit-level, loads module directly) |
| kompress untested | `16_security/kompress.test.js` TC2201–TC2212 (config gate, internal-host restriction, fail-open flag, path matcher) |
| conversation-store untested | `16_security/conversation_store.test.js` TC2301–TC2305 (round-trip, unknown key, normalize variants, overwrite, `CONVERSATION_MAX_ENTRIES` eviction) |
| `__proto__`/`constructor` config pollution untested | `16_security/config_loader_pollution.test.js` TC2501–TC2515 |
| `models.free` fusion fan-out bounded | `16_security/free_fanout.test.js` TC2401–TC2406 |
| `DEV_PASS_THROUGH` passthrough validation untested | `16_security/dev_pass_through.test.js` TC2801–TC2806 (specific `ValidationError` messages asserted) |
| Reasoning-effort/max-token conflict (commit dceda9b) untested | `16_security/reasoning_effort_conversion.test.js` TC2901–TC2910 |
| embeddings shape never asserted | `05_upstream_modes/upstream_modes.test.js:184-193` now asserts `data[0].embedding` is a non-empty numeric array |
| `testModelEndpoints` dead code | Now imported and used in `04_models/models.test.js:221` |
| TC-ID collisions | No cross-file `name: 'TCxxxx'` duplicates found in a fresh scan. 16_security uses distinct TC20xx–TC29xx ranges |
| `fusion_metadata` vs `expose_metadata` naming | Verified: `src/index.ts:1619` emits `fusion_metadata` when config option `expose_metadata: true`; `13_fusion` TC1308 asserts exactly that. Not a mismatch — config key vs response field. Closed |
| OPTIONS CORS preflight | `06_integration/integration.test.js:367` (TC613) sends a real OPTIONS request |
| All 16_security suites registered in runner | `run-tests.js:66-74` lists all 9 files |

### STILL OPEN (carried forward)

1. **Loose assertion `status === 200 || status >= 400` — ~40 occurrences remain.**
   Still the single biggest false-green risk. Current locations:
   - `08_regression/regression.test.js` — 12 (lines 77, 113, 229, 253, 276, 303, 336, 388, 428, 454, 496)
   - `05_upstream_modes/upstream_modes.test.js` — 7 (85, 150, 172, 265, 297, 324, 352)
   - `06_integration/integration.test.js` — 7 (55, 91, 183, 266, 282, 454)
   - `11_responses/responses_api.test.js` — 6 (48, 84, 115, 253, 292, 321)
   - `09_composite/composite.test.js` — 3 (215, 280, 381)
   - Singles: `01_endpoints/messages.test.js:219`, `02_features/image_input.test.js:84`,
     `03_errors/validation.test.js:110`, `04_models/models.test.js:174`,
     `07_dashboard/dashboard_api.test.js:184`, `10_auth/auth_headers.test.js:158`,
     `16_security/privacy_filter.test.js:249`, `16_security/kompress.test.js:246`
   Note: many of these are *deliberate* "upstream may be down" guards for
   integration tests against live models — a blanket tightening would make the
   suite flaky. The right narrowing is per-case: keep the union only where the
   assertion's purpose is "proxy translated the request without crashing" and a
   live upstream can legitimately 4xx/5xx; tighten where the proxy itself
   determines the status (validation, routing, config endpoints).

2. **Consul mode (`PROXY_CONFIG_URL`, `read_only: true`) still untested.**
   `06_integration/integration.test.js:414` only *skips* when read-only; no test
   drives the read-only path and asserts `PUT /dashboard/api/config` → 4xx.
   Requires spawning the proxy with `PROXY_CONFIG_URL` set (or a config stub) —
   out of scope for the in-process suite; would need a runner-level fixture.

3. **Cache token fields on a live response** (`usage.cache_creation_input_tokens`
   / `cache_read_input_tokens`) still never asserted end-to-end. Depends on an
   upstream that actually triggers prompt caching; hard to make deterministic.

4. **Unused `runTest` imports** — still present in `03_errors/validation.test.js:15`,
   `07_dashboard/dashboard_api.test.js:20`, `02_features/thinking.test.js:21`,
   `09_composite/composite.test.js:20`, `02_features/image_input.test.js:16`,
   `01_endpoints/interactions.test.js:17`, `01_endpoints/messages_streaming.test.js:15`,
   and others. Cosmetic; zero coverage impact.

## New observations (round 4)

5. **`16_security/schedule_routing.test.js` TC numbering gap** — TC2601–TC2623
   then TC2628–TC2630; TC2624–TC2627 are absent. Harmless, but if those IDs were
   deleted tests, note it; if reserved, fine as-is.

6. **`d28fe1b` (escape model name for gemini upstream) has no dedicated test.**
   The change is in the dynamic-route/gemini path of `src/index.ts`. Existing
   `01_endpoints/generateContent.test.js` exercises the endpoint but not a model
   name that *needs* escaping (e.g. containing `/` or `:`). Low priority — worth
   one test case sending a slash-containing model id through the gemini upstream
   mode and asserting no 404/parse failure at the proxy layer.

7. **`53632e7` (completions for token budget exceeding max token) is covered
   indirectly** by `02_features/thinking.test.js` updates in the same commit
   window (budget/max_tokens matrix) — verified those cases exist; no action.

## Recommended actions (this round)

1. Drop unused `runTest` imports (mechanical, zero risk).
2. Tighten the proxy-determined loose assertions only (not live-upstream ones):
   `07_dashboard/dashboard_api.test.js:184` and `06_integration/integration.test.js:454`
   (both hit `PUT /dashboard/api/config` — the proxy alone decides 200 vs 400).
3. Add a gemini model-name-escaping case per §6 (optional, needs live upstream).
4. Items 2 & 3 under "STILL OPEN" require infrastructure (runner fixture /
   cache-capable upstream) — defer, keep on the list.

## Do not churn

`12_config_validation`, `14_routing`, `15_config_parse`, `16_security`,
`13_fusion`, `09_composite` remain tight and well-designed. The 16_security
suite in particular resolved 10 of the 13 open items from rounds 2–3.
