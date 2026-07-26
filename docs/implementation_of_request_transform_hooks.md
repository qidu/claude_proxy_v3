# Implementation: Request/Response Transform Hooks

Status: **complete** (as of 2026-07-26)
Design doc: [`docs/design_request_transform_hooks.md`](./design_request_transform_hooks.md)

---

## What was built

A two-tier, config-driven transform engine that rewrites request and response bodies at five
hook points in the proxy lifecycle. Per-model transform rules live in `proxy_config.toml`
— no handler code edits needed to add a new quirk for a new model.

---

## Architecture

### Five hook points

| Hook | Fires | Body shape | Where wired |
|------|-------|-----------|-------------|
| `endpoint_readin` | after inbound JSON parse, before routing | client schema | `src/index.ts` — centrally, once |
| `before_conversion` | inside handler, after routing, before format conversion | client schema | per-handler |
| `before_upstream` | inside handler, after format conversion, before `fetch` | upstream schema | per-handler |
| `after_upstream` | after `fetch` returns, before `!response.ok` check | upstream response schema | per-handler |
| `endpoint_writeout` | before returning `Response` to client | client response schema | `src/index.ts` (headers); per-handler (body — not yet implemented) |

### Two-tier transform engine

**Tier 1 — generic ops** over shallow paths (top-level fields, `messages[role=X].field`):

| Op | Effect |
|----|--------|
| `rename` | rename a field, preserving value |
| `set` | force a field to a literal value |
| `default` | set only when field is absent |
| `remove` | delete a field |
| `map_value` | replace a specific value (supports `when_sibling` guard) |

**Tier 2 — named built-ins** for deep/cross-message logic:

| Built-in | What it does |
|----------|-------------|
| `lowercase_tool_schema_types` | recursively lowercases `type` values in `tools[].function.parameters` / `tools[].input_schema` |
| `recover_tool_message_name` | fills missing `name` in `tool` messages by looking up the matching `assistant.tool_calls[].function.name` via `tool_call_id` |

### Transform resolution order

Per-route effective transforms = **mode-defaults → sector-defaults → entry transforms**,
concatenated left-to-right. Within each set: `builtins` run before `ops`, `ops` run in
declaration order. A later op sees results of earlier ops.

---

## Key files

| File | Role |
|------|------|
| `src/utils/request-transform.ts` | Engine: `runHook`, `applyAfterUpstream`, `buildEventTransformer`, built-in implementations |
| `src/utils/config-loader.ts` | Types (`TransformSet`, `TransformOp`, `BuiltinName`), parsing (`parseTransformOpsInline`), validation (`validateTransformSet`, `validateAllTransforms`), resolution (`resolveTransforms`) |
| `proxy_config.toml` | Declared transform sets: `deepseek_compat`, `minimax_compat`, `max_tokens_rename`; `[transform_defaults]` binding mode defaults |
| `src/index.ts` | `endpoint_readin` and `endpoint_writeout` (headers) applied centrally in `runAttempt` |
| `src/handlers/*.ts` | `before_conversion`, `before_upstream`, `after_upstream` wired per-handler |
| `tests/unit/request-transform.test.ts` | Engine unit tests |
| `tests/unit/transforms-config.test.ts` | Config parsing and validation tests |

---

## Config example

```toml
[transforms.deepseek_compat]
schema = "openai-completions"
endpoint_readin.builtins = ["lowercase_tool_schema_types"]
before_upstream.builtins = ["recover_tool_message_name"]
before_upstream.ops = [
  { op = "map_value", path = "messages[role=assistant].content", when_sibling = "tool_calls", from = "", to = null },
]

[transforms.minimax_compat]
schema = "openai-completions"
before_upstream.ops = [
  { op = "map_value", path = "messages[role=assistant].content", when_sibling = "tool_calls", from = "", to = null },
]

[transforms.max_tokens_rename]
schema = "openai-completions"
before_upstream.ops = [{ op = "rename", path = "max_tokens", to = "max_completion_tokens" }]

[transform_defaults]
openai-completions = ["max_tokens_rename"]
openai-responses   = ["max_tokens_rename"]

[models.free]
deepseek-v4-comp = { target = "deepseek-v4-flash", base_url = "https://api.deepseek.com", api_key = "…", transforms = "deepseek_compat" }
max-m3-comp      = { target = "MiniMax-M3",        base_url = "https://api.minimaxi.com", api_key = "…", transforms = "minimax_compat" }
```

---

## What was migrated / removed

| Was | Now |
|-----|-----|
| Inline `normalizeJsonSchemaTypes` + tool-patch loops in `chat-completions.ts` | `lowercase_tool_schema_types` + `recover_tool_message_name` builtins in `deepseek_compat` |
| `mapMaxTokensForUpstream` / `shouldUseMaxCompletionTokens` in `routing.ts` (hostname `includes` check) | `max_tokens_rename` transform set, bound as mode-default for `openai-completions` / `openai-responses` |
| `fillMissingToolMessageNames` unconditional call in `handleOpenAIRequest` (applied to all routes) | `recover_tool_message_name` builtin in `deepseek_compat` (applied only to DeepSeek routes) |
| Dead functions in `gemini.ts`: `handleGeminiToOpenAIMode`, `handleOpenAIStreamingToClaude`, `handleGeminiToGeminiMode` (~265 lines) | Deleted |

---

## `after_upstream` wiring (12 fetch sites)

`applyAfterUpstream(response, ctx)` buffers the upstream JSON body, applies `after_upstream`
ops, and returns a new `Response`. Non-JSON bodies (SSE streams) are passed through unchanged.
Fast-path: exits immediately when no `after_upstream` transforms are declared.

Wired at every non-streaming fetch site:

- `openai.ts`: `forwardCompletionsAsOpenAIResponses`, main `handleOpenAIRequest`
- `claude.ts`: `handleClaudeRequest`
- `messages.ts`: openai-passthrough→openai-responses, openai-passthrough→openai-completions, claude-upstream→openai-responses, claude-upstream→openai-completions
- `responses.ts`: `handleAsCompletions`, `handleAsPassthrough`, `handleResponsesInputTokensRequest` (completions path + passthrough path), `handleResponsesCompactRequest` (completions path + passthrough path)
- `chat-completions.ts`: anthropic-messages path, openai-responses path, direct passthrough
- `gemini.ts`: `handleGeminiInteractionsRequest`, `handleGeminiGenerateContentRequest`

---

## What is not yet implemented

**`endpoint_writeout` body ops** — the hook point exists in the design and `buildEventTransformer`
is implemented in `request-transform.ts`, but no transforms currently declare `endpoint_writeout`
ops, so the per-handler body wiring and SSE per-event path have not been written. Header ops for
`endpoint_writeout` are already wired centrally in `index.ts`.

---

## Tests

136 unit tests, all passing.

- `tests/unit/transforms-config.test.ts` — config parsing, validation, resolution, inline-table transform field
- `tests/unit/request-transform.test.ts` — Tier-1 ops, built-ins, `runHook` fast-path, `buildEventTransformer`, `applyAfterUpstream` (fast-path, active path, status preservation, non-JSON passthrough)
- `tests/unit/routing.test.ts` — routing and mode resolution
