# Coverage Gaps — Round 7 (2026-07-12)

Reconciled round-6 doc against the current tree and executed the round-6
"Recommended next moves." This round focuses on tightening loose dashboard
assertions that source tracing now confirms are deterministic, and a source
fix for a residual model-name escaping gap (R1 from security-review-4).

## Status of round-6 recommended moves

| Round-6 recommendation | Status |
|---|---|
| Trace `handleDashboardTestModel` → tighten TC708/TC1108 | ✅ traced — handler always returns 200 (wraps inner status as `success: false/true`). **Fixed:** TC708 + TC1108 tightened to `=== 200`. |
| Trace `upsertGlobalTokenLimitFromDashboard` → tighten TC717/TC718 | ✅ traced — `upsertGlobalTokenLimit(config, null)` never throws; TC717 was sending an **invalid format** (`'1000000/day'`) that always hit the 400 branch. **Fixed:** input → `'1M 1d'`; both tightened to `=== 200`. |
| Add gemini model-name escaping test | ❌ deferred — `[models.gemini]` in test config points at `https://api.example.com` (not a live upstream); a unit test for `parseFixedRoute` is blocked because the function is not exported. The R1 source fix below closes the escaping gap structurally. |
| Add explicit `__proto__` schedule *target* alias test | ✅ already present — `schedule_routing.test.js:363` (`testApplyDashboardConfigUpdateRejectsProtoAlias`) tests `__proto__` as a schedule alias key via `applyDashboardConfigUpdate`. No separate *target* alias test, but `assertSafeKey` is shared across all schedule/composite key sites. |
| Consul mode / cache token fields | ❌ deferred (infrastructure/upstream dependent) |

## Fixes applied this round

### 1. TC708 — dashboard test-model: tightened to `=== 200`

**File:** `testcases/07_dashboard/dashboard_api.test.js:126`
**Source traced:** `src/handlers/dashboard.ts:1817-1940`
**Reasoning:** `handleDashboardTestModel` returns `jsonResponse({ success: false, ... })` (default status 200) when the inner upstream call fails, and `jsonResponse({ success: true, ... })` (status 200) when it succeeds. The only non-200 paths are: missing `modelId` (400, tested by TC709) or `request.json()` throwing (500, unreachable with valid JSON). Since TC708 sends a valid `modelId`, the response is deterministically 200.

### 2. TC717 — global token limit: fixed input + tightened to `=== 200`

**File:** `testcases/07_dashboard/dashboard_api.test.js:355`
**Source traced:** `src/handlers/dashboard.ts:1638-1646` → `upsertGlobalTokenLimitFromDashboard` (220-232) → `parseHumanTokenLimit` (52-66)
**Bug found:** TC717 sent `{ value: '1000000/day' }` but `parseHumanTokenLimit` requires format `<num>[KMBT] <1h|1d|1w|1m>` (space + `1d`, not `/day`). The regex `/^([\d.]+)\s*([kKmMbBtT]?)\s+(1[hHdDwWmM])$/` does NOT match `'1000000/day'`. So `parseHumanTokenLimit` returned `null`, the function threw `Invalid token limit format`, and the handler returned 400. The `200 || 400` assertion masked this — the success path was never exercised.
**Fix:** Changed input to `{ value: '1M 1d' }` (1 million per day, valid format). Now `parseHumanTokenLimit` matches, `upsertGlobalTokenLimit` sets the limit, handler returns 200 with `{ ok: true }`. Tightened to `=== 200`.

### 3. TC718 — clear global token limit: tightened to `=== 200`

**File:** `testcases/07_dashboard/dashboard_api.test.js:386`
**Source traced:** `upsertGlobalTokenLimit(baseConfig, null)` at `config-loader.ts:2731-2745` — when `rawLimit === null`, it simply `delete nextConfig.upstream!.global_token_limit` and returns. No throw path. Handler returns 200 with `{ ok: true }`.
**Fix:** Tightened `200 || 400` to `=== 200`.

### 4. TC1108 — composite test-model: tightened to `=== 200`

**File:** `testcases/09_composite/composite.test.js:302`
**Source traced:** Same handler as TC708 (`handleDashboardTestModel`). `code-small` is a configured composite alias (`proxy_config.toml:42`), so the composite branch at `dashboard.ts:1836-1843` is taken. The inner fetch to the local proxy may succeed or fail, but the outer response is always 200 (with `success: true/false`).
**Fix:** Tightened `200 || 400` to `=== 200`.

### 5. R1 — source fix: `parseFixedRoute` model-name escaping

**File:** `src/index.ts:306-310, 333-346`
**Bug:** `parseFixedRoute` does `decodeURIComponent(modelMatch[2])` at lines 306 and 333, then interpolates the decoded `modelId` **unencoded** into the upstream URL at lines 310 and 346:
```ts
targetUrl: `${defaultBaseUrl}/${apiVersion}/models/${modelId}:countTokens`,
targetUrl: `${defaultBaseUrl}/${apiVersion}/models/${modelId}:${endpoint}${queryString}`,
```
This is the same class of bug as H2 (fixed in commit `d28fe1b` for `buildRouteAttempt`), but `parseFixedRoute` was missed. A model name like `x%2Fy` (sent as `/v1beta/models/x%2Fy:generateContent`) is decoded to `x/y`, then interpolated raw into the URL — causing path injection.
**Fix:** Added `const safeModelId = encodeURIComponent(modelId);` and used `safeModelId` in the URL interpolations at lines 310 and 346. The `modelId` field in the return object is left decoded (used for stats/routing, not URLs).

## Still open

1. **Loose `status === 200 || status >= 400` pattern** — ~29 occurrences remain (down from ~33 in round 6). The 4 tightened this round (TC708, TC717, TC718, TC1108) are not counted. The remaining are in `08_regression` (11, confirmed upstream-dependent), `05_upstream_modes` (7), `06_integration` (3), `11_responses` (5), and singles in `01_endpoints`, `02_features`, `16_security`, `09_composite` (line 302 was tightened). Dashboard TC708/TC717/TC718 are now tight.

2. **Gemini model-name escaping integration test** — `[models.gemini]` in test config points at a non-live `api.example.com`. Cannot test end-to-end. The R1 source fix closes the structural gap; a unit test would require exporting `parseFixedRoute` or testing through a mock upstream.

3. **Consul mode (`PROXY_CONFIG_URL`, `read_only: true`)** — still untested (infrastructure).

4. **Cache token fields on live response** — still not asserted end-to-end.

## What not to churn

- `08_regression/regression.test.js` — 11 loose assertions confirmed upstream-dependent (OpenAI-format passthrough). Do NOT tighten.
- `03_errors/validation.test.js` — TC301/TC305 already deterministic.
- `12_config_validation`, `14_routing`, `15_config_parse`, `16_security` (overall), `13_fusion`, `09_composite` (overall) remain well-designed.
- `clampThinkingBudget` and `budgetToReasoningEffort` are well-covered by `02_features/thinking.test.js` and `16_security/reasoning_effort_conversion.test.js`.

## Notes

- This is a delta document over round-6. It reflects the round-7 fix pass.
- The R1 source fix (`parseFixedRoute` escaping) was identified in `docs/security-review-4.md` and is fixed here.
