# Coverage Gaps — Round 5 (2026-07-12)

Reconciled `gaps-of-testcases-konwn.md`, `-round-2.md`, `-round-3.md`, and the
new `-round-4.md` against the current tree. This doc also reflects the changes
made during the round-4 fix pass (removed unused `runTest` imports, tightened two
proxy-determined assertions, added `process.exitCode = 1` on `runTestSuite`
failures, and fixed the runner's false "0 failed" accounting).

## Status of round-4 fix pass

| Round-4 item | Status |
|---|---|
| Removed unused `runTest` imports | ✅ applied to 17 test files |
| Tightened `07_dashboard/dashboard_api.test.js:184` | ✅ changed to `200 \|\| (>=400 && <500)` |
| Tightened `06_integration/integration.test.js:454` | ✅ changed to `200 \|\| (>=400 && <500)` |
| Added `runTestSuite` failure exit-code propagation | ✅ `testcases/utils/test_helpers.js` now sets `process.exitCode = 1` when any test fails |

## Previously-flagged gaps — current status

### STILL OPEN (unchanged from round 4)

1. **Loose `status === 200 || status >= 400` pattern remains the biggest risk.**
   Re-count after round-4 edits: ~39 occurrences across the suite. Newest map:
   - `08_regression/regression.test.js` — 11 (TC802, TC803, TC807, TC808, TC809,
     TC810, TC811, TC813, TC814, TC815, TC816)
   - `05_upstream_modes/upstream_modes.test.js` — 7 (TC901, TC902, three chat
     completions blocks, two Responses tests)
   - `06_integration/integration.test.js` — 6 (TC602/604 plus a few live-model
     requests still using the old union)
   - `11_responses/responses_api.test.js` — 6 (TC1303/1304/1305 plus the
     passthrough/compact/unknown aliases cases)
   - `09_composite/composite.test.js` — 3 (share/fallback/primary paths)
   - Singles: `01_endpoints/messages.test.js:219`, `02_features/image_input.test.js:84`,
     `04_models/models.test.js:174`, `16_security/privacy_filter.test.js:249`,
     `16_security/kompress.test.js:246`
   Note: `03_errors/validation.test.js:110` is intentionally loose (see detailed
   comment about OpenAI format bypassing Claude temperature range) and is a
   genuine false-green candidate. Same for regression cases that are documented
   as "upstream may fail" — but many are not actually upstream-dependent.

2. **Consul mode (`PROXY_CONFIG_URL`, `read_only: true`) still untested.**
   No new coverage. Infrastructure gap (runner needs a way to spawn/stop a second
   proxy with `PROXY_CONFIG_URL`).

3. **Cache token fields on live response** still not asserted end-to-end.

### RESOLVED since round 4

4. **Runner false "0 failed" bug.** `testcases/utils/test_helpers.js` now
   propagates failure via `process.exitCode = 1` in `runTestSuite`, so
   `run-tests.js` correctly reports a failed suite as failed.

## New gaps / observations for round 5

5. **`d28fe1b` (gemini model-name escaping) is still under-tested.**
   `01_endpoints/generateContent.test.js` only uses `gemini-2.5-flash`, which
   does not contain characters that require URL-encoding. No test exercises a
   model name with `/`, `:` or other special characters under the
   `gemini-generatecontent` upstream mode. The fix is in `src/index.ts` but
   coverage is not direct.

6. **`03_errors/validation.test.js` TC303 (temperature > 1.0) is documented as
   upstream-dependent but actually tests two different things.** The test sends
   a request that is classified as OpenAI format (no system/thinking/stop
   sequences/Claude content blocks), so the proxy bypasses the Claude
   `0 <= temperature <= 1` validation and forwards it upstream. The loose
   `200 || >= 400` therefore hides whether the proxy validation is correct.
   Either:
   - Send the same request with a `system` prompt so it routes through
     `validateClaudeMessagesRequest` and deterministically gets `400`, or
   - Rename the test to make clear it is testing OpenAI passthrough behavior.

7. **`08_regression/regression.test.js` TC815 (Missing max_tokens defaults to 8192)
   uses the loose union.** The proxy deterministically fills in `max_tokens`
   when missing, so the test should assert `response.status === 200` (with the
   documented fallback caveat for upstream failure). Current wording says
   "should succeed via proxy default" but the assertion accepts 4xx.

8. **`08_regression/regression.test.js` TC813 (zero max_tokens) and TC811
   (OpenAI format system) also use the loose union even though the proxy
   validation is deterministic:**
   - `max_tokens: 0` → `validateClaudeMessagesRequest` throws `400`
     (`max_tokens must be at least 1`).
   - OpenAI-format system message in messages array has no defined rejection by
     the proxy, so a 200 is the only meaningful success; 4xx here would mean
     upstream auth/config failure, which is not the purpose of the test.

9. **`16_security/schedule_routing.test.js` still has the TC numbering gap
   (TC2624–TC2627 are absent).** Harmless but noted. The file header itself says
   it covers `addScheduleAlias`, `removeScheduleAlias`, `upsertScheduleWindow`,
   `removeScheduleTarget`, `resolveScheduleTarget`, and the schedule-wipe
   regression — those cases are present and well-covered.

10. **Config loader `schedule` section direct pollution test exists via
    `TC2623` (rejects `__proto__` schedule alias),** but there is no parallel
    `__proto__` / `constructor` test for a schedule *target* alias. The
    `DANGEROUS_KEYS` denylist is shared, so the path is logically covered, but
    an explicit target alias test would be stronger.

11. **The `testModelEndpoints` helper is now used, but `testModelEndpoints` itself
    still has a loose `response.status === 200 || response.status >= 400` in its
    internal loop** (see `testcases/utils/test_helpers.js`). Because it is
    consumed by `04_models/models.test.js`, this weak assertion leaks into the
    models suite.

## Recommended next moves

1. **Tighten the genuinely deterministic loose assertions in `08_regression`:**
   - TC813 `max_tokens: 0` → `response.status === 400`.
   - TC815 missing `max_tokens` → `response.status === 200` (proxy default path).
   - TC806 already tightened in round 2; keep it.
   - For the rest, document *why* each must accept 4xx (upstream-dependent) and
     consider a comment; otherwise tighten to `200` or the expected 4xx.
2. **Fix `03_errors/validation.test.js` TC303** to deterministically test Claude
   temperature validation by adding a `system` prompt (or `thinking`, or
   `stop_sequences`, or a Claude content block) so the request is routed through
   `validateClaudeMessagesRequest`.
3. **Add a gemini model-name escaping test case** in
   `01_endpoints/generateContent.test.js` or `05_upstream_modes`. A model id
   like `models/gemini-2.5-flash-preview-05-01` or any string containing `/`
   routed through `gemini-generatecontent` would exercise `encodeURIComponent`.
4. **Add an explicit `__proto__` schedule target alias test** (TC2624).
5. **Tighten `testModelEndpoints` internal assertions** or replace its use with
   per-endpoint checks in `04_models/models.test.js`.
6. **Consul mode and cache token fields** remain deferred (infrastructure/
   upstream dependent).

## What not to churn

- `12_config_validation`, `14_routing`, `15_config_parse`, `16_security`
  (overall), `13_fusion`, `09_composite` remain well-designed.
- The 16_security suite has already closed most of the gaps from rounds 2–3.
  The remaining work is tightening weak assertions and adding a few missing
  edge-case tests, not adding another suite.

## Notes

- This file supersedes `gaps-of-testcases-konwn-round-4.md` only in the sense
  that it reflects the round-4 fixes; it is a delta document, not a replacement.
- Round-4 doc is intentionally preserved for history.
