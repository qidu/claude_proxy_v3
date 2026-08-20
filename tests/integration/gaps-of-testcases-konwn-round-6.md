# Coverage Gaps — Round 6 (2026-07-12)

Reconciled round-5 doc against the current tree. This doc reflects the
round-5 fix pass (TC301 + TC305 made deterministic in `03_errors`) and the
round-6 fix pass (TC1903 compaction assertion + model name corrected in
`11_responses`).

## Status of round-5 fix pass

| Round-5 item | Status |
|---|---|
| TC301 Missing Model → deterministic 400 | ✅ added `system` field to force Claude-format validation |
| TC305 Temperature Range → deterministic 400 | ✅ added `system` field, tightened to `=== 400` |
| TC813/TC815 tightening recommended | ❌ abandoned — source tracing confirmed OpenAI-format passthrough (upstream-dependent) |
| Logger request-id shortening (cosmetic) | ✅ `src/utils/logger.ts` now displays `req_<ts>_<last12>` |

## Status of round-6 fix pass

| Round-6 item | Status |
|---|---|
| TC1903 compaction assertion wrong keys | ✅ fixed: now asserts `object === 'response.compaction'` + `Array.isArray(output)` |
| TC1903 2 model | `openai/gpt-5.4-mini` (routing to api.qnaigc.com) or `gpt-5.4-mini` (routing to `localhost:3000`) are both works. |

## Previously-flagged gaps — current status

### STILL OPEN (unchanged from round 5)

1. **Loose `status === 200 || status >= 400` pattern remains the biggest risk.**
   Current count: ~33 occurrences across the suite (down from ~39 in round 5).
   - `08_regression/regression.test.js` — 11 (TC802, TC803, TC807, TC808, TC809,
     TC810, TC811, TC813, TC814, TC815, TC816) — all confirmed upstream-dependent
     (OpenAI-format passthrough); documented as not safely tightenable.
   - `05_upstream_modes/upstream_modes.test.js` — 7
   - `06_integration/integration.test.js` — 3 (lines 54, 90, 182)
   - `11_responses/responses_api.test.js` — 5 (lines 47, 83, 114, 258, 297, 326)
   - `09_composite/composite.test.js` — 1 (line 302, `200 || 400`)
   - Singles: `01_endpoints/messages.test.js:218`, `02_features/image_input.test.js:83`,
     `16_security/privacy_filter.test.js:249`, `16_security/kompress.test.js:246`
   - `07_dashboard/dashboard_api.test.js` — 3 (`200 || 400` at lines 126, 362, 386;
     these are dashboard test-model / global-token-limit where the proxy's own
     validation path wasn't fully traced)

2. **Consul mode (`PROXY_CONFIG_URL`, `read_only: true`) still untested.**
   Infrastructure gap (runner needs a way to spawn/stop a second proxy).

3. **Cache token fields on live response** still not asserted end-to-end.

4. **`d28fe1b` (gemini model-name escaping) still under-tested.**
   No model with `/` in name configured under `gemini-generatecontent` mode.

5. **`16_security/schedule_routing.test.js` TC numbering gap (TC2624–TC2627 absent).**
   Harmless; cases are present under different numbers.

6. **No explicit `__proto__` schedule *target* alias test.**
   `DANGEROUS_KEYS` denylist is shared, so logically covered, but an explicit
   test would be stronger.

### RESOLVED since round 5

7. **TC1903 `/v1/responses/compact` false green.** The test asserted
   `'compaction' in body || 'response' in body` but
   `convertCompletionsToCompactedResponse` returns
   `{ id, object: 'response.compaction', created_at, output, usage }` —
   neither key exists. Fixed to assert `object === 'response.compaction'`
   and `Array.isArray(output)`.

8. **TC1903 models `openai/gpt-5.4-mini` and `gpt-5.4-mini` .**
   The `openai/` prefix caused the request to fall through to the default
   upstream `api.qnaigc.com` (200) passing compaction assertion. 
   without `openai/`, the model `gpt-5.4-mini` routed to
   localhost:3000 (400) masking compaction assertion.

## New gaps / observations for round 6

9. **`testModelEndpoints` helper still uses strict `passed: response.status === 200`**
   (round-5 doc incorrectly flagged this as loose; verified it is strict).
   No action needed — the helper is fine.

10. **`07_dashboard/dashboard_api.test.js` TC708 (test-model) asserts `200 || 400`**
    but the dashboard `handleDashboardTestModel` handler's error paths were not
    fully traced. If the proxy deterministically returns 200 for a configured
    model and 400 for missing `modelId` (already tested by TC709), this could
    be tightened to `=== 200` for the known-good model case.

11. **`07_dashboard/dashboard_api.test.js` TC717/TC718 (global-token-limit) `200 || 400`**
    — `upsertGlobalTokenLimitFromDashboard` validation path still not traced.
    Could be tightened if the proxy's own validation is deterministic.

12. **`09_composite/composite.test.js:302` `200 || 400`** — composite test-model
    endpoint; same pattern as TC708. Needs source tracing to determine if
    tightenable.

## Recommended next moves

1. **Trace `handleDashboardTestModel` and `upsertGlobalTokenLimitFromDashboard`**
   in `src/handlers/dashboard.ts` to determine if TC708/TC717/TC718 can be
   tightened from `200 || 400` to a single expected status.
2. **Add a gemini model-name escaping test** (model id with `/` under
   `gemini-generatecontent` mode) — requires config fixture.
3. **Add an explicit `__proto__` schedule target alias test** (TC2624).
4. **Consul mode and cache token fields** remain deferred (infrastructure/
   upstream dependent).

## What not to churn

- `03_errors/validation.test.js` — TC301 and TC305 now deterministic; rest are
  intentionally loose with documented reasons.
- `08_regression/regression.test.js` — all 11 loose assertions confirmed
  upstream-dependent (OpenAI-format passthrough); do NOT tighten.
- `12_config_validation`, `14_routing`, `15_config_parse`, `16_security`
  (overall), `13_fusion`, `09_composite` remain well-designed.
- The `testModelEndpoints` helper is strict (`=== 200`); no action needed.

## Notes

- This file supersedes `gaps-of-testcases-konwn-round-5.md` in the sense that
  it reflects the round-5 and round-6 fixes; it is a delta document, not a
  replacement.
- Round-5 doc is intentionally preserved for history.
