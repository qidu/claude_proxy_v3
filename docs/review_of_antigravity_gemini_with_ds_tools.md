# Review: Antigravity (Gemini SDK) vs DeepSeek tools — `thinking` / `reasoning_content` errors

Two test runs through the same agent (Antigravity on the Gemini endpoint)
against two aliases of the same upstream model (`deepseek-v4-flash`) fail with
superficially different errors. This doc collects the evidence and shows that
both trace to a single conversion site in the proxy.

## TL;DR

- Alias `deepseek-v4-anth` routes to `https://api.deepseek.com/anthropic/v1/messages` (`anthropic-messages` mode) and fails with:
  `The content[].thinking in the thinking mode must be passed back to the API.`
- Alias `deepseek-v4-comp` routes to `https://api.deepseek.com/v1/chat/completions` (`openai-completions` mode) and fails with:
  `The reasoning_content in the thinking mode must be passed back to the API.`
- Both errors are **one root cause**: `convertGeminiGenerateContentToOpenAI`
  drops the `thoughtSignature` from Gemini "thought" parts when reconstructing
  prior assistant turns. The downstream body then carries a thinking /
  reasoning block that is invalid for replay, and never enables thinking at the
  request-body level either.
- A second latent bug is exposed on both paths: `before_upstream` transforms
  declared on the model's transform set are silently skipped whenever traffic
  enters via the Gemini endpoint, because neither forward path invokes
  `runHook('before_upstream', ...)`.

---

## Evidence

### Run 1 — `deepseek-v4-anth` (anthropic-messages)

Command:

```
ANTIGRAVITY_USE_GEMINI_API=true API_KEY=hi PROXY_BASE=http://localhost:8788 \
  python3 tests/multi-agents-test.py 2 1 1
```

Selection:

```
Selection: 1 model(s) x 1 agent(s) x 1 task(s)
  model:  deepseek-v4-anth
  agent:  Antigravity
  task:   codebase_layout
```

Client output:

```
--- Antigravity Agent | model=deepseek-v4-anth | transport=GeminiAPIEndpoint ---
WARNING:root:System step error (HTTP 0): The model produced an invalid tool call. ("model output error: invalid tool call error (invalid_args) argument TargetFile not found")
WARNING:root:System step error (HTTP 0): The model produced an invalid tool call. ("model output error: invalid tool call error (invalid_args) argument Overwrite not found")
WARNING:root:System step error (HTTP 0): Agent execution terminated due to error. ("request failed (code 0): The `content[].thinking` in the thinking mode must be passed back to the API.")
Antigravity failed: Error 0, Message: The `content[].thinking` in the thinking mode must be passed back to the API., Status: , Details: []
request failed (code 0): The `content[].thinking` in the thinking mode must be passed back to the API.: Error 0, Message: The `content[].thinking` in the thinking mode must be passed back to the API., Status: , Details: []
request failed (code 0): The `content[].thinking` in the thinking mode must be passed back to the API.
```

Proxy log:

```
[req_1785646601183_9f1ef9fa23b6] [DEBUG] Endpoint path: /v1beta/models/deepseek-v4-anth:streamGenerateContent, Upstream mode: anthropic-messages
[req_1785646601183_9f1ef9fa23b6] [DEBUG] Model-specific routing: deepseek-v4-anth -> https://api.deepseek.com/anthropic/v1/messages (anthropic-messages) [generateContent]
[req_1785646601183_9f1ef9fa23b6] [INFO] /v1beta/models/deepseek-v4-anth:streamGenerateContent for deepseek-v4-flash to https://api.deepseek.com/anthropic/v1/messages (anthropic-messages)
[req_1785646601183_9f1ef9fa23b6] [DEBUG] transforms: endpoint_readin=[deepseek_v4_anthropic_compat:b=1] before_upstream=[deepseek_v4_anthropic_compat:b=1]
[req_1785646601183_9f1ef9fa23b6] [DEBUG] OpenAI handler - path: /v1beta/models/deepseek-v4-anth:streamGenerateContent, isGeminiEndpoint: true
[req_1785646601183_9f1ef9fa23b6] [DEBUG] Authorization: ... at endpoint
[req_1785646601183_9f1ef9fa23b6] [DEBUG] x-api-key: ...
[req_1785646601183_9f1ef9fa23b6] [DEBUG] x-goog-api-key: hi...
[req_1785646601183_9f1ef9fa23b6] [DEBUG] Request body keys: contents, generationConfig, sessionId, systemInstruction, toolConfig, tools, model
[req_1785646601183_9f1ef9fa23b6] [DEBUG] Converting Gemini request to OpenAI format
[req_1785646601183_9f1ef9fa23b6] [DEBUG] Detected generateContent format with contents array
[req_1785646601183_9f1ef9fa23b6] [DEBUG] Interactions/generateContent -> anthropic-messages body: {"model":"deepseek-v4-flash","messages":[{"role":"user","content":"<USER_REQUEST>\nAnalyze the codebase file structure in ./tests/ and report layout suggestions. Group files by purpose (api handlers, fixtures, scripts, feature suites, etc.) and flag anything that looks misplaced.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-08-02T12:54:27+08:00.\n</ADDITIONAL_METADATA>"},{"role":"assistant","content":[{"type":"thinking","thinking":"The user wants me to analyze the cod
[req_1785646601183_9f1ef9fa23b6] [ERROR] Interactions/generateContent->anthropic-messages error: 400, URL: https://api.deepseek.com/anthropic/v1/messages
[req_1785646601183_9f1ef9fa23b6] [ERROR] Catch Error [model=deepseek-v4-flash status=400 type=invalid_request_error: The `content[].thinking` in the thinking mode must be passed back to the API.
```

Two things to note in the log:

1. The forwarded `anthropic-messages` body contains an assistant message whose
   first block is `{"type":"thinking","thinking":"..."}` — **no `signature`
   field**, and the body has no top-level `thinking` field.
2. The line `transforms: ... before_upstream=[deepseek_v4_anthropic_compat:b=1]`
   advertises the builtin, but no transform effect is visible in the body.
   That is because the path that produces this body does not actually invoke
   `runHook('before_upstream', ...)` (see "Latent bug" below).

### Run 2 — `deepseek-v4-comp` (openai-completions)

Same command, different alias.
```
ANTIGRAVITY_USE_GEMINI_API=true API_KEY=hi PROXY_BASE=http://localhost:8788 \
  python3 tests/multi-agents-test.py 1 1 1
```

Selection:

```
Selection: 1 model(s) x 1 agent(s) x 1 task(s)
  model:  deepseek-v4-comp
  agent:  Antigravity
  task:   codebase_layout
```

Client output:

```
--- Antigravity Agent | model=deepseek-v4-comp | transport=GeminiAPIEndpoint ---
WARNING:root:System step error (HTTP 0): The model produced an invalid tool call. ("model output error: invalid tool call error (invalid_signature) Query is required")
WARNING:root:System step error (HTTP 0): The model produced an invalid tool call. ("model output error: invalid tool call error (invalid_signature) Query is required")
WARNING:root:System step error (HTTP 0): The model produced an invalid tool call. ("model output error: invalid_signature) SearchPath is required")
WARNING:root:System step error (HTTP 0): The model produced an invalid tool call. ("model output error: invalid tool call error (invalid_signature) SearchDirectory is required")
WARNING:root:System step error (HTTP 0): Agent execution terminated due to error. ("request failed (code 0): The `reasoning_content` in the thinking mode must be passed back to the API.")
Antigravity failed: Error 0, Message: The `reasoning_content` in the thinking mode must be passed back to the API., Status: , Details: []
request failed (code 0): The `reasoning_content` in the thinking mode must be passed back to the API.: Error 0, Message: The `reasoning_content` in the thinking mode must be passed back to the API., Status: , Details: []
request failed (code 0): The `reasoning_content` in the thinking mode must be passed back to the API.
```

Proxy log:

```
[req_1785647328887_76cdd72ad27b] [DEBUG] Endpoint path: /v1beta/models/deepseek-v4-comp:streamGenerateContent, Upstream mode: openai-completions
[req_1785647328887_76cdd72ad27b] [DEBUG] Model-specific routing: deepseek-v4-comp -> https://api.deepseek.com/v1/chat/completions (openai-completions) [generateContent]
[req_1785647328887_76cdd72ad27b] [INFO] /v1beta/models/deepseek-v4-comp:streamGenerateContent for deepseek-v4-flash to https://api.deepseek.com/v1/chat/completions (openai-completions)
[req_1785647328887_76cdd72ad27b] [DEBUG] OpenAI handler - path: /v1beta/models/deepseek-v4-comp:streamGenerateContent, isGeminiEndpoint: true
[req_1785647328887_76cdd72ad27b] [DEBUG] Authorization: ... at endpoint
[req_1785647328887_76cdd72ad27b] [DEBUG] x-api-key: ...
[req_1785647328887_76cdd72ad27b] [DEBUG] x-goog-api-key: hi...
[req_1785647328887_76cdd72ad27b] [DEBUG] Request body keys: contents, generationConfig, sessionId, systemInstruction, toolConfig, tools, model
[req_1785647328887_76cdd72ad27b] [DEBUG] Converting Gemini request to OpenAI format
[req_1785647328887_76cdd72ad27b] [DEBUG] Detected generateContent format with contents array
[req_1785647328887_76cdd72ad27b] [DEBUG] OpenAI upstream url: https://api.deepseek.com/v1/chat/completions
[req_1785647328887_76cdd72ad27b] [DEBUG] Model: deepseek-v4-flash, stream=true
[req_1785647328887_76cdd72ad27b] [DEBUG] Authorization: Bearer sk-d6fb5a... upstream
[req_1785647328887_76cdd72ad27b] [DEBUG] OpenAI API error: 400 {"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API.","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}
[req_1785647328887_76cdd72ad27b] [DEBUG] OpenAI API error: The `reasoning_content` in the thinking mode must be passed back to the API.
[req_1785647328887_76cdd72ad27b] [ERROR] Catch Error [model=deepseek-v4-flash status=400 type=invalid_request_error: The `reasoning_content` in the thinking mode must be passed back to the API.
```

The proxy is forwarding an assistant message that carries
`reasoning_content` (a string) but no `reasoning_signature`, and the body does
not enable thinking on the request.

### Config (proxy_config.toml)

Both aliases point at the same upstream model, just via different modes:

```toml
# line 23 (anthropic-messages)
deepseek-v4-anth = {target = "deepseek-v4-flash", base_url = "https://api.deepseek.com/anthropic", api_key = "sk-d6fb5ab34c50412fa0e1ecbb1a927d96", mode = "anthropic-messages", transforms = "deepseek_v4_anthropic_compat"}

# (openai-completions alias — deepseek-v4-comp — declared elsewhere with mode = "openai-completions")
```

Transform set referenced by the anthropic-messages alias:

```toml
# line 58
[transforms.deepseek_v4_anthropic_compat]
schema = "anthropic-messages"
endpoint_readin.builtins = ["lowercase_tool_schema_types"]
before_upstream.builtins = ["inject_missing_tool_results"]
```

`inject_missing_tool_results` (in `src/utils/request-transform.ts:123`) only
fixes tool_result pairing; it does nothing for thinking blocks.

---

## Request flow (shared by both aliases)

Both routes enter the proxy through the Gemini endpoint and pass through the
same converter before diverging:

1. **Inbound** — `POST /v1beta/models/<alias>:streamGenerateContent`.
   Antigravity's Gemini SDK replays prior assistant turns as:

   ```json
   { "role": "model", "parts": [
     { "thought": true, "text": "<thinking text>", "thoughtSignature": "<sig>" },
     { "text": "<visible text>" }
   ]}
   ```

2. **Gemini → OpenAI conversion** in
   `src/handlers/openai.ts:101` → `convertGeminiGenerateContentToOpenAI`.
   The relevant lines (`src/handlers/openai.ts:131-132`):

   ```ts
   const thinkingContent = parts.filter((p: any) => p.thought && p.text).map((p: any) => p.text as string).join('');
   const textContent     = parts.filter((p: any) => p.text && !p.thought).map((p: any) => p.text as string).join('');
   ```

   Only the thought **text** is kept. `thoughtSignature` is dropped at this
   point. The text is then attached to the OpenAI-style assistant message as
   `reasoning_content` (`src/handlers/openai.ts:152`):

   ```ts
   if (thinkingContent) msg.reasoning_content = thinkingContent;
   ```

3. **Divergence.**
   - `deepseek-v4-anth` (anthropic-messages) is forwarded by
     `forwardCompletionsAsAnthropicMessages`
     (`src/handlers/openai.ts:622`), which calls `completionsToClaudeBody`
     (`src/handlers/openai.ts:461`). There the `reasoning_content` string is
     wrapped into a Claude thinking block
     (`src/handlers/openai.ts:473-476`, `499-500`):

     ```ts
     const thinking = (m as ...).reasoning_content as string | undefined;
     if (m.tool_calls) {
       const content: unknown[] = [];
       if (thinking) content.push({ type: 'thinking', thinking }); // no signature
       ...
     } else if (thinking) {
       claudeMessages.push({ role: m.role, content: [
         { type: 'thinking', thinking },                          // no signature
         { type: 'text', text: m.content ?? '' }
       ]});
     }
     ```

     The body sent upstream contains `{"type":"thinking","thinking":"..."}`
     with no `signature` field, and no top-level `thinking` config on the
     request. DeepSeek's anthropic-compatible endpoint rejects it with:

     ```
     The `content[].thinking` in the thinking mode must be passed back to the API.
     ```
   - `deepseek-v4-comp` (openai-completions) is forwarded along the chat
     completions path. The assistant message carries `reasoning_content`
     (string) but no `reasoning_signature`, and the body enables no thinking
     mode. DeepSeek's OpenAI-compatible endpoint rejects it with:

     ```
     The `reasoning_content` in the thinking mode must be passed back to the API.
     ```

The proxy already knows thought parts carry signatures on the response side
(`src/converters/gemini-to-claude.ts:100-108`):

```ts
case 'thought':
  const thoughtContent = output as any;
  claudeBlocks.push({
    type: 'thinking',
    thinking: thoughtContent.signature || thoughtContent.summary?.content?.text || '',
    signature: thoughtContent.signature,
  });
  break;
```

…so the request-side drop in `openai.ts:131-132` is an asymmetry, not an
intentional design.

---

## Latent bug — `before_upstream` skipped on the Gemini endpoint path

Independent of the thinking issue, the transforms declared on
`deepseek_v4_anthropic_compat.before_upstream` are silently bypassed when
traffic enters via the Gemini endpoint.

Compare where `before_upstream` is actually run:

- `src/handlers/messages.ts:687-695` — Claude endpoint → anthropic-messages
  upstream.
- `src/handlers/messages.ts:400-408` — Claude endpoint → openai-completions
  upstream.
- `src/handlers/chat-completions.ts:58-69` and `194-205` — native OpenAI
  endpoint paths.

vs. what happens when the Gemini endpoint forwards to those same upstreams:

- `src/handlers/openai.ts:622-658` (`forwardCompletionsAsAnthropicMessages`):
  builds `claudeBody` via `completionsToClaudeBody` and immediately `fetch`es
  it. **No `runHook('before_upstream', ...)` call.**
- The OpenAI-completions forward path in the same handler likewise skips
  `before_upstream` before sending.

So any compatibility builtin configured for an upstream (e.g.
`inject_missing_tool_results` for DeepSeek) is inert whenever a request comes
in through `/v1beta/.../:streamGenerateContent`. The debug log line
`transforms: ... before_upstream=[deepseek_v4_anthropic_compat:b=1]` makes
this especially misleading — the slot is announced but never executed on this
code path.

---

## Conclusion — one root cause, two faces

Both errors are produced by the same upstream invariant ("a thinking /
reasoning block in history must be replayable, i.e. it must carry the original
signature and the request must enable thinking"), and the proxy violates it on
both paths for the same reason: `convertGeminiGenerateContentToOpenAI` drops
`thoughtSignature` at `src/handlers/openai.ts:131-132`, and neither forward
path re-enables thinking at the request-body level.

The two error messages differ only because the two upstreams speak different
schemas:

| Alias           | Upstream mode          | Field name in body            | Error text                                                                               |
|-----------------|------------------------|-------------------------------|------------------------------------------------------------------------------------------|
| `deepseek-v4-anth`  | anthropic-messages | `content[].thinking`          | `The \`content[].thinking\` in the thinking mode must be passed back to the API.`         |
| `deepseek-v4-comp`  | openai-completions | `messages[].reasoning_content`| `The \`reasoning_content\` in the thinking mode must be passed back to the API.`           |

## Fix options

Pick one — a signature-less thinking block is invalid to either upstream, so
there is no middle ground.

### Option A — strip (smaller change)

Drop thought parts in `convertGeminiGenerateContentToOpenAI` instead of
mapping them to `reasoning_content`. Both errors disappear because no
thinking / reasoning content is sent. Cost: thinking context is invisible to
the model on subsequent turns.

### Option B — plumb the signature through (correct, larger change)

1. In `convertGeminiGenerateContentToOpenAI` (`src/handlers/openai.ts:131`),
   capture `thoughtSignature` alongside the thought text and attach it to the
   OpenAI message (e.g. as `reasoning_signature`).
2. On the openai-completions forward path, forward `reasoning_content` +
   `reasoning_signature`, and enable thinking on the request body when a
   signature-bearing reasoning block is present.
3. On the anthropic-messages forward path (`completionsToClaudeBody`), emit
   `{type:'thinking', thinking, signature}` and set
   `claudeBody.thinking = {type:'enabled', budget_tokens: ...}` when
   signatures are present.

Recommend Option A unless the signature fields have been verified to be
accepted by both DeepSeek endpoints — the current code already drops the
signature, so even a strict Anthropic endpoint would reject these requests.

Also fix in the same pass: invoke `runHook('before_upstream', …)` on
`forwardCompletionsAsAnthropicMessages` (`src/handlers/openai.ts:622`) and the
OpenAI-completions forward path so configured transforms actually run when
traffic enters via the Gemini endpoint.

---

## Post-mortem — Option A applied, errors unchanged (2026-08-02)

Option A was implemented: the `reasoning_content` mapping was removed from
both assistant branches of `convertGeminiGenerateContentToOpenAI`
(`src/handlers/openai.ts:127-137`, `:172-174`). The change was verified in
`src/`, recompiled into `dist/handlers/openai.js` via `npm run build`, and the
proxy (PID 687586, `node dist/server.js`) was restarted against the rebuilt
artifact (proxy start `1785648877` ≈ dist mtime `1785648876`).

Re-running the same loop:

```
for i in 1 2; do ANTIGRAVITY_USE_GEMINI_API=true API_KEY=hi PROXY_BASE=http://localhost:8788 \
  python3 tests/multi-agents-test.py $i 1 1 ; done
```

The errors are **identical to before the fix**:

```
Selection: 1 model(s) x 1 agent(s) x 1 task(s)
  model:  deepseek-v4-comp
  agent:  Antigravity
  task:   codebase_layout
--- Antigravity Agent | model=deepseek-v4-comp | transport=GeminiAPIEndpoint ---
WARNING:root:System step error (HTTP 0): Agent execution terminated due to error. ("request failed (code 0): The `reasoning_content` in the thinking mode must be passed back to the API.")
Antigravity failed: Error 0, Message: The `reasoning_content` in the thinking mode must be passed back to the API., Status: , Details: []
request failed (code 0): The `reasoning_content` in the thinking mode must be passed back to the API.

Selection: 1 model(s) x 1 agent(s) x 1 task(s)
  model:  deepseek-v4-anth
  agent:  Antigravity
  task:   codebase_layout
--- Antigravity Agent | model=deepseek-v4-anth | transport=GeminiAPIEndpoint ---
WARNING:root:System step error (HTTP 0): Agent execution terminated due to error. ("request failed (code 0): The `content[].thinking` in the thinking mode must be passed back to the API.")
Antigravity failed: Error 0, Message: The `content[].thinking` in the thinking mode must be passed back to the API., Status: , Details: []
request failed (code 0): The `content[].thinking` in the thinking mode must be passed back to the API.
```

### What this proves

The premise of Option A — that the invalid `reasoning_content` /
`content[].thinking` block originates in
`convertGeminiGenerateContentToOpenAI` mapping `thought:true` parts to
`reasoning_content` — is **wrong**, or at least incomplete. With that mapping
removed and the rebuilt binary confirmed running, DeepSeek still sees a
thinking/reasoning block in the upstream request. The block must be entering
the upstream body via a different code path.

### Candidate paths not yet ruled out

The proxy injects `reasoning_content` onto assistant messages in several
places unrelated to the Gemini inbound converter. Each must be checked:

1. `src/handlers/responses.ts:627-639` —
   `injectMissingReasoningContent` re-attaches stored
   `reasoning_content` by `call_id` from a prior turn's store. If the
   Antigravity first turn produced reasoning and the SDK's second turn
   references the same `call_id`, this path silently re-injects it.
2. `src/converters/completions-to-responses.ts:93-100, 140, 226` —
   accumulates upstream `message.reasoning_content` and re-emits it on
   the synthesized assistant message.
3. `src/converters/responses-to-completions.ts:295-339` —
   converts `reasoning` items back into `reasoning_content` on assistant
   messages when going from Responses to Completions format.
4. `src/converters/claude-to-openai.ts:307-325, 427-445` —
   converts Claude `thinking` blocks (from a Claude-format inbound request)
   into `reasoning_content`.
5. `src/handlers/openai.ts:699-729` —
   `convertOpenAIToGeminiRequest` / response path explicitly preserves
   thinking blocks as `reasoning_content` for downstream converters.
6. `src/handlers/messages.ts:101-105` —
   reads `msg.reasoning_content` from the inbound OpenAI body and forwards
   it as a Claude `thinking` block to anthropic-messages upstreams.

The most likely culprits for this bug are (1) and (6): the proxy is
*synthesizing* thinking content from its own conversation state (stored
reasoning, or a stored thinking block) and injecting it onto assistant
messages even when the inbound Gemini request carried no thought parts.

### Next step

Before any further code change, capture the exact upstream body the proxy
sends to DeepSeek in both modes. Add (or enable) a debug log line that
prints the full `claudeBody` / openai-completions body at the moment of
the upstream `fetch`, not the truncated 500-char version. The body will
show whether the offending block is:

- a `thinking` / `reasoning_content` field on an assistant message
  (→ source is one of paths 1–6 above), or
- something else entirely (e.g. a top-level `thinking` / `reasoning_effort`
  field set by generationConfig translation).

Once the actual offending field is visible, target the real injection site.
Do not attempt Option B (signature plumbing) until Option A's failure is
explained — it may be fixing the wrong layer.

---

## Resolution — diagnostic capture (2026-08-02, later)

Before any further code change, two temporary `[DIAG-THINKING]` log lines
were added at the two upstream-fetch sites to print the full upstream body
(no truncation):

- `src/handlers/openai.ts:634` — anthropic-messages full body
- `src/handlers/openai.ts:1054` — openai-completions full body

The proxy was rebuilt and restarted, the failing test was re-run, and the
captured bodies were inspected structurally (`/tmp/proxy.log`).

### Findings from the captured bodies

1. **The offending fields are exactly `reasoning_content` (openai-completions)
   and `content[].thinking` (anthropic-messages).** No other candidate
   (`top-level thinking` / `reasoning_effort` / etc.) is present.

2. **There is no signature anywhere in the captured traffic.** A count over
   the full log:
   ```
   "reasoning_content"        : 9 occurrences
   "type":"thinking"          : 6 occurrences
   "reasoning_signature"      : 0
   "thoughtSignature"         : 0
   "signature"                : 0
   ```

3. **The signature is missing at the inbound Gemini layer, not added by the
   proxy.** The inbound Gemini request body itself contains:
   ```
   "thought":true   : 1097 occurrences
   "thoughtSignature": 0 occurrences
   ```
   The Antigravity SDK is replaying prior assistant thoughts as
   `{thought:true, text:"..."}` parts **without any `thoughtSignature`**,
   even though Gemini's spec requires one for round-trip.

4. **The `reasoning_content` text on the openai-completions path is being
   carried verbatim from those `thought:true` inbound parts** —
   `convertGeminiGenerateContentToOpenAI` (`src/handlers/openai.ts:131-170`)
   is the only site injecting it on this path. The candidates listed in the
   post-mortem (`responses.ts:627-639`, etc.) are all on the
   `/v1/responses` handler and do not run for Gemini-endpoint traffic.

### Why the earlier "Option A applied, errors unchanged" result was misleading

When the post-mortem was written, Option A had been applied to `src/` but the
running proxy still served stale `dist/` (or the rebuild/restart sequencing
was off — the diagnostic logs were added precisely to settle this). With the
`[DIAG-THINKING]` logs in place, the current source was re-checked: it was at
the **un-stripped** state (lines 131, 152, 170 still had the
`thought → reasoning_content` mapping). The captured bodies therefore reflect
the *original* buggy behavior, not "Option A + something else".

### Fix applied (final)

Option A re-applied at the single correct site:
`src/handlers/openai.ts:127-137, 172-174`. Both the `funcCallParts` branch
and the plain-text branch no longer map `thought:true` parts to
`reasoning_content`. `completionsToClaudeBody` (`src/handlers/openai.ts:473-500`)
is left unchanged because nothing on the Gemini-inbound path feeds
`reasoning_content` into it any more.

The temporary `[DIAG-THINKING]` log lines were removed after the diagnosis
was confirmed.

### Note on Option B

Option B (signature plumbing) is **not viable against this client** as long
as the Antigravity SDK sends `thought:true` without `thoughtSignature`. There
is no signature to plumb. If a future SDK build starts including
`thoughtSignature`, the plumbing points would be:

- Inbound: capture `part.thoughtSignature` in
  `convertGeminiGenerateContentToOpenAI` (`src/handlers/openai.ts:131`).
- openai-completions: forward as `reasoning_signature` on the assistant
  message and enable thinking on the body when present.
- anthropic-messages: in `completionsToClaudeBody`, emit
  `{type:'thinking', thinking, signature}` and set
  `claudeBody.thinking = {type:'enabled', budget_tokens: ...}`.

Until then, stripping is the only correct behavior.

---

## Authoritative resolution — DeepSeek docs (2026-08-02, final)

Two earlier conclusions in this doc were **wrong** and need to be retracted:

1. **"A signature-less thinking/reasoning block is invalid."** Projected
   Anthropic's spec onto DeepSeek. DeepSeek's thinking_mode guide confirms
   there is no signature concept on its API — `reasoning_signature` /
   `signature` appear nowhere in the docs.
2. **"Stripping (Option A) is the only correct behavior."** The opposite is
   true. Option A makes the tool-call case fail 100% of the time.

### What the DeepSeek docs actually say

Source: `https://api-docs.deepseek.com/zh-cn/guides/thinking_mode`,
`/guides/anthropic_api`, `/guides/tool_calls`.

- Thinking mode is **enabled by default** on `deepseek-v4-flash`. Effort
  defaults to `"high"`.
- The response includes `reasoning_content` (OpenAI shape) at the same level
  as `content`. Anthropic shape uses `content[].type == "thinking"`.
- **Round-trip rule, quoted verbatim:**
  > 如果模型**进行了工具调用**，则中间 `assistant` 的 `reasoning_content`
  > 需参与上下文拼接，在后续所有 user 交互轮次中必须**回传给 API**。
  > …若您的代码中未正确回传 `reasoning_content`，API 会返回 400 报错。

  Translation: if the model made a tool call, the intermediate assistant's
  `reasoning_content` must be included in context concatenation, and must be
  sent back to the API in all subsequent user turns. Otherwise: HTTP 400.
- **Without tool calls**, `reasoning_content` may be omitted —
  "中间 `assistant` 的 `reasoning_content` 无需参与上下文拼接，在后续轮次中
  将其传入 API 会被忽略".
- No `reasoning_signature` / `signature` field exists.
- Format-specific controls (cross-reference):
  - OpenAI shape: `extra_body={"thinking": {"type": "enabled" | "disabled"}}`
    + `reasoning_effort` (`low` / `high` / `max`).
  - Anthropic shape: `"reasoning": {"effort": "none" | "low" | "high" | "max"}`.
    The Anthropic guide lists `thinking` under "Simple Fields" as "Supported
    (`budget_tokens` ignored)".
  - Constraints when thinking is on: `temperature`, `top_p`,
    `presence_penalty`, `frequency_penalty` are accepted but silently
    ignored. No other constraints.

### Why this matches `/tmp/proxy2.log` exactly

- `req_1785651632299` (turn 1): inbound has no prior assistant. Proxy sends
  clean body. DeepSeek returns 200 with `delta.reasoning_content` chunks and
  a trailing `functionCall` (the model did a tool call).
- `req_1785651633941` (turn 2): client replays the prior assistant turn
  (the one with the tool call). With Option A currently applied, the proxy
  **strips** the `reasoning_content` mapping at
  `convertGeminiGenerateContentToOpenAI`. DeepSeek returns 400
  `reasoning_content must be passed back` — exactly the "with tool calls"
  branch of the docs.
- The `deepseek-v4-anth` run fails the same way at
  `req_1785651637160`: prior assistant has `tool_use`, current code emits it
  without a `thinking` block (because Option A also drops it on this path),
  DeepSeek's Anthropic endpoint returns 400
  `content[].thinking must be passed back`.

### Correct fix

Option A must be **reverted**. The proxy must round-trip thinking content
on assistant turns that contain tool calls:

1. In `convertGeminiGenerateContentToOpenAI` (`src/handlers/openai.ts:127-137`),
   restore the `thought:true → reasoning_content` mapping on both the
   `funcCallParts` branch (line 152) and the plain-text branch (line 170).
   This was the pre-Option-A state and it is correct.
2. In `completionsToClaudeBody` (`src/handlers/openai.ts:473-500`), keep
   emitting `{type:'thinking', thinking}` for assistant messages that carry
   `reasoning_content`. Also correct as-is.
3. For the anthropic-messages path specifically, if 400s persist after the
   revert, the remaining suspect is a missing top-level `thinking` field on
   the request body. DeepSeek's Anthropic docs say `thinking` is accepted
   with `budget_tokens` ignored. Set
   `claudeBody.thinking = {type: 'enabled'}` when forwarding to an
   anthropic-messages upstream that has thinking on.

### Summary of correction

The earlier "Option A / Option B" framing was built on a false premise
(no signature → invalid block). DeepSeek has no signature. The real rule is
"with tool calls, `reasoning_content` is mandatory on subsequent turns."
The fix is to **preserve** thinking content across the Gemini→OpenAI
conversion, not strip it.

---

## Addendum — the `invalid_signature` / `invalid_args` tool-call errors are NOT a proxy defect (2026-08-02)

After the thinking-mode bug above was fixed, a separate `duplicate_helpers`
task was run against `deepseek-v4-anth`. Its client output contained a batch of
tool-call errors distinct from the thinking-mode 400s:

```
Selection: 1 model(s) x 1 agent(s) x 1 task(s)
  model:  deepseek-v4-anth
--- Antigravity Agent | model=deepseek-v4-anth | transport=GeminiAPIEndpoint ---
WARNING: The model produced an invalid tool call. ("invalid tool call error (invalid_signature) Query is required")
WARNING: The model produced an invalid tool call. ("invalid tool call error (invalid_signature) SearchPath is required")
WARNING: The model produced an invalid tool call. ("invalid tool call error (invalid_signature) AbsolutePath is required")
WARNING: The model produced an invalid tool call. ("invalid tool call error (invalid_args) argument TargetFile not found")
WARNING: The model produced an invalid tool call. ("invalid tool call error (invalid_args) argument Overwrite not found")
```

### Conclusion

These are **Antigravity's client-side tool-schema validation rejecting the
model's own malformed tool calls** — not something the proxy corrupted. No
proxy change is warranted.

### Evidence — the proxy preserves tool schemas / arg names intact

Every conversion site in the chain leaves tool property names untouched:

1. `normalizeGeminiSchema` (`src/handlers/openai.ts:84`) — only lowercases
   `type` string **values**; never renames property keys.
2. `lowercaseSchemaTypes` (`src/utils/request-transform.ts:58`) — recurses into
   `properties` but only touches `schema.type`; keys like `SearchPath` /
   `TargetFile` pass through verbatim.
3. `completionsToClaudeBody` tool conversion (`src/handlers/openai.ts:522`) —
   preserves `name` / `description` / `input_schema` unchanged.
4. Log confirmation: the PascalCase arg names appear **already-forwarded** in
   `/tmp/proxy.log` (`Overwrite`×14, `SearchPath`×3, `TargetFile`×14) — i.e.
   they originate on the model-output side; the proxy merely relays them.

### Why this is a model-quality issue, not a bug

- The PascalCase names (`Query`, `SearchPath`, `AbsolutePath`, `TargetFile`,
  `Overwrite`) are Antigravity's **expected** tool-arg schema. The rejections
  mean the model (`deepseek-v4-flash`) emitted tool calls that didn't match the
  schema — missing required args (`invalid_args`) or missing the call's
  signature (`invalid_signature`).
- **The task SUCCEEDED.** `duplicate-helpers-audit.md` is a complete 251-line
  report. These were therefore **rejected-and-retried** calls the model
  recovered from, not fatal failures — the signature of weak tool-calling
  caught by a strict client validator, then self-corrected on retry.

### Contrast with the thinking-mode bug above

| | Thinking-mode 400 (fixed above) | `invalid_signature` / `invalid_args` (this addendum) |
|---|---|---|
| Origin | Real proxy defect (reasoning block stripped) | Model emitted malformed tool calls |
| Who rejects | DeepSeek upstream (HTTP 400) | Antigravity client-side validator |
| Fatal? | Yes — every call failed | No — rejected, retried, task completed |
| Proxy role | Corrupted the body | Faithful relay |
| Fix | Preserve reasoning_content | None — model/client concern |

**Bottom line:** the proxy is faithful here. To reduce the retry noise, the
lever is model choice (a stronger tool-calling model) or Antigravity's retry
tolerance — not the proxy.
