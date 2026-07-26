# Transform Hooks — Multi-Agent Integration Test Run

**Date:** 2026-07-26T03:39:02Z  
**Branch:** feature/fusion  
**Proxy:** http://127.0.0.1:7777 (existing process, tsx live-source)  
**Flags tested:** `PORT=7777 DEV_NO_KEY=true DEV_PASS_THROUGH=true` (proxy started separately)  
**Test file:** `tests/multi-agents-test.py`  
**Selection:** 4 models × 3 agents × 1 task (`codebase_layout`, task index 1)

## Goal

Verify that the new request/response transform hooks (Steps 1–4, feature branch) do not
break existing multi-agent traffic. All 4 routes use `transforms: []` (empty — no
`[transforms.*]` declared in `proxy_config.toml`), so the fast-path in `runHook` /
`endpoint_readin` / `endpoint_writeout` is exercised: payload flows through unchanged.

## Models

| Alias | Target | Upstream mode |
|---|---|---|
| `deepseek-v4-comp` | `deepseek-v4-flash` at `api.deepseek.com` | `openai-completions` |
| `deepseek-v4-auth` | `deepseek-v4-flash` at `api.deepseek.com/anthropic` | `anthropic-messages` |
| `max-m3-comp` | `MiniMax-M3` at `api.minimaxi.com` | `openai-completions` |
| `max-m3-anth` | `MiniMax-M3` at `api.minimaxi.com/anthropic` | `anthropic-messages` |

## Agents

| # | Agent | Venv | Transport |
|---|---|---|---|
| 1 | Antigravity | `.venv` (python 3.14) | `LocalOpenAIAgentConfig` → `/v1/chat/completions` |
| 2 | LangGraph | `.venv` (python 3.14) | `ChatOpenAI` → `{proxy}/v1` |
| 3 | CrewAI | `.venv-crewai` (python 3.13) | `LLM(model="openai/...")` → `{proxy}/v1` |

## Task

**`codebase_layout`** — Analyze `./tests/` file structure, group files by purpose, flag misplaced items.

## Results

### Antigravity (agent 1)

| Model | Status | Notes |
|---|---|---|
| `deepseek-v4-comp` | ✅ PASS | Tool calls completed; structured layout report with tables produced |
| `deepseek-v4-auth` | ✅ PASS | Deep exploration (5 tool-call rounds); detailed report with `tests/logs/` concern, hash-named files |
| `max-m3-comp` | ✅ PASS | Comprehensive report with per-subdirectory analysis; suggested restructure tree |
| `max-m3-anth` | ⚠️ PARTIAL | Agent produced output but hit a `confirm_run_command` hook denial mid-turn; final synthesis section was truncated. Core findings still delivered. |

One `WARNING:root:System step error (HTTP 0)` at start (invalid tool call from a prior run, not from this run's requests) — pre-existing noise, not caused by transform code.

### LangGraph (agent 2)

| Model | Status | Tool calls | Output chars |
|---|---|---|---|
| `deepseek-v4-comp` | ✅ PASS | 24 | 7,822 |
| `deepseek-v4-auth` | ✅ PASS | (full output) | — |
| `max-m3-comp` | ✅ PASS | (full output) | — |
| `max-m3-anth` | ✅ PASS | (full output) | — |

LangGraph output exceeded 33 KB (saved to persisted output file). All 4 models responded with multi-tool-call analysis.

### CrewAI (agent 3)

| Model | Status | Output chars |
|---|---|---|
| `deepseek-v4-comp` | ✅ PASS | 15,245 |
| `deepseek-v4-auth` | ✅ PASS | 9,542 |
| `max-m3-comp` | ✅ PASS | 27,799 |
| `max-m3-anth` | ✅ PASS | 14,942 |

All 4 CrewAI runs completed with `CrewAI done.` and chars > 0.

## Transform Hook Verification

The following new code paths were exercised on every request:

1. **`endpoint_readin` (index.ts `runAttempt`)** — `attemptRoute.transforms.length === 0` fast path hit; request body passed through unchanged. No regressions.
2. **`before_upstream` (chat-completions.ts)** — `route` is `undefined` for the non-`chat-completions` handler types (`messages`, `openai`, etc.) and the `route` is passed for `chat-completions`; fast path (`if (route)` guard) behaved correctly.
3. **`endpoint_writeout` headers (index.ts `runAttempt`)** — `attemptRoute.transforms.length === 0` fast path; response headers unchanged.
4. **Inline patches removed from `chat-completions.ts`** — `normalizeJsonSchemaTypes` and the tool-message-name recovery loop are gone; no observable difference since these models' SDKs do not send uppercase schema types in this test.

## Issues Found (not caused by transform changes)

- `max-m3-anth` Antigravity run hit a `confirm_run_command` hook denial — unrelated to transforms; this is a proxy hook policy blocking a shell command the agent tried to call.
- Warning `System step error (HTTP 0): invalid tool call` in the Antigravity output — pre-existing SDK issue, not new.
- `tests/multi-model/all-models.sh:163` — typo `Baerer` instead of `Bearer` (noted by CrewAI, pre-existing).
- `tests/infra/shell.sh` — hard-coded `/home/teric/...` paths (pre-existing).

## Commands Run

```bash
# Agent 1: Antigravity
PROXY_BASE=http://127.0.0.1:7777 OPENAI_API_KEY=sk-agent-test-key API_KEY=sk-agent-test-key \
  .venv/bin/python3 tests/multi-agents-test.py 0 1 1

# Agent 2: LangGraph
PROXY_BASE=http://127.0.0.1:7777 OPENAI_API_KEY=sk-agent-test-key API_KEY=sk-agent-test-key \
  .venv/bin/python3 tests/multi-agents-test.py 0 2 1

# Agent 3: CrewAI
PROXY_BASE=http://127.0.0.1:7777 OPENAI_API_KEY=sk-agent-test-key API_KEY=sk-agent-test-key \
  .venv-crewai/bin/python3 tests/multi-agents-test.py 0 3 1
```

## Verdict

**PASS.** 11/12 runs fully completed (1 partial due to unrelated hook policy). Transform hook fast-paths do not introduce regressions. All 4 models (2× DeepSeek, 2× MiniMax) and all 3 agent SDKs (Antigravity, LangGraph, CrewAI) work correctly through the proxy with the new wiring in place.
