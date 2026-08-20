Testcase Coverage Review

  Two existing internal audit docs already exist and are current: testcases/gaps-of-testcases-konwn.md (2026-06-19) and -round-2.md (later). I reconciled them against
  the current test tree (18 suites) and recent commits (fusion, wildcard routing, kompress, tool blocklist — all landed since round-2 was written). Summary, not
  re-deriving what those docs already say well:

  Still accurate / highest-impact gaps (both docs agree):
  1. Loose assertion pattern status === 200 || status >= 400 across 03_errors, 10_auth, 11_responses, 08_regression (~30+ cases) — collapses correctness checks to
  "doesn't crash." This is the single biggest coverage problem; a regression flipping 200↔400 would pass silently.
  2. TC-ID collisions: 10_auth (TC1201-1208) vs 12_config_validation (TC1201-1214); 11_responses (TC1301-1309) vs 13_fusion (TC1301-1308) — breaks log correlation.
  3. No tests for: src/utils/tool-blocklist.ts dashboard endpoints (GET/POST /dashboard/api/tools/*), POST /dashboard/api/global-token-limit, SSRF dynamic-route
  allow/deny branches (ALLOWED_HOSTS), Consul-mode (PROXY_CONFIG_URL) read-only trigger, src/utils/privacy-filter.ts request-side redaction, src/utils/kompress.ts
  (net-new module per recent commits, zero coverage), src/utils/conversation-store.ts (CONVERSATION env path).
  4. Given the SSRF and prototype-pollution-adjacent findings above (H2, M4), I'd specifically add: (a) a test asserting models.free behavior is intentional/bounded
  (fusion fan-out doesn't cascade unbounded), and (b) a config-loader unit test in 15_config_parse that PUTs a payload containing __proto__/constructor keys and asserts
  they're rejected/ignored — currently untested and would catch M4 if a future refactor introduces a generic merge.
  5. 14_routing/15_config_parse (newest suites) are tight and well-designed — no notes.

