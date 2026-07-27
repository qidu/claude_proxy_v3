# Investigation: `generateContent` and `/v1/responses` → `anthropic-messages` (`max-m3-anth` / MiniMax)

## Reported symptoms

```
Selection: 1 model(s) x 1 agent(s) x 1 task(s) on proxy http://localhost:7778
  model:  max-m3-anth
  agent:  Codex
  task:   duplicate_helpers

--- Codex Agent | model=max-m3-anth ---
Codex failed: Error: {"type":"invalid_request_error","error":{"type":"invalid_request_error","message":"invalid params, 400 (2013)"}}
```

```
Selection: 1 model(s) x 1 agent(s) x 1 task(s) on proxy http://localhost:7778
  model:  max-m3-anth
  agent:  Antigravity
  task:   duplicate_helpers

--- Antigravity Agent | model=max-m3-anth | transport=GeminiAPIEndpoint ---
WARNING:root:System step error (HTTP 0): The model produced an invalid tool call.
  ("model output error: invalid tool call error (invalid_signature) Query is required")
```

Config under test (`max-m3-anth` in `[models.free]`):
```toml
max-m3-anth = {target = "MiniMax-M3", base_url = "https://api.minimaxi.com/anthropic", api_key = "", mode = "anthropic-messages"}
```

Both failures happen on `max-m3-anth`, an `anthropic-messages` upstream (MiniMax's `/anthropic` compat
endpoint), reached from two different inbound endpoints:

- **Codex** → `/v1/responses` (OpenAI Responses API)
- **Antigravity `GeminiAPIEndpoint`** → `/v1beta/models/<model>:generateContent`

## Code paths traced

**Codex (`/v1/responses` → `anthropic-messages`):**
`handleResponsesRequest` (`src/handlers/responses.ts:84`)
→ `handleAsAnthropicMessages`
→ `convertResponsesToChatCompletions` (`src/converters/responses-to-completions.ts`)
→ `completionsBodyToClaudeBody` (**local, duplicate** — `src/handlers/responses.ts:100`)
→ `POST …/anthropic/v1/messages`
→ `claudeResponseToResponses` / `streamClaudeAsResponses`.

**Antigravity (`:generateContent` → `anthropic-messages`):**
`index.ts:1366` maps `generateContent` + `upstreamMode === 'anthropic-messages'` to `handleOpenAIRequest`
(handler type `generateContent`, `src/index.ts:2068-2074`)
→ `convertGeminiGenerateContentToOpenAI` (`src/handlers/openai.ts:99`)
→ `forwardCompletionsAsAnthropicMessages` (`src/handlers/openai.ts:643`), which calls the **canonical**
`completionsToClaudeBody` (`src/handlers/openai.ts:482`, exported)
→ `POST …/anthropic/v1/messages`
→ `claudeJsonToSyntheticCompletions` → `convertOpenAIToGeminiGenerateContent` (`src/converters/openai-to-gemini.ts:34`).

## Reproduction attempts

Built and ran the proxy locally (`node dist/server.js`, port 7779) against the real
`https://api.minimaxi.com/anthropic` upstream configured as `max-m3-anth` / target `MiniMax-M3`, and sent
synthetic requests shaped like each agent's traffic:

1. `/v1/responses`, single tool call, non-streaming → **200 OK**, valid tool_use round trip.
2. `/v1/responses`, **parallel** tool calls (2x `function_call` + 2x `function_call_output`) → **200 OK**.
   Request body inspected in the debug log showed the parallel tool results split into **two separate
   `user` messages** instead of one combined message (see "Confirmed defect" below) — MiniMax tolerated
   it but this is a spec violation.
3. `/v1/responses`, streaming + forced `tool_choice`, single tool → **200 OK**, valid SSE stream with
   `response.function_call_arguments.delta` events.
4. `/v1beta/models/max-m3-anth:generateContent`, single tool declaration, first turn → **200 OK**, model
   correctly returned a `functionCall` part.
5. `/v1beta/models/max-m3-anth:generateContent`, **second turn** round-trip (model `functionCall` +
   user `functionResponse` fed back) → **200 OK**, correctly resolved into a grouped
   `tool_use` + `tool_result` Claude message pair and got a valid next `functionCall` back.

In every case the proxy built a request MiniMax accepted, and returned a response the calling shape
(Responses API / generateContent) could parse. **The proxy did not reproduce either reported error** with
synthetic traffic against the live upstream.

## Conclusion

Both errors are raised by the **client SDKs rejecting the model's output**, not by the proxy
malforming the outbound request:

- **`invalid params, 400 (2013)`** — this is MiniMax's "unknown model" error code (confirmed precedent:
  `CHANGELOG.md` documents the same code appearing when a composite/alias name is forwarded verbatim
  instead of being resolved to its configured `target`). In all my reproductions the model name correctly
  resolved to `MiniMax-M3` before being sent upstream, so the 400 is config/state-dependent — it surfaces
  when the alias-to-`target` resolution doesn't happen for whatever code path Codex's actual request took
  (e.g. a composite/fallback attempt, or a retry that lost the resolved model id). This needs to be
  reproduced with the **actual request the harness sent** (see "Next steps").

- **`invalid tool call error (invalid_signature) Query is required`** — this is the Gemini/Antigravity SDK's
  client-side validation of the model's tool call. `invalid_signature` refers to the SDK's expected
  `thoughtSignature` field on `functionCall` parts, which **neither `convertGeminiGenerateContentToClaude`
  (`src/converters/gemini-to-claude.ts:172`) nor `convertOpenAIToGeminiGenerateContent`
  (`src/converters/openai-to-gemini.ts:34`) ever emit** — there is no `thoughtSignature` handling anywhere
  in the Gemini response converters. `Query is required` indicates a required tool parameter (e.g. a
  `query` field on the agent's search/glob tool) was missing or empty in the arguments MiniMax generated.
  Since MiniMax is not a native Gemini model, it has no concept of `thoughtSignature`, and the proxy passes
  the model's raw tool-call args straight through without validating required-field completeness before
  handing them to the SDK.

Neither of these is fixable by changing how the proxy *builds the upstream request* — both are the SDK
reacting to what the model already returned. Confirming the fix requires the literal request/response
Codex and Antigravity produced (not synthetic repros), captured via `LOG_LEVEL=debug`.

## Confirmed proxy-side defect (unrelated to the two errors, found during investigation)

`src/handlers/responses.ts:100` defines its own **local** `completionsBodyToClaudeBody`, duplicating the
**exported, canonical** `completionsToClaudeBody` in `src/handlers/openai.ts:482` (already imported and
used correctly by `src/handlers/chat-completions.ts:13`).

The local duplicate in `responses.ts` is inferior: it emits **one `user` message per tool_result**
(`responses.ts:119-128`) instead of grouping all consecutive tool results into a single `user` message
with multiple `tool_result` blocks. The Anthropic Messages API requires all tool_results belonging to one
assistant turn to appear together in one message immediately following it. The canonical
`completionsToClaudeBody` in `openai.ts` already does this correctly (`openai.ts:507-515`,
`while (i < otherMessages.length && otherMessages[i].role === 'tool')`).

MiniMax tolerated the split-message shape in my parallel-tool-call test (repro #2 above), but this is
still a spec violation that stricter `anthropic-messages` upstreams (real Claude, DeepSeek's `/anthropic`
compat endpoint) are more likely to reject, especially with parallel tool calls — the exact pattern Codex
and other coding agents use.

Both `handleAsAnthropicMessages` and `handleAsGemini` in `responses.ts` call the local duplicate
(`responses.ts:450`, `responses.ts:507`).

## Next steps (not yet actioned — pending direction)

1. Re-run the failing `duplicate_helpers` task with `LOG_LEVEL=debug` and capture the actual outbound
   request body logged at `Responses->anthropic-messages: …` (responses.ts) and
   `Interactions/generateContent -> anthropic-messages body: …` (openai.ts) to see the real model name and
   tool-call args at the moment of failure, instead of relying on synthetic reproduction.
2. Consolidate `responses.ts`'s local `completionsBodyToClaudeBody` to use the canonical exported
   `completionsToClaudeBody` from `openai.ts` (safe correctness fix, independent of the two reported
   errors).
3. Once the real request/response pair is captured, evaluate whether `Query is required` warrants
   validating required tool-schema fields before returning `functionCall` parts to Gemini-shaped clients,
   and whether `thoughtSignature` needs to be synthesized for non-Gemini-native upstreams routed through
   `generateContent`.

---------
generated by `claude-opus-4-8`
