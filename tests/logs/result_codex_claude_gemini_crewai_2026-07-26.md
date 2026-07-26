# Test Run: Codex / Claude / Gemini / CrewAI — 2026-07-26

## Test commands

```
PROXY_BASE=http://127.0.0.1:7777 CODEX_API_KEY=WELCOME_TO_USE_THIS    npx tsx tests/multi-agents-test.ts 0 1 1
PROXY_BASE=http://127.0.0.1:7777 ANTHROPIC_API_KEY=WELCOME_TO_USE_THIS npx tsx tests/multi-agents-test.ts 0 2 1
PROXY_BASE=http://127.0.0.1:7777 GEMINI_API_KEY=WELCOME_TO_USE_THIS    npx tsx tests/multi-agents-test.ts 0 3 1
PROXY_BASE=http://127.0.0.1:7777 OPENAI_API_KEY=WELCOME_TO_USE_THIS    .venv-crewai/bin/python tests/multi-agents-test.py 0 3 1
```

Proxy: `PORT=7777`, `DEV_NO_KEY=true`, `DEV_PASS_THROUGH=true`
Task: `1` (`codebase_layout`) — all models (deepseek-v4-comp, deepseek-v4-auth, max-m3-comp, max-m3-anth)

---

## Agent 1 — Codex (npx tsx tests/multi-agents-test.ts 0 1 1)

### deepseek-v4-comp: SUCCESS

Codex produced a layout report grouping tests/ by purpose and flagging misplaced files.
Suggested new top-level dirs: `unit/`, `api/sdk/`, `features/{routing,streaming,thinking,token-counting}/`,
`providers/`, `multi-model/`, `multi-agents/`, `perf/`, `fixtures/`, `helpers/`, `scripts/`, `logs/`.
Also recommended moving runner `.js` files to project root.

### deepseek-v4-auth: SUCCESS

Similar layout analysis, same recommendations.

### max-m3-comp: SUCCESS

Produced equivalent layout report with minor wording differences.

### max-m3-anth: FAILED

```
Codex failed: Error: {"type":"invalid_request_error","error":{"type":"invalid_request_error","message":"invalid params, 400 (2013)"}}
    at Thread.run (node_modules/@openai/codex-sdk/src/thread.ts:135:13)
```

MiniMax Anthropic-format endpoint rejected the request (upstream 400). Pre-existing issue — not a transform engine regression.

---

## Agent 2 — Claude (npx tsx tests/multi-agents-test.ts 0 2 1)

### deepseek-v4-comp, deepseek-v4-auth, max-m3-comp, max-m3-anth: ALL SUCCESS

Claude agent produced detailed layout analysis for all four models. Example output (deepseek-v4-comp):

```
src/
  api handlers, converters, utils, types, index.ts
tests/
  unit/                  node:test *.test.ts
  features/              per-feature suites
  providers/             provider-specific tests
  multi-model/           cross-provider comparison
  perf/                  benchmarks
  fixtures/              static data
  infra/                 shared helpers
  logs/                  results and fix sessions
```

Flagged: `tests/infra/tool-blocklist.ts` should live under `tests/unit/`; `results.json` in
`features/token-counting/` should not be committed; multi-agent harnesses should move to
`tests/integration/multi-agent/` or `tests/runners/`.

Status: `success` on all 4 models.

---

## Agent 3 — Gemini (npx tsx tests/multi-agents-test.ts 0 3 1)

### deepseek-v4-comp, deepseek-v4-auth, max-m3-comp, max-m3-anth: ALL SUCCESS

Gemini agent produced layout reports for all four models. Highlights:

- Identified concatenated/multi-script shell files (multiple `#!/bin/bash` in one file) as unreachable dead code; recommended splitting.
- Flagged `tests/providers/gemini/sdk/integration.js` as a full Gemini suite misnamed as generic SDK test.
- Flagged `BASE_URL` hard-coded to `localhost:8788` in several infra scripts.
- Recommended: `tests/perf/` for performance code, `tests/sdk/` for SDK-layer tests, sweep log artifacts out of test source tree.

Status: `success` on all 4 models.

---

## Agent 3 — CrewAI (.venv-crewai/bin/python tests/multi-agents-test.py 0 3 1)

### All models: SUCCESS (exit code 0)

CrewAI agent completed the codebase_layout task across all models. Produced detailed structural
analysis including:

- Identified 18+ concatenated shell scripts (multi-script files where only the first script
  is reachable by bash) across `multi-model/`, `providers/gemini/`, `providers/claude/`,
  `providers/deepseek/`, `features/thinking/`, `features/streaming/`.
- Flagged `tests/api/sdk/integration.js` as a full Gemini Interactions suite (567 lines,
  14 tests) misplaced under a generic API path.
- Flagged hard-coded `BASE_URL="http://localhost:8788"` without env-var fallback in infra scripts.
- Flagged placeholder `api.example.com` in `integration.js:183`.

Status: exit 0, all models.

---

## Summary

| Agent   | deepseek-v4-comp | deepseek-v4-auth | max-m3-comp | max-m3-anth |
|---------|:----------------:|:----------------:|:-----------:|:-----------:|
| Codex   | OK               | OK               | OK          | FAIL (400)  |
| Claude  | OK               | OK               | OK          | OK          |
| Gemini  | OK               | OK               | OK          | OK          |
| CrewAI  | OK               | OK               | OK          | OK          |

**Known issue:** Codex + `max-m3-anth` (MiniMax Anthropic endpoint) returns upstream 400 `invalid params`.
This is a pre-existing MiniMax quirk unrelated to the transform engine.
