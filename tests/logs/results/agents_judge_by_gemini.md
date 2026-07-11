# Judge by `gemini`

node tests/multi-agents-composite.ts --model deepseek/deepseek-v4-flash --judge gemini

=== Composite team (pinned via --judge=gemini) ===
  workers: Codex, Claude
  judge:   Gemini

Selection: 1 model(s) x 8 task(s)
  model: deepseek/deepseek-v4-flash
  task:  codebase_layout
  task:  duplicate_helpers
  task:  stale_or_dead_tests
  task:  coverage_matrix
  task:  hardcoded_credentials
  task:  extract_shared_utilities
  task:  convention_violations
  task:  dependency_audit

=========== Task: codebase_layout | Model: deepseek/deepseek-v4-flash ===========
  workers: Codex + Claude
  judge:   Gemini
  tool calls: A=7, B=18
  elapsed: A=86335ms, B=144226ms
  verdict: Claude wins (high)
  reason:  Output B provides a thorough, structured analysis with concrete file paths, grouping by purpose, and actionable recommendations, while Output A is empty and fails to address the task.

--- Winning output (Claude) ---
Here's the full layout analysis of `tests/`:

---

## Current Layout (as-is)

```
tests/
├── README.md                          ─ project test docs
│
├── multi-agents-test.ts               ─ E2E multi-agent SDK test
├── multi-agents-composite.ts          ─ Composite variant of above
├── run-single-test-case.js            ─ Runner: single test case
├── run-tests-loop-wrapper.js           ─ Runner: loop/toggle configs
│
├── api/
│   ├── interactions.sh
│   ├── v1-messages.sh
│   ├── responses.sh
│   ├── cached-content.sh
│   └── sdk/integration.js             ← SDK integration test
│
├── providers/
│   ├── gemini/         (basic, cli, streaming, endpoints, models, modes, sdk/*)
│   ├── claude/         (basic, models, config, modes)
│   ├── deepseek/       (basic, models)
│   ├── minimax/        (basic)
│   ├── glm/            (basic)
│   └── llama/          (messages)
│
├── features/
│   ├── streaming/      (stream-generate, cli, sse)
│   ├── thinking/       (basic, cli, models, boolean.js)
│   ├── routing/        (wildcard, model, fixed.js)
│   └── token-counting/ (js-tiktoken, sdk, local-perf, all-models, results.json)
│
├── multi-model/        (2, 3, 5, all, failed, oversea — all .sh)
├── fixtures/           (hermes.txt, hermes-notools.txt)
├── infra/              (tool-blocklist.ts, config.sh, version.sh, shell.sh, debug-config.js)
├── perf/               (benchmark.ts)
├── scripts/            (transform-dump.py)
└── logs/
    ├── results/        (20+ timestamped .md files)
    └── fix-sessions/   (7 timestamped .md files)
```

---

## Grouping By Purpose

### 1. E2E / Integration Test Suites (bash `.sh` files)
| Directory | Count | Purpose |
|---|---|---|
| `api/` | 4 | Proxy HTTP endpoints (interactions, messages, responses, caching) |
| `providers/*/` | 19 | Per-provider basic, streaming, model listing, modes, config tests |
| `features/*/` | 8 | Feature-specific tests (streaming, thinking, routing, token counting) |
| `multi-model/` | 6 | Tests exercising multiple model targets in one run |

**Recommendation:** This grouping already works well. One small observation — `api/sdk/integration.js` is a **programmatic SDK client test**, not a raw HTTP endpoint test. It'd be slightly more at home under `features/sdk/` or `providers/sdk/`, but it's not egregious where it is.

### 2. SDK client tests (programmatic, JS/TS)
| File | Location | Note |
|---|---|---|
| `integration.js` | `api/sdk/` | Tests the proxy through an SDK (not raw curl) |
| `native.js`, `openai-compatible.js`, `simple.js`, `summary.js`, `api.js`, `debug.js` | `providers/gemini/sdk/` | 6-node Gemini SDK test files |
| `boolean.js` | `features/thinking/` | Logic helper for thinking feature testing |
| `fixed.js` | `features/routing/` | Fixed routing logic for routing feature testing |

### 3. Runner scripts
| File | Purpose |
|---|---|
| `run-single-test-case.js` | Spawns a test case in isolation |
| `run-tests-loop-wrapper.js` | Loops over configs toggling flags |

These are **infrastructure** — not test cases themselves. They'd be clearer under `infra/`.

### 4. Test fixture / payload data
| File | Purpose |
|---|---|
| `fixtures/hermes.txt` | Large JSON payload (Hermes persona + tools) |
| `fixtures/hermes-notools.txt` | Same without the tool declarations |

### 5. Test infrastructure / helper files
| File | Location | Purpose |
|---|---|---|
| `tool-blocklist.ts` | `infra/` | Unit test for tool-blocklist erasure logic |
| `config.sh`, `version.sh`, `shell.sh`, `debug-config.js` | `infra/` | Shell helpers for bootstrapping/configure tests |

### 6. Performance benchmarks
| File | Location | Purpose |
|---|---|---|
| `benchmark.ts` | `perf/` | Isolated benchmark of converters, token counting, stringify |

### 7. Utility scripts (not test runners themselves)
| File | Location | Purpose |
|---|---|---|
| `transform-dump.py` | `scripts/` | Data-format transformation script (not a test) |

### 8. Logs / output (artifacts, not test code)
| Folder | Contents |
|---|---|
| `logs/results/` | 20+ timestamped `.md` test-result reports |
| `logs/fix-sessions/` | 7 timestamped `.md` debugging/fix session transcripts |

### 9. Root-level TS tests
| File | Purpose |
|---|---|
| `multi-agents-test.ts` | Multi-agent × multi-model orchestration (likely the most comprehensive test) |
| `multi-agents-composite.ts` | Refactored composite variant of the above |

---

## Things That Look Misplaced

### 🟡 `run-single-test-case.js` and `run-tests-loop-wrapper.js` at root level
These are **runner/infrastructure scripts**, not test cases. They should live in `infra/` (like `config.sh`). Having them at the root alongside actual test files (`multi-agents-test.ts`) makes the top-level directory noisy.

### 🟡 `scripts/transform-dump.py` is not a test
A data-format migration script (old heatmapEvents → new format) sitting in `tests/scripts/`. Unless it's used to prepare test fixtures, it probably belongs in a top-level `scripts/` or `tools/` directory outside `tests/`.

### 🟡 `features/token-counting/results.json` in a test directory
This looks like **generated test output** committed alongside the test code. If it's a golden/expected-output fixture it's fine (rename to `.expected.json` to signal intent); if it's an artifact, it shouldn't be in the repo at all.

### 🟡 `features/thinking/boolean.js` and `features/routing/fixed.js`
These are `.js` files living among `.sh` files in feature directories. They appear to be **helper modules** that the bash tests shell out to. They'd be clearer as:
- `features/thinking/helpers/boolean.js`
- `features/routing/helpers/fixed.js`

Or simply named more explicitly (e.g. `routing-fixed-decision.js`) so it's obvious they're helpers, not test cases.

### 🟡 `features/token-counting/sdk.ts` and `local-perf.ts` — TS alongside bash
Same pattern as above — SDK-based token-counting test in a directory of `.sh` files. Consistent with the `api/sdk/` precedent, but the mixed language in one directory is a signal the category might be too broad.

---

## Suggested Layout

```
tests/
├── README.md
│
├── e2e/                          ← renamed from root-level + api/ + providers/
│   ├── multi-agents-test.ts
│   ├── multi-agents-composite.ts
│   ├── api/
│   │   ├── interactions.sh
│   │   ├── v1-messages.sh
│   │   ├── responses.sh
│   │   └── cached-content.sh
│   ├── providers/
│   │   ├── gemini/*.sh, sdk/*.js
│   │   ├── claude/*.sh
│   │   └── ... (minimax, deepseek, glm, llama)
│   ├── multi-model/*.sh
│   └── features/
│       ├── streaming/*.sh
│       ├── thinking/   (only the .sh tests)
│       ├── routing/    (only the .sh tests)
│       └── token-counting/
│           ├── all-models.sh
│           └── js-tiktoken.js
│
├── sdk/                          ← SDK-based tests, consistent language
│   ├── integration.js            ← moved from api/sdk/
│   ├── token-counting/
│   │   ├── sdk.ts
│   │   └── local-perf.ts
│   └── gemini/
│       ├── native.js
│       ├── openai-compatible.js
│       ├── simple.js
│       ├── summary.js
│       ├── api.js
│       └── debug.js
│
├── fixtures/
│   ├── hermes.txt
│   └── hermes-notools.txt
│
├── infra/                        ← test infrastructure only
│   ├── run-single-test-case.js   ← moved from root
│   ├── run-tests-loop-wrapper.js ← moved from root
│   ├── tool-blocklist.ts
│   ├── config.sh / version.sh / shell.sh / debug-config.js
│   └── helpers/                  ← helper scripts (not test cases)
│       ├── thinking-boolean.js   ← moved from features/thinking/
│       └── routing-fixed.js      ← moved from features/routing/
│
├── perf/
│   └── benchmark.ts
│
├── scripts/
│   └── transform-dump.py         ← if it's for test fixture prep; else move out of tests/
│
└── logs/
    ├── results/
    └── fix-sessions/
```

---

## Summary of Flags

| Item | Issue | Suggestion |
|---|---|---|
| `run-single-test-case.js` + `run-tests-loop-wrapper.js` at root | Infrastructure mixed with test cases | Move to `infra/` |
| `scripts/transform-dump.py` | Data migration script, not a test | Either move to project-level `scripts/` or document in README that it's a fixture-prep tool |
| `features/token-counting/results.json` | Ambiguous — fixture or artifact? | Rename to `.expected.json` if golden data; delete if artifact |
| `features/thinking/boolean.js`, `features/routing/fixed.js` | JS helpers inside bash-only test dirs | Move to `infra/helpers/` or a `features/helpers/` subdirectory |
| `features/token-counting/sdk.ts`, `local-perf.ts` | TS SDK tests in bash feature dir | Move to `sdk/token-counting/` |
| `api/sdk/integration.js` | SDK test mixed with raw-HTTP API tests | Move to a shared `sdk/` directory |
| `logs/results/` + `logs/fix-sessions/` (30+ files) | Artifact clutter in source tree | Consider `.gitignore` patterns for auto-generated logs; or archive/summarize old ones |

The current layout is **functional** — files are grouped by what they test (api vs provider vs feature) — but **inconsistently layered**: runners live at root, SDK tests are scattered across `api/sdk/` and `providers/gemini/sdk/` with no shared parent, and helper scripts hide inside feature directories alongside test cases. A separation into **e2e/** (shell-based endpoint tests), **sdk/** (programmatic client tests), **infra/** (runners + helpers), and **perf/** would make the hierarchy reflect *how* something runs, not just *what* it tests.

=========== Task: duplicate_helpers | Model: deepseek/deepseek-v4-flash ===========
  workers: Codex + Claude
  judge:   Gemini
  tool calls: A=0, B=0
  elapsed: A=180000ms, B=180000ms
  A error: workerA(Codex) timed out after 180000ms
  B error: workerB(Claude) timed out after 180000ms
  verdict: Codex wins (low)
  reason:  Both agents timed out and returned empty outputs, so neither provides any useful response; Codex is arbitrarily chosen.

--- Winning output (Codex) ---
(empty)

=========== Task: stale_or_dead_tests | Model: deepseek/deepseek-v4-flash ===========
  workers: Codex + Claude
  judge:   Gemini
  tool calls: A=0, B=0
  elapsed: A=180000ms, B=180000ms
  A error: workerA(Codex) timed out after 180000ms
  B error: workerB(Claude) timed out after 180000ms
  verdict: Codex wins (low)
  reason:  Both agents timed out and produced empty error responses, failing to deliver any audit findings; Codex is chosen arbitrarily as there is no substantive output to differentiate them.

--- Winning output (Codex) ---
(empty)

=========== Task: coverage_matrix | Model: deepseek/deepseek-v4-flash ===========
  workers: Codex + Claude
  judge:   Gemini
  tool calls: A=0, B=0
  elapsed: A=180000ms, B=180000ms
  A error: workerA(Codex) timed out after 180000ms
  B error: workerB(Claude) timed out after 180000ms
  verdict: Codex wins (low)
  reason:  Both outputs were empty due to timeout, providing no coverage matrix; Codex is selected arbitrarily as neither agent produced usable output.

--- Winning output (Codex) ---
(empty)

=========== Task: hardcoded_credentials | Model: deepseek/deepseek-v4-flash ===========
  workers: Codex + Claude
  judge:   Gemini
  tool calls: A=0, B=0
  elapsed: A=180000ms, B=180000ms
  A error: workerA(Codex) timed out after 180000ms
  B error: workerB(Claude) timed out after 180000ms
  verdict: Codex wins (low)
  reason:  Both outputs are empty due to timeout (no findings produced), so the task requirements are unmet; Codex is chosen arbitrarily as both are equally invalid.

--- Winning output (Codex) ---
(empty)

=========== Task: extract_shared_utilities | Model: deepseek/deepseek-v4-flash ===========
  workers: Codex + Claude
  judge:   Gemini
  tool calls: A=0, B=0
  elapsed: A=180000ms, B=180000ms
  A error: workerA(Codex) timed out after 180000ms
  B error: workerB(Claude) timed out after 180000ms
  verdict: Codex wins (low)
  reason:  Both agents timed out with no output; Codex is selected arbitrarily as there is no content to evaluate.

--- Winning output (Codex) ---
(empty)

=========== Task: convention_violations | Model: deepseek/deepseek-v4-flash ===========
  workers: Codex + Claude
  judge:   Gemini
  tool calls: A=0, B=0
  elapsed: A=180000ms, B=180000ms
  A error: workerA(Codex) timed out after 180000ms
  B error: workerB(Claude) timed out after 180000ms
  verdict: Codex wins (low)
  reason:  Both outputs are empty due to timeouts; Codex is arbitrarily chosen as neither provided usable content.

--- Winning output (Codex) ---
(empty)

=========== Task: dependency_audit | Model: deepseek/deepseek-v4-flash ===========
  workers: Codex + Claude
  judge:   Gemini
  tool calls: A=0, B=0
  elapsed: A=180000ms, B=180000ms
  A error: workerA(Codex) timed out after 180000ms
  B error: workerB(Claude) timed out after 180000ms
  verdict: Codex wins (low)
  reason:  Both agents timed out and produced no output, so no winner can be determined; arbitrarily selecting Codex.

--- Winning output (Codex) ---
(empty)

=========== Summary (8 composite runs) ===========
Worker win counts (across all composite runs):
  Codex: 7
  Claude: 1

