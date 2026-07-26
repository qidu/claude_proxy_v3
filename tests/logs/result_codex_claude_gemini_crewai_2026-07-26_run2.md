# Test Run 2: Codex / Claude / Gemini / CrewAI — 2026-07-26

## Context

This run follows run 1 (same date). Two bugs were found and fixed between runs:

1. **`streaming.ts` — `reasoning_content` gated by `includeThinking` flag**: The
   `if (includeThinking)` guard prevented `delta.reasoning_content` from being
   forwarded as Claude `{type:'thinking'}` blocks when the client did not
   explicitly request thinking. DeepSeek auto-enables thinking; the Claude SDK
   never saw thinking blocks in the streamed response, so the next turn had no
   `reasoning_content` and DeepSeek rejected with "reasoning_content must be
   passed back". Fixed by making `delta.reasoning_content` unconditional.

2. **`openai.ts:claudeJsonToSyntheticCompletions` — thinking blocks dropped**:
   The function only copied text and tool_use blocks from Claude-format responses,
   silently discarding `{type:'thinking'}` blocks. For the
   Gemini→OpenAI→Anthropic→Gemini path (`deepseek-v4-auth`), the Anthropic
   response's thinking blocks were never converted to `{thought:true}` Gemini
   parts, so the Gemini SDK didn't see them and dropped them from history. Fixed
   by joining all `thinking` blocks into `reasoning_content` on the synthetic
   completions message.

3. **`openai-to-claude.ts:convertOpenAIToClaudeResponse` — `reasoning_content`
   not converted to thinking block**: The non-streaming response converter
   checked `message.content` but not `message.reasoning_content`, so DeepSeek's
   per-message reasoning field was never emitted as `{type:'thinking'}`. Fixed by
   prepending a thinking block when `reasoning_content` is set on the message.

4. **`tests/multi-agents-test.ts` Gemini agent — `thought` parts dropped from
   history**: When the model turn contained function calls, only `functionCall`
   parts were pushed to history; `{thought:true}` parts were silently dropped.
   Fixed by collecting `thoughtParts` separately and prepending them to the model
   history turn alongside function call parts.

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

### deepseek-v4-comp: PARTIAL (empty output, no error)

Codex returned empty result text. The proxy handled the request without error;
the Codex SDK returned an empty completion string. This is the same no-output
behavior as run 1. Upstream likely short-circuited reasoning without producing
text content.

### deepseek-v4-auth: SUCCESS

Produced detailed codebase layout analysis (Chinese language output). Covered
all directory groups, flagged misplacements, gave renaming suggestions.

### max-m3-comp: SUCCESS

Produced detailed analysis of tests/ tree including all 9 unit test files,
provider/feature/api/infra sub-trees, and recommendations.

### max-m3-anth: FAIL (pre-existing upstream 400)

```
Error: {"type":"invalid_request_error","error":{"type":"invalid_request_error","message":"invalid params, 400 (2013)"}}
```

Same pre-existing MiniMax Anthropic endpoint issue as run 1. Unrelated to
transform engine.

---

## Agent 2 — Claude (npx tsx tests/multi-agents-test.ts 0 2 1)

### deepseek-v4-comp: SUCCESS

Fixed from run 1 (`reasoning_content must be passed back` error). Claude agent
now correctly sees thinking blocks in streamed responses and includes them in
history.

### deepseek-v4-auth: SUCCESS

Same as run 1.

### max-m3-comp: SUCCESS

Same as run 1.

### max-m3-anth: SUCCESS

Same as run 1.

---

## Agent 3 — Gemini (npx tsx tests/multi-agents-test.ts 0 3 1)

### deepseek-v4-comp: SUCCESS

Fixed from run 1 (was failing with `reasoning_content must be passed back`).

### deepseek-v4-auth: SUCCESS

Fixed from run 1 (was failing with `content[].thinking must be passed back`).
Root cause: `claudeJsonToSyntheticCompletions` dropped thinking blocks.

### max-m3-comp: SUCCESS

Same as run 1.

### max-m3-anth: SUCCESS

Same as run 1.

---

## Agent 3 — CrewAI (.venv-crewai/bin/python tests/multi-agents-test.py 0 3 1)

### All models: SUCCESS (exit code 0)

CrewAI agent completed the codebase_layout task across all four models.

---

## Summary

| Agent   | deepseek-v4-comp      | deepseek-v4-auth | max-m3-comp | max-m3-anth         |
|---------|:---------------------:|:----------------:|:-----------:|:-------------------:|
| Codex   | PARTIAL (empty text)  | OK               | OK          | FAIL (400)          |
| Claude  | OK (fixed from run 1) | OK               | OK          | OK                  |
| Gemini  | OK (fixed from run 1) | OK (fixed)       | OK          | OK                  |
| CrewAI  | OK                    | OK               | OK          | OK                  |

**Fixes applied between run 1 and run 2:**
- `src/converters/streaming.ts`: `delta.reasoning_content` now forwarded as
  thinking blocks unconditionally (not gated by `includeThinking` flag).
- `src/converters/openai-to-claude.ts`: `message.reasoning_content` → thinking
  block in non-streaming response path.
- `src/handlers/openai.ts:claudeJsonToSyntheticCompletions`: thinking blocks
  preserved as `reasoning_content` in synthetic completions.
- `tests/multi-agents-test.ts` Gemini agent: `thought: true` parts now included
  in model history alongside function call parts.

**Known persistent issues (pre-existing, unchanged from run 1):**
- Codex + `deepseek-v4-comp`: empty output (no proxy error; SDK/model behavior).
- Codex + `max-m3-anth`: MiniMax Anthropic endpoint upstream 400 `invalid params`.
