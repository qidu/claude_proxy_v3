# Comparasion and Validation between agents sdk and proxy (different endpoints)

model: 'gpt-5.5' (upstream source at azure 'openai-responses'
agents: 'codex', 'claude', 'gemini'


###
node tests/multi-agents-test.ts 1 1 2

Selection: 1 model(s) x 1 agent(s) x 1 task(s)
  model:  gpt-5.5
  agent:  Codex
  task:   duplicate_helpers

=========== Task: duplicate_helpers | Model: gpt-5.5 ===========

--- Codex Agent | model=gpt-5.5 ---
Codex result: Found several real duplication clusters under `./tests` after excluding logs/fixtures and reading the suspected bodies.

**Confirmed Identical Or Near-Identical**

1. **Shell result/asserting `test_endpoint` helper**
   - [tests/infra/config.sh](/Users/sudu/dev/bot/model_proxy_v3/tests/infra/config.sh:13)
   - [tests/providers/claude/basic.sh](/Users/sudu/dev/bot/model_proxy_v3/tests/providers/claude/basic.sh:9)
   - Similar copies also appear in `tests/providers/claude/config.sh`, `tests/providers/claude/models.sh`, `tests/providers/deepseek/models.sh`, `tests/multi-model/all-models.sh`, `tests/multi-model/three-models.sh`.
   - Truly identical for the basic `curl -s ... | jq .id/error` variant in several files. Some variants differ only by `timeout 10` or fallback text.

2. **`curl_post` wrapper and log helpers**
   - [tests/api/v1-messages.sh](/Users/sudu/dev/bot/model_proxy_v3/tests/api/v1-messages.sh:35)
   - [tests/providers/llama/messages.sh](/Users/sudu/dev/bot/model_proxy_v3/tests/providers/llama/messages.sh:25)
   - `log_info`, `log_warn`, and `log_error` are identical.
   - `curl_post` is superficially identical but not truly identical: `v1-messages.sh` adds `-H "X-Api-Key: $API_KEY"`; `llama/messages.sh` omits it.

3. **TypeScript filesystem tool helpers**
   - [tests/multi-agents-test.ts](/Users/sudu/dev/bot/model_proxy_v3/tests/multi-agents-test.ts:145)
   - [tests/multi-agents-composite.ts](/Users/sudu/dev/bot/model_proxy_v3/tests/multi-agents-composite.ts:162)
   - `toolGlobSync`, `toolGlob`, and `toolRead` are effectively duplicated. Not byte-identical only because comments differ and one has an added `toolGrep`.

4. **Streaming SSE endpoint helper**
   - [tests/features/streaming/stream-generate.sh](/Users/sudu/dev/bot/model_proxy_v3/tests/features/streaming/stream-generate.sh:158)
   - [tests/providers/gemini/streaming.sh](/Users/sudu/dev/bot/model_proxy_v3/tests/providers/gemini/streaming.sh:136)
   - Similar but not identical: same `timeout 3 curl -s -N ... | head -3` core, but output messages and truncation differ.

**Deduplication Plan**

Create `tests/infra/http.sh` for shell helpers:
- `json_post url data [header...]`
- `assert_json_success name response`
- `test_json_endpoint name url data [timeout]`
- `test_sse_endpoint name url body [timeout]`

Move the repeated `PASS/FAIL` incrementing and `.id`/`.error` parsing into that file, then source it from the shell tests above.

Create `tests/infra/log.sh` for:
- `log_info`
- `log_warn`
- `log_error`

Create `tests/infra/agent-tools.ts` for:
- `toolGlobSync`
- `toolGlob`
- `toolRead`
- optionally `toolGrep`

Then update `multi-agents-test.ts` and `multi-agents-composite.ts` to import those helpers.

I would dedupe exact shell `test_endpoint` copies first, then the TypeScript agent helpers. The `curl_post` and SSE wrappers should be parameterized carefully because their small differences are real behavior, not just formatting drift.


###
node tests/multi-agents-test.ts 1 2 2
Selection: 1 model(s) x 1 agent(s) x 1 task(s)
  model:  gpt-5.5
  agent:  Claude
  task:   duplicate_helpers

=========== Task: duplicate_helpers | Model: gpt-5.5 ===========

--- Claude Agent | model=gpt-5.5 ---
Assumption: I treated `tests/logs/**` as historical output, not active test source. I scanned active `./tests/` shell/JS/TS files for repeated helper definitions and then read the suspected duplicates to distinguish identical helpers from similar-but-different ones.

## Confirmed true duplicates / near-duplicates worth deduplicating

### 1. `test_endpoint()` shell helper repeated broadly

Files involved:

- `tests/infra/config.sh:13`
- `tests/providers/claude/basic.sh:8`
- `tests/providers/claude/config.sh:12` and again `:72` in the same file
- `tests/providers/deepseek/models.sh:208`
- `tests/providers/deepseek/basic.sh:12`
- `tests/providers/gemini/basic.sh:8`
- `tests/providers/claude/models.sh:56`, `:124`, `:182`
- `tests/providers/gemini/models.sh:158`, `:246`
- `tests/multi-model/all-models.sh:375`
- `tests/multi-model/three-models.sh:245`, `:312`
- Similar variants in `tests/providers/claude/modes.sh:36`, `:172`, `:285`

Confirmed by reading representative copies:

- `tests/infra/config.sh:13-29`
- `tests/providers/claude/basic.sh:8-24`
- `tests/providers/claude/config.sh:12-28` and `:72-88`
- `tests/providers/deepseek/basic.sh:12-28`
- `tests/providers/gemini/basic.sh:8-24`
- `tests/multi-model/all-models.sh:375-391`

These are functionally identical in shape:

```sh
test_endpoint() {
  local name=$1
  local url=$2
  local data=$3

  RESP=$(curl -s "$url" -H "Content-Type: application/json" -d "$data")

  if echo "$RESP" | jq -e '.id' > /dev/null 2>&1 && ! echo "$RESP" | jq -e '.error' > /dev/null 2>&1; then
    ID=$(echo "$RESP" | jq -r '.id')
    echo "✅ $name: $ID"
    ((PASS++))
  else
    ERROR=$(echo "$RESP" | jq -r '.error.message // .message // "Unknown error"' 2>/dev/null || echo "Connection failed")
    echo "❌ $name: $ERROR"
    ((FAIL++))
  fi
}
```

Differences are superficial or parameterizable:

- Some use `timeout 10 curl` (`deepseek/basic.sh`, `gemini/basic.sh`).
- Some use fallback `"Failed"` instead of `"Connection failed"`.
- Some return `0/1` instead of incrementing `PASS/FAIL` (`claude/modes.sh` variants).
- `gemini/models.sh:158` prints an extra truncated response on failure.
- `config.sh` contains a duplicated second half of the script, including another identical `test_endpoint()`.

Deduplication plan:

- Add a small sourced helper, e.g. `tests/infra/shell.sh` already exists and is the natural place if it matches project convention; otherwise create `tests/infra/test-helpers.sh`.
- Provide one helper such as `test_json_id_endpoint name url data [timeout_seconds] [failure_fallback]`.
- Keep behavior explicit: update `PASS`/`FAIL` by default, and optionally return status for scripts that need return-code behavior.
- Migrate a small cluster first: `tests/infra/config.sh`, `tests/providers/claude/basic.sh`, `tests/providers/gemini/basic.sh`, `tests/providers/deepseek/basic.sh`.
- Then migrate larger model suites after verifying no output expectations change.

## 2. `log_info` / `log_warn` / `log_error` and `curl_post()` duplicated between Messages API scripts

Files involved:

- `tests/api/v1-messages.sh:35-61`
- `tests/providers/llama/messages.sh:25-50`

Confirmed by reading both files.

True identical parts:

- Color variables are the same.
- `log_info`, `log_warn`, `log_error` are identical except comments/language around them.

Superficially similar but not identical:

- `curl_post()` differs:
  - `tests/api/v1-messages.sh` includes `-H "X-Api-Key: $API_KEY"`.
  - `tests/providers/llama/messages.sh` does not include an API key header.
  - Otherwise it has the same parameters, logging, `Content-Type`, `anthropic-version`, `time curl -s -X POST`, and `jq '.'`.

Deduplication plan:

- Extract the three logging functions into a shared shell helper.
- Extract a generic `curl_post_json()` that accepts optional auth header behavior, e.g. via an environment variable or fourth argument.
- Do **not** blindly replace both `curl_post()` implementations with one fixed function unless auth-header behavior is parameterized; otherwise llama tests would gain auth they currently do not send.

## 3. `parseDynamicRoute()` duplicated in JS routing/debug tests

Files involved:

- `tests/features/routing/fixed.js:17-118`
- `tests/api/sdk/integration.js:263-370`
- `tests/api/sdk/integration.js:449-550`

Confirmed by reading all three regions.

The implementation in `fixed.js:17-118` and `integration.js:449-550` is effectively identical except variable naming for the final path prefix:

- `fixed.js` uses `finalTargetPathPrefix`
- `integration.js` uses `targetPathPrefix`

The implementation at `integration.js:263-370` is also the same core algorithm, but includes extra `console.log()` debugging inside the parsing loop.

Also related but only superficially similar:

- `tests/api/sdk/integration.js:83-116` is a simplified hard-coded parse for one specific URL.
- `tests/api/sdk/integration.js:173-205` is a simplified `parseWithModelId()` for comparison.
- These should not be deduplicated into the full helper unless the surrounding test is rewritten, because they intentionally demonstrate a specific flow.

Deduplication plan:

- Prefer importing the real production parser if available rather than keeping test copies. This avoids tests passing against stale copied logic.
- If importing production code is not practical, create a local helper module under `tests/infra/` or `tests/api/sdk/` and reuse it from:
  - `tests/features/routing/fixed.js`
  - the repeated full parser sections in `tests/api/sdk/integration.js`
- Leave the intentionally simplified explanatory snippets alone unless the whole `integration.js` debug script is cleaned up.

## 4. `buildTargetUrl()` duplicated in `tests/api/sdk/integration.js`

Files involved:

- `tests/api/sdk/integration.js:126-135`
- `tests/api/sdk/integration.js:372-381`
- `tests/api/sdk/integration.js:552-561`

Confirmed by reading.

These are identical:

```js
function buildTargetUrl(targetConfig, endpoint, modelId) {
  let url = `${targetConfig.targetUrl}${targetConfig.targetPathPrefix}`;

  if (modelId) {
    url += `/${modelId}`;
  }

  url += `/${endpoint}`;
  return url;
}
```

Deduplication plan:

- Within `integration.js`, define it once near the top and reuse it.
- If `parseDynamicRoute()` is extracted, put `buildTargetUrl()` beside it or import the production implementation if one exists.

## 5. Multi-agent test helper overlap: similar but not fully identical

Files involved:

- `tests/multi-agents-test.ts`
- `tests/multi-agents-composite.ts`

Read regions:

- `tests/multi-agents-test.ts:145-197`
- `tests/multi-agents-composite.ts:162-242`

Confirmed truly identical / nearly identical:

- `toolGlobSync()` is the same algorithm.
  - Only meaningful difference: `multi-agents-test.ts` has a comment `// skip hidden`; composite omits the comment.
- `toolGlob()` is identical.
- `toolRead()` is identical except TypeScript context is the same.

Not identical:

- `multi-agents-composite.ts` adds `toolGrep()`.
- `toolMap` includes `Grep` in composite but not in the simpler test.
- Agent runners (`runCodexAgent`, `runClaudeAgent`, `runGeminiAgent`) are conceptually similar but not duplicates:
  - composite versions return structured `AgentResult`, track tool calls, elapsed time, and errors.
  - simple versions mostly log output.

Deduplication plan:

- Extract only the shared read-only tool helpers:
  - `toolGlobSync`
  - `toolGlob`
  - `toolRead`
- Keep `toolGrep()` composite-only unless the simpler test should also expose grep.
- Do not deduplicate agent runners unless you intentionally want to refactor behavior, because they differ materially.

## 6. Token-counting source-file helper: similar but not identical

Files involved:

- `tests/features/token-counting/sdk.ts:81-100`
- `tests/features/token-counting/all-models.sh:37-40`

These both collect TypeScript files from `src`, but they are not identical:

- `sdk.ts` recursively walks with Node APIs and uses `path.join(__dirname, '../src')`.
- `all-models.sh` uses a hard-coded absolute path:
  - `/home/teric/win/e/dev/bot/model_proxy_v3/src`
- Shell version relies on `find`, TypeScript version relies on `fs.readdirSync`.

Deduplication plan:

- Do not force a shared helper across shell and TypeScript.
- If touching this area, fix the hard-coded path in the shell script to derive repo root, but that is path cleanup rather than helper deduplication.

## 7. Retry/concurrency loops: mostly superficial, not safe to deduplicate

Files read:

- `tests/api/v1-messages.sh:326-358`
- `tests/providers/llama/messages.sh:155-177`
- `tests/providers/llama/messages.sh:219-235`
- `tests/features/thinking/basic.sh:17-24`

Findings:

- The `{1..3}` loops in `v1-messages.sh` and `llama/messages.sh` look like concurrency/retry helpers, but they are inline test logic and not identical:
  - different endpoints
  - different auth headers
  - different output formatting
  - one is labeled concurrency but does not actually background curls
- `features/thinking/basic.sh` has a server readiness loop, not the same kind of retry helper.

Deduplication plan:

- No immediate shared helper recommended here.
- If improved later, first fix semantics: the “concurrent” loops currently do not use `&`, so deduplicating them as concurrency helpers would encode misleading behavior.

## Recommended order of work

1. **Shell endpoint helper first**: highest duplication and lowest conceptual risk if parameterized carefully.
2. **Shell logging + `curl_post` second**: easy, but preserve auth-header differences.
3. **JS route helpers third**: best done by importing production parser/build URL if available; otherwise extract test-local helper.
4. **Multi-agent shared tool helpers last**: straightforward, but less broadly useful.
5. **Avoid deduping retry/concurrency loops for now**: they are superficially similar and some are semantically questionable.
Claude done. status=success


###
node tests/multi-agents-test.ts 1 3 2
Selection: 1 model(s) x 1 agent(s) x 1 task(s)
  model:  gpt-5.5
  agent:  Gemini
  task:   duplicate_helpers

=========== Task: duplicate_helpers | Model: gpt-5.5 ===========

--- Gemini Agent | model=gpt-5.5 ---
  Tool call: Glob({"pattern":"tests/**/*"})
  Tool call: Glob({"pattern":"tests/**/*.sh"})
  Tool call: Glob({"pattern":"tests/**/*.js"})
  Tool call: Glob({"pattern":"tests/**/*.ts"})
  Tool call: Read({"path":"tests/infra/shell.sh"})
  Tool call: Read({"path":"tests/infra/config.sh"})
  Tool call: Read({"path":"tests/api/cached-content.sh"})
  Tool call: Read({"path":"tests/api/interactions.sh"})
  Tool call: Read({"path":"tests/api/responses.sh"})
  Tool call: Read({"path":"tests/api/v1-messages.sh"})
  Tool call: Read({"path":"tests/features/streaming/sse.sh"})
  Tool call: Read({"path":"tests/features/streaming/stream-generate.sh"})
  Tool call: Read({"path":"tests/features/thinking/basic.sh"})
  Tool call: Read({"path":"tests/features/thinking/models.sh"})
  Tool call: Read({"path":"tests/features/thinking/cli.sh"})
  Tool call: Read({"path":"tests/features/routing/model.sh"})
  Tool call: Read({"path":"tests/features/routing/wildcard.sh"})
  Tool call: Read({"path":"tests/features/streaming/cli.sh"})
  Tool call: Read({"path":"tests/features/token-counting/all-models.sh"})
  Tool call: Read({"path":"tests/multi-model/all-models.sh"})
  Tool call: Read({"path":"tests/multi-model/two-models.sh"})
  Tool call: Read({"path":"tests/multi-model/three-models.sh"})
  Tool call: Read({"path":"tests/multi-model/five-models.sh"})
  Tool call: Read({"path":"tests/multi-model/failed.sh"})
  Tool call: Read({"path":"tests/multi-model/oversea.sh"})
  Tool call: Read({"path":"tests/providers/claude/basic.sh"})
  Tool call: Read({"path":"tests/providers/deepseek/basic.sh"})
  Tool call: Read({"path":"tests/providers/gemini/basic.sh"})
  Tool call: Read({"path":"tests/providers/gemini/sdk/api.js"})
  Tool call: Read({"path":"tests/providers/gemini/sdk/debug.js"})
  Tool call: Read({"path":"tests/providers/gemini/sdk/native.js"})
  Tool call: Read({"path":"tests/providers/gemini/sdk/openai-compatible.js"})
  Tool call: Read({"path":"tests/providers/gemini/sdk/simple.js"})
  Tool call: Read({"path":"tests/providers/gemini/sdk/summary.js"})
  Tool call: Read({"path":"tests/api/sdk/integration.js"})
  Tool call: Read({"path":"tests/features/thinking/boolean.js"})
  Tool call: Read({"path":"tests/infra/shell.sh"})
  Tool call: Read({"path":"tests/multi-model/two-models.sh"})
  Tool call: Read({"path":"tests/providers/glm/basic.sh"})
  Tool call: Read({"path":"tests/providers/minimax/basic.sh"})
  Tool call: Read({"path":"tests/providers/llama/messages.sh"})
  Tool call: Read({"path":"tests/providers/claude/models.sh"})
  Tool call: Read({"path":"tests/providers/gemini/models.sh"})
  Tool call: Read({"path":"tests/providers/gemini/streaming.sh"})
  Tool call: Read({"path":"tests/infra/shell.sh"})
  Tool call: Read({"path":"tests/infra/shell.sh"})
  Tool call: Read({"path":"tests/infra/shell.sh"})
  Tool call: Read({"path":"tests/multi-model/two-models.sh"})


Gemini output:
Searched `./tests/` shell/JS/TS test files for duplicated helper-style code. I focused on helpers around curl wrappers, endpoint assertions, SSE checks, test runners, and fetch/request helpers. I did not treat historical `tests/logs/**` as actionable test code.

## Confirmed duplicate / near-duplicate helpers

### 1. JSON endpoint assertion helper: `test_endpoint()`

#### Truly identical core pattern

These files contain the same helper pattern:

```bash
test_endpoint() {
  local name=$1
  local url=$2
  local data=$3

  RESP=$(curl -s "$url" -H "Content-Type: application/json" -d "$data")

  if echo "$RESP" | jq -e '.id' > /dev/null 2>&1 && ! echo "$RESP" | jq -e '.error' > /dev/null 2>&1; then
    ID=$(echo "$RESP" | jq -r '.id')
    echo "✅ $name: $ID"
    ((PASS++))
  else
    ERROR=$(echo "$RESP" | jq -r '.error.message // .message // "Unknown error"' 2>/dev/null || echo "Connection failed")
    echo "❌ $name: $ERROR"
    ((FAIL++))
  fi
}
```

Files involved:

- `tests/infra/config.sh`
- `tests/providers/gemini/models.sh`
- `tests/providers/claude/models.sh`
- Parts of `tests/multi-model/all-models.sh`

These are effectively identical except for surrounding setup, model lists, and comments.

#### Same helper with small behavioral differences

These are not byte-identical, but clearly variants of the same helper:

- `tests/features/thinking/models.sh`
  - Same success condition, but wraps curl in `timeout 20`.
  - Error fallback says `"Failed"` instead of `"Connection failed"`.
- `tests/providers/deepseek/basic.sh`
  - Same success condition, but uses `timeout 10`.
- `tests/providers/claude/basic.sh`
  - Same shape, but embedded in `test_mode()` and config-writing flow.
- `tests/providers/gemini/basic.sh`
  - Same shape, but used inside mode-switching config tests.
- `tests/multi-model/oversea.sh`
  - Same endpoint-test idea, but expanded to non-stream/stream/generateContent checks.

### Deduplication plan

Create `tests/infra/common.sh` with reusable helpers:

```bash
init_counters() {
  PASS=0
  FAIL=0
}

assert_json_id_success() {
  local name="$1"
  local resp="$2"
  local error_fallback="${3:-Connection failed}"

  if echo "$resp" | jq -e '.id' > /dev/null 2>&1 && ! echo "$resp" | jq -e '.error' > /dev/null 2>&1; then
    local id
    id=$(echo "$resp" | jq -r '.id')
    echo "✅ $name: $id"
    ((PASS++))
  else
    local error
    error=$(echo "$resp" | jq -r '.error.message // .message // "Unknown error"' 2>/dev/null || echo "$error_fallback")
    echo "❌ $name: $error"
    ((FAIL++))
  fi
}

post_json() {
  local url="$1"
  local data="$2"
  local timeout_seconds="${3:-}"

  if [ -n "$timeout_seconds" ]; then
    timeout "$timeout_seconds" curl -s "$url" -H "Content-Type: application/json" -d "$data"
  else
    curl -s "$url" -H "Content-Type: application/json" -d "$data"
  fi
}

test_endpoint() {
  local name="$1"
  local url="$2"
  local data="$3"
  local timeout_seconds="${4:-}"

  local resp
  resp=$(post_json "$url" "$data" "$timeout_seconds")
  assert_json_id_success "$name" "$resp"
}
```

Then update:

- `tests/infra/config.sh`
- `tests/providers/gemini/models.sh`
- `tests/providers/claude/models.sh`
- `tests/providers/deepseek/basic.sh`
- `tests/features/thinking/models.sh`
- `tests/multi-model/all-models.sh`

to source it:

```bash
source "$(dirname "$0")/../infra/common.sh"
```

or use a robust repo-root-relative form depending on current working directory.

---

## 2. Header-aware endpoint helper

### Confirmed near-duplicate

A second variant adds a custom auth/header argument:

```bash
test_endpoint() {
  local name=$1
  local url=$2
  local header=$3
  local data=$4

  RESP=$(curl -s "$url" -H "Content-Type: application/json" -H "$header" -d "$data")

  if echo "$RESP" | jq -e '.id' > /dev/null 2>&1 && ! echo "$RESP" | jq -e '.error' > /dev/null 2>&1; then
    ID=$(echo "$RESP" | jq -r '.id')
    echo "✅ $name: $ID"
    ((PASS++))
  else
    ERROR=$(echo "$RESP" | jq -r '.error.message // .message // "Unknown error"' 2>/dev/null || echo "Connection failed")
    echo "❌ $name: $ERROR"
    ((FAIL++))
  fi
}
```

Files involved:

- `tests/multi-model/three-models.sh`
- `tests/multi-model/all-models.sh` contains similar/embedded forms
- Some multi-upstream sections in `tests/multi-model/two-models.sh` / `tests/multi-model/three-models.sh` style scripts use the same pattern

### Identical or superficial?

Not fully byte-identical across all files because some scripts have:

- `header` as an explicit argument
- no header argument
- hardcoded `Authorization`
- `timeout`
- different fallback error text

But the response validation body is the same.

### Deduplication plan

Extend `tests/infra/common.sh`:

```bash
post_json_with_header() {
  local url="$1"
  local header="$2"
  local data="$3"
  local timeout_seconds="${4:-}"

  if [ -n "$timeout_seconds" ]; then
    timeout "$timeout_seconds" curl -s "$url" \
      -H "Content-Type: application/json" \
      -H "$header" \
      -d "$data"
  else
    curl -s "$url" \
      -H "Content-Type: application/json" \
      -H "$header" \
      -d "$data"
  fi
}

test_endpoint_with_header() {
  local name="$1"
  local url="$2"
  local header="$3"
  local data="$4"
  local timeout_seconds="${5:-}"

  local resp
  resp=$(post_json_with_header "$url" "$header" "$data" "$timeout_seconds")
  assert_json_id_success "$name" "$resp"
}
```

Use this in the multi-upstream tests rather than keeping per-file copies.

---

## 3. SSE/streaming assertion helpers

### Confirmed similar helpers

Several files contain repeated SSE checks:

```bash
if echo "$RESP" | grep -qE "^(event:|data:)"; then
  echo "✅ ..."
  ((PASS++))
else
  echo "❌ ... No SSE ..."
  ((FAIL++))
fi
```

Files involved:

- `tests/features/streaming/sse.sh`
- `tests/features/streaming/stream-generate.sh`
- `tests/providers/gemini/streaming.sh`
- `tests/features/thinking/models.sh`
- `tests/features/thinking/basic.sh`
- `tests/multi-model/oversea.sh`
- `tests/providers/minimax/basic.sh`
- `tests/providers/glm/basic.sh`

### Identical or superficial?

Only superficially similar in many cases.

Differences include:

- Some use `curl -s -N`.
- Some pipe to `head -1`; others to `head -3` or `head -20`.
- Some use `timeout 3`, `timeout 10`, `timeout 20`.
- Some treat `"not allowed"` as expected success, e.g. `tests/features/streaming/sse.sh` for `/v1/chat/completions`.
- Some check `data:` only; others check `event:` or `data:`.
- Some only print result and do not maintain global counters.

Still, the lower-level primitive is the same: “POST JSON, read streaming response, assert SSE marker exists.”

### Deduplication plan

Add a lower-level helper, not a one-size-fits-all replacement:

```bash
post_json_stream_sample() {
  local url="$1"
  local data="$2"
  local lines="${3:-20}"
  local timeout_seconds="${4:-}"

  if [ -n "$timeout_seconds" ]; then
    timeout "$timeout_seconds" curl -s -N "$url" \
      -H "Content-Type: application/json" \
      -d "$data" 2>/dev/null | head -"$lines"
  else
    curl -s -N "$url" \
      -H "Content-Type: application/json" \
      -d "$data" 2>/dev/null | head -"$lines"
  fi
}

assert_sse_seen() {
  local name="$1"
  local resp="$2"

  if echo "$resp" | grep -qE "^(event:|data:)"; then
    local count
    count=$(echo "$resp" | grep -cE "^(event:|data:)")
    echo "✅ $name: SSE streaming works ($count events)"
    ((PASS++))
  else
    echo "❌ $name: No SSE events detected"
    ((FAIL++))
  fi
}
```

For special cases like “blocked endpoint should contain `not allowed`”, keep local assertions or add a separate helper:

```bash
assert_contains_success() {
  local name="$1"
  local resp="$2"
  local pattern="$3"
  local success_message="$4"
}
```

---

## 4. Bash logging and `curl_post()` wrappers

### Confirmed similar helpers

`tests/api/v1-messages.sh` and `tests/providers/llama/messages.sh` both define:

- `RED`, `GREEN`, `YELLOW`, `NC`
- `log_info`
- `log_warn`
- `log_error`
- `curl_post`

The log helpers are effectively identical.

The `curl_post` wrappers are similar but not identical:

- `tests/api/v1-messages.sh`
  - Sends `anthropic-version`
  - Sends `X-Api-Key: $API_KEY`
  - Tests both direct and proxy endpoints.
- `tests/providers/llama/messages.sh`
  - Sends `anthropic-version`
  - Does not send API key.
  - Uses only local proxy endpoint.

### Identical or superficial?

- Logging helpers: truly duplicated.
- `curl_post`: superficially similar; header behavior differs.

### Deduplication plan

Add logging helpers to `tests/infra/common.sh`:

```bash
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
```

Add a flexible curl wrapper that accepts optional extra headers:

```bash
curl_post_json() {
  local endpoint="$1"
  local data="$2"
  local desc="$3"
  shift 3

  log_info "测试: $desc"
  log_info "端点: $endpoint"

  time curl -s -X POST "$endpoint" \
    -H "Content-Type: application/json" \
    "$@" \
    -d "$data" | jq '.'
}
```

Then callers can do:

```bash
curl_post_json "$endpoint" "$data" "$desc" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: $API_KEY"
```

or omit the API key for Llama.

---

## 5. JS `makeRequest()` helpers

### Confirmed similar helpers

Files involved:

- `tests/providers/gemini/sdk/api.js`
- `tests/providers/gemini/sdk/summary.js`
- `tests/providers/gemini/sdk/native.js`
- `tests/providers/gemini/sdk/openai-compatible.js`
- `tests/providers/gemini/sdk/simple.js`

Patterns found:

- `fetch(BASE_URL + endpoint, { method: 'POST', headers, body: JSON.stringify(...) })`
- repeated JSON request construction
- repeated stream reader loops in native/openai-compatible tests
- repeated response status/body logging

### Identical or superficial?

Mostly superficially similar, not identical.

Examples:

- `api.js` has a richer `makeRequest(endpoint, method, body, headers)` that parses JSON and returns `{ status, ok, data, headers }`.
- `summary.js` has a simpler `makeRequest(endpoint, body)` that returns the raw `Response`.
- `native.js` and `openai-compatible.js` have very similar streaming read loops, but headers/auth differ.
- `simple.js` has a bug-like reference to `json1` inside a `json` block, so it should not be blindly deduplicated without cleanup.

### Deduplication plan

Create `tests/infra/http.js` or `tests/providers/gemini/sdk/helpers.js`:

```js
export async function makeJsonRequest(baseUrl, endpoint, {
  method = 'POST',
  body,
  headers = {},
} = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  return {
    response,
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
    text,
    data,
  };
}

export async function readStreamChunks(response, maxChunks = 10) {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const chunks = [];

  if (!reader) return chunks;

  while (chunks.length < maxChunks) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }

  return chunks;
}
```

Then update Gemini SDK tests to share request/stream code while keeping provider-specific headers local.

---

## 6. Test runner helpers in JS

### Confirmed similar helpers

`tests/providers/gemini/sdk/api.js` and `tests/providers/gemini/sdk/summary.js` both define small test-runner helpers:

- `runTest(name, testFn)`
- results collection
- pass/fail reporting

### Identical or superficial?

Similar, not identical:

- `api.js` stores `passed`, `failed`, `skipped`.
- `summary.js` returns `{ name, status }` objects and prints a table-like summary.

### Deduplication plan

Create `tests/infra/test-runner.js`:

```js
export function createResults() {
  return { passed: [], failed: [], skipped: [] };
}

export async function runTest(results, name, fn) {
  console.log(`\n🧪 Testing: ${name}`);
  try {
    await fn();
    results.passed.push(name);
    console.log('  ✅ PASSED');
  } catch (error) {
    results.failed.push({ name, error: error.message });
    console.log(`  ❌ FAILED: ${error.message}`);
  }
}

export function assert(condition, message = 'Assertion failed') {
  if (!condition) throw new Error(message);
}
```

Use it in Gemini SDK tests.

---

## 7. Auth-header builders

### Finding

There are repeated inline auth-header constructions, but few explicit helper functions.

Examples:

- `Authorization: Bearer $API_KEY`
- `x-api-key: $API_KEY`
- `x-goog-api-key: $API_KEY`
- dynamic choice between bearer and API-key style in multi-upstream tests

### Identical or superficial?

Superficially similar. The auth header type is test-specific and depends on endpoint/provider.

### Deduplication plan

Do not over-abstract all auth headers. Add only tiny helpers where tests repeatedly switch between auth types:

```bash
auth_header() {
  local type="$1"
  local key="$2"

  case "$type" in
    bearer) echo "Authorization: Bearer $key" ;;
    x-api-key) echo "x-api-key: $key" ;;
    x-goog-api-key) echo "x-goog-api-key: $key" ;;
    *) echo "$type: $key" ;;
  esac
}
```

Use this in multi-upstream tests such as:

- `tests/multi-model/three-models.sh`
- `tests/multi-model/two-models.sh`
- `tests/multi-model/oversea.sh`

---

# Recommended implementation order

1. Add `tests/infra/common.sh` with:
   - logging helpers
   - counter initialization
   - `assert_json_id_success`
   - `post_json`
   - `post_json_with_header`
   - `test_endpoint`
   - `test_endpoint_with_header`
   - `post_json_stream_sample`
   - `assert_sse_seen`
   - optional `auth_header`

2. Refactor first low-risk identical group:
   - `tests/infra/config.sh`
   - `tests/providers/gemini/models.sh`
   - `tests/providers/claude/models.sh`
   - `tests/providers/deepseek/basic.sh`

3. Refactor SSE helpers next:
   - `tests/features/streaming/sse.sh`
   - `tests/features/streaming/stream-generate.sh`
   - `tests/providers/gemini/streaming.sh`
   - `tests/features/thinking/models.sh`

4. Add JS helpers:
   - `tests/infra/http.js`
   - `tests/infra/test-runner.js`

5. Refactor Gemini SDK tests:
   - `tests/providers/gemini/sdk/api.js`
   - `tests/providers/gemini/sdk/summary.js`
   - `tests/providers/gemini/sdk/native.js`
   - `tests/providers/gemini/sdk/openai-compatible.js`
   - `tests/providers/gemini/sdk/simple.js`

6. Leave highly concatenated/experimental scripts for last:
   - `tests/multi-model/all-models.sh`
   - `tests/multi-model/three-models.sh`
   - `tests/multi-model/oversea.sh`

These contain multiple pasted test scripts in one file, so they should be cleaned structurally before deeper deduplication.


###
node tests/multi-agents-test.ts 1 3 1
Selection: 1 model(s) x 1 agent(s) x 1 task(s)
  model:  gpt-5.5
  agent:  Gemini
  task:   codebase_layout

=========== Task: codebase_layout | Model: gpt-5.5 ===========

--- Gemini Agent | model=gpt-5.5 ---
  Tool call: Glob({"pattern":"tests/**"})
  Tool call: Read({"path":"/workspace/tests/README.md"})
  Tool call: Glob({"pattern":"*"})
  Tool call: Read({"path":"/workspace/README.md"})
Gemini output:
Based on the `./tests/` file structure, the suite is organized around several clear domains, but there are a few top-level scripts, generated artifacts, and mixed-purpose directories that could be tightened up.

## Current layout by purpose

### 1. Test documentation

```text
tests/README.md
```

Purpose: high-level test documentation.

Suggestion: keep this at the root of `tests/`. It should ideally explain:

- how to run shell/JS/TS tests
- required env vars/API keys
- provider-specific caveats
- whether `logs/` and `results.json` are generated or checked-in expected outputs

---

### 2. API endpoint / compatibility tests

```text
tests/api/cached-content.sh
tests/api/interactions.sh
tests/api/responses.sh
tests/api/v1-messages.sh
tests/api/sdk/integration.js
```

Purpose: tests for API routes/protocols such as responses, interactions, cached content, and v1 messages.

This is a good grouping.

Potential issue:

```text
tests/api/sdk/integration.js
```

This looks like SDK/client integration testing rather than an API endpoint test. It may still belong here if it tests SDK behavior against the API surface, but the structure is slightly inconsistent with:

```text
tests/providers/gemini/sdk/*.js
```

Suggestion: choose one convention:

```text
tests/api/
  responses.sh
  interactions.sh
  v1-messages.sh
  cached-content.sh
  integration/
    sdk.js
```

or:

```text
tests/sdk/
  api-integration.js
  providers/
    gemini/
      native.js
      openai-compatible.js
```

---

### 3. Feature suites

```text
tests/features/routing/fixed.js
tests/features/routing/model.sh
tests/features/routing/wildcard.sh

tests/features/streaming/cli.sh
tests/features/streaming/sse.sh
tests/features/streaming/stream-generate.sh

tests/features/thinking/basic.sh
tests/features/thinking/boolean.js
tests/features/thinking/cli.sh
tests/features/thinking/models.sh

tests/features/token-counting/all-models.sh
tests/features/token-counting/js-tiktoken.js
tests/features/token-counting/local-perf.ts
tests/features/token-counting/results.json
tests/features/token-counting/sdk.ts
```

Purpose: cross-provider feature validation.

This is mostly well structured.nano

Potentially misplaced items:

```text
tests/features/token-counting/local-perf.ts
```

This sounds like a performance benchmark rather than a feature correctness test. Consider moving to:

```text
tests/perf/token-counting-local.ts
```

or:

```text
tests/features/token-counting/perf/local.ts
```

if it is tightly coupled to the token-counting feature.

Also:

```text
tests/features/token-counting/results.json
```

This could be one of three things:

1. expected fixture/snapshot
2. generated test output
3. manually curated model result data

If it is expected output, consider:

```text
tests/features/token-counting/__snapshots__/results.json
```

or:

```text
tests/fixtures/token-counting/results.json
```

If generated, it should probably move out of `tests/` or be ignored:

```text
artifacts/tests/token-counting/results.json
```

---

### 4. Provider-specific test suites

```text
tests/providers/claude/basic.sh
tests/providers/claude/config.sh
tests/providers/claude/models.sh
tests/providers/claude/modes.sh

tests/providers/deepseek/basic.sh
tests/providers/deepseek/models.sh

tests/providers/gemini/basic.sh
tests/providers/gemini/cli.sh
tests/providers/gemini/endpoints.sh
tests/providers/gemini/models.sh
tests/providers/gemini/modes.sh
tests/providers/gemini/streaming.sh
tests/providers/gemini/sdk/api.js
tests/providers/gemini/sdk/debug.js
tests/providers/gemini/sdk/native.js
tests/providers/gemini/sdk/openai-compatible.js
tests/providers/gemini/sdk/simple.js
tests/providers/gemini/sdk/summary.js

tests/providers/glm/basic.sh

tests/providers/llama/messages.sh

tests/providers/minimax/basic.sh
```

Purpose: provider-specific behavior, model support, modes, endpoints, SDK behavior.

This is a strong and intuitive grouping.

Potential issues:

```text
tests/providers/claude/config.sh
```

The name `config.sh` sounds like a helper/config file rather than a test. If it is a test, consider renaming:

```text
tests/providers/claude/configuration.sh
tests/providers/claude/config-test.sh
```

If it is shared setup, move to:

```text
tests/providers/claude/helpers/config.sh
```

or:

```text
tests/infra/providers/claude-config.sh
```

Also, Gemini has a large SDK-specific sub-suite:

```text
tests/providers/gemini/sdk/*.js
```

That is fine if these are Gemini-only SDK tests, but it creates a mismatch with:

```text
tests/api/sdk/integration.js
```

Consider standardizing SDK test placement.

---

### 5. Multi-model / model matrix tests

```text
tests/multi-model/all-models.sh
tests/multi-model/failed.sh
tests/multi-model/five-models.sh
tests/multi-model/oversea.sh
tests/multi-model/three-models.sh
tests/multi-model/two-models.sh
```

Purpose: matrix-style tests across multiple models.

Mostly fine.

Potential issues:

```text
tests/multi-model/failed.sh
```

This name is ambiguous. Is it:

- a test expected to fail?
- a list of previously failed models?
- a regression test for failures?
- a quarantine script?

Suggested renames:

```text
tests/multi-model/regression-failures.sh
tests/multi-model/known-failures.sh
tests/multi-model/quarantined.sh
```

Also:

```text
tests/multi-model/oversea.sh
```

Maybe rename to something clearer, depending on intent:

```text
tests/multi-model/international.sh
tests/multi-model/non-domestic.sh
tests/multi-model/overseas-models.sh
```

---

### 6. Multi-agent tests

```text
tests/multi-agents-composite.ts
tests/multi-agents-test.ts
```

Purpose: multi-agent behavior tests.

These are currently at the root of `tests/`, which makes them stand out as less organized than the rest of the suite.

Suggestion: move them into their own suite directory:

```text
tests/features/multi-agents/composite.ts
tests/features/multi-agents/basic.ts
```

or:

```text
tests/agents/composite.ts
tests/agents/basic.ts
```

If “multi-agents” is a first-class domain like “multi-model”, then:

```text
tests/multi-agents/composite.ts
tests/multi-agents/basic.ts
```

would be consistent.

---

### 7. Fixtures

```text
tests/fixtures/hermes-notools.txt
tests/fixtures/hermes.txt
```

Purpose: static input/output fixtures.

This is a good location.

Suggestion: if fixtures grow, organize by feature/provider:

```text
tests/fixtures/
  hermes/
    with-tools.txt
    no-tools.txt
```

or:

```text
tests/fixtures/thinking/hermes.txt
tests/fixtures/thinking/hermes-notools.txt
```

---

### 8. Test infrastructure / shared helpers

```text
tests/infra/config.sh
tests/infra/debug-config.js
tests/infra/shell.sh
tests/infra/tool-blocklist.ts
tests/infra/version.sh
```

Purpose: common test runtime config, shell helpers, debug utilities, version checks, blocklists.

This is a sensible grouping.

Potential issue:

```text
tests/infra/version.sh
```

If this is an actual test, consider placing it under a feature or API suite. If it is a helper that checks/prints versions, it belongs in `infra`.

Similarly:

```text
tests/infra/debug-config.js
```

If executable as a diagnostic script rather than imported helper, it may fit better in:

```text
tests/scripts/debug-config.js
```

---

### 9. Performance tests

```text
tests/perf/benchmark.ts
```

Purpose: benchmark/perf testing.

Good.

Related possible move:

```text
tests/features/token-counting/local-perf.ts
```

could probably join this directory.

Suggested:

```text
tests/perf/benchmark.ts
tests/perf/token-counting-local.ts
```

---

### 10. Test runner scripts

```text
tests/run-single-test-case.js
tests/run-tests-loop-wrapper.js
```

Purpose: runner/wrapper scripts.

These are currently at the root of `tests/`.

Suggestion: move to a dedicated scripts directory:

```text
tests/scripts/run-single-test-case.js
tests/scripts/run-tests-loop-wrapper.js
```

or, if they are not test-specific:

```text
scripts/tests/run-single-test-case.js
scripts/tests/run-tests-loop-wrapper.js
```

Keeping runner scripts separate from suites makes the root cleaner.

---

### 11. Logs and generated results

```text
tests/logs/fix-sessions/*.md
tests/logs/results/*.md
```

Purpose: historical test runs, debugging sessions, result reports.

This is the biggest layout concern.

These look like generated artifacts or historical records rather than test inputs. They can create noise in the test tree and make it harder to distinguish executable tests from old output.

Examples:

```text
tests/logs/fix-sessions/fixing_tests_2026-06-13_19-11-00.md
tests/logs/results/test_results_at_2026-06-14_18-17-59.md
tests/logs/results/test_result_of_sse.md
```

Suggestion: move these outside `tests/` unless they are intentionally curated fixtures.

Possible destinations:

```text
artifacts/tests/logs/
```

or:

```text
.test-results/
```

or:

```text
docs/testing/history/
```

If they are committed intentionally as investigation notes, `docs/testing/` is probably a better fit:

```text
docs/testing/fix-sessions/
docs/testing/results/
```

If they are generated, add to `.gitignore`:

```gitignore
tests/logs/
.test-results/
artifacts/tests/
```

---

## Items that look potentially misplaced

| File/path | Why it stands out | Suggested location |
|---|---|---|
| `tests/logs/**` | Looks generated/historical, not executable tests | `artifacts/tests/`, `.test-results/`, or `docs/testing/` |
| `tests/multi-agents-composite.ts` | Top-level suite file | `tests/multi-agents/composite.ts` or `tests/features/multi-agents/composite.ts` |
| `tests/multi-agents-test.ts` | Top-level suite file | `tests/multi-agents/basic.ts` |
| `tests/run-single-test-case.js` | Runner script at test root | `tests/scripts/run-single-test-case.js` |
| `tests/run-tests-loop-wrapper.js` | Runner script at test root | `tests/scripts/run-tests-loop-wrapper.js` |
| `tests/features/token-counting/local-perf.ts` | Perf test inside feature suite | `tests/perf/token-counting-local.ts` |
| `tests/features/token-counting/results.json` | May be generated or expected output; unclear | `__snapshots__/`, `fixtures/`, or `artifacts/` |
| `tests/api/sdk/integration.js` | SDK test placement inconsistent with provider SDK tests | `tests/sdk/api-integration.js` or `tests/api/integration/sdk.js` |
| `tests/providers/claude/config.sh` | Could be helper or test; name ambiguous | Rename to `configuration.sh` if test, or move to helper/config area |
| `tests/multi-model/failed.sh` | Ambiguous test intent | Rename to `known-failures.sh`, `quarantined.sh`, or `regression-failures.sh` |

---

## Suggested target structure

A cleaner layout could look like this:

```text
tests/
  README.md

  api/
    cached-content.sh
    interactions.sh
    responses.sh
    v1-messages.sh
    integration/
      sdk.js

  features/
    routing/
      fixed.js
      model.sh
      wildcard.sh
    streaming/
      cli.sh
      sse.sh
      stream-generate.sh
    thinking/
      basic.sh
      boolean.js
      cli.sh
      models.sh
    token-counting/
      all-models.sh
      js-tiktoken.js
      sdk.ts
      __snapshots__/
        results.json
    multi-agents/
      basic.ts
      composite.ts

  providers/
    claude/
    deepseek/
    gemini/
      sdk/
    glm/
    llama/
    minimax/

  multi-model/
    all-models.sh
    two-models.sh
    three-models.sh
    five-models.sh
    overseas-models.sh
    known-failures.sh

  fixtures/
    hermes/
      with-tools.txt
      no-tools.txt

  infra/
    config.sh
    shell.sh
    tool-blocklist.ts
    version.sh

  perf/
    benchmark.ts
    token-counting-local.ts

  scripts/
    run-single-test-case.js
    run-tests-loop-wrapper.js
    debug-config.js
```

And outside `tests/`:

```text
artifacts/
  tests/
    logs/
    results/
```

or:

```text
docs/
  testing/
    fix-sessions/
    historical-results/
```

---

## Overall assessment

The structure is already fairly understandable: API tests, feature suites, provider suites, fixtures, infra, perf, and multi-model tests are separated reasonably well.

The main improvements would be:

1. Move generated logs/results out of `tests/`.
2. Create `tests/scripts/` for runner/debug scripts.
3. Move top-level multi-agent tests into a dedicated directory.
4. Clarify whether `results.json` is a fixture, snapshot, or generated artifact.
5. Move token-counting perf code into `tests/perf/`.
6. Standardize SDK test placement across `tests/api/sdk` and `tests/providers/*/sdk`.
7. Rename ambiguous files like `failed.sh`, `oversea.sh`, and possibly `config.sh`.
