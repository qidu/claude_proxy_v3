# Transforms & Hooks — Reference

One-page cheat sheet. For design rationale see `design_request_transform_hooks.md`.

---

## Hooks — lifecycle positions

| Hook | Alias | Fires when | Schema seen | Side |
|------|-------|-----------|-------------|------|
| `request_ingress` | `endpoint_readin` | After JSON parse, before routing | client | request |
| `before_conversion` | — | After routing, before format converter | client | request |
| `before_upstream` | — | After format conversion, before `fetch()` | upstream | request |
| `after_upstream` | — | After `fetch()`, before `!ok` check | upstream | response |
| `response_egress` | `endpoint_writeout` | Before `Response` returned to client | client | response |

**Ordering**: hooks fire in the table order above. Within a hook, declared transform sets run left-to-right (mode-defaults → sector-defaults → entry transforms). Within each set, Tier-2 built-ins run first, then Tier-1 ops in declared order.

**Aliases**: `endpoint_readin` and `endpoint_writeout` are accepted everywhere `request_ingress` / `response_egress` appear in `proxy_config.toml` (legacy names). They are normalized to the canonical names at config load time.

**Header transforms** are supported only on `before_upstream` and `response_egress`. A `headers` block under any other hook is a TypeScript type error.

---

## Tier-1 ops — shallow field rewrites

All ops target a **path**. Three path shapes are supported:

| Path shape | Example | What it targets |
|-----------|---------|----------------|
| Top-level field | `max_tokens` | Single key on the request/response body root |
| Message field | `messages[role=assistant].content` | Field on every message matching the role filter |
| Response field | `$response.id` | Top-level key on the upstream/client response body |

Paths must be shallow (single segment after the prefix). Nested paths like `$response.choices[].message.content` are rejected at config load with an error pointing to the relevant built-in.

| Op | Required fields | Optional fields | Effect |
|----|----------------|----------------|--------|
| `rename` | `path`, `to` | — | Rename key; no-op if `path` is absent |
| `set` | `path`, `value` | — | Unconditionally set key to `value` |
| `default` | `path`, `value` | — | Set key to `value` only if absent or `undefined` |
| `remove` | `path` | — | Delete key; no-op if absent |
| `map_value` | `path`, `from`, `to` | `when_sibling` | Replace `from` value with `to`; with `when_sibling`, only fires when that sibling key exists on the same object |

### Op examples

```toml
# Rename max_tokens → max_completion_tokens (OpenAI Responses API)
{ op = "rename", path = "max_tokens", to = "max_completion_tokens" }

# Force a fixed model name upstream
{ op = "set", path = "model", value = "deepseek-chat" }

# Strip an unsupported field
{ op = "remove", path = "thinking" }

# Map empty assistant content to null when tool_calls is present
{ op = "map_value", path = "messages[role=assistant].content", from = "", to = null, when_sibling = "tool_calls" }
```

---

## Tier-2 built-ins — deep / cross-message logic

Built-ins are declared in the `builtins` list of a hook slot. They run **before** Tier-1 ops within the same slot.

| Built-in | Works on schema | What it does |
|----------|----------------|-------------|
| `lowercase_tool_schema_types` | `openai-completions`, `anthropic-messages` | Recursively lowercases every `type` field in `tools[*].function.parameters` (OpenAI shape) and `tools[*].input_schema` (Anthropic shape), including inside `anyOf`/`oneOf`/`allOf`. Required for upstreams that reject uppercase JSON-Schema type strings (e.g. DeepSeek). |
| `recover_tool_message_name` | `openai-completions` | Fills in missing `name` on `role=tool` messages by back-filling from the matching `tool_calls[].function.name` in the preceding assistant turn. Required for upstreams that reject nameless tool messages. |
| `inject_missing_tool_results` | `anthropic-messages` | Enforces three DeepSeek-Anthropic invariants: (A) reorders text-only assistant turns that appear between a tool_use assistant and its tool_result user message; (B) merges consecutive pure-tool user messages into one; (C) synthesizes a placeholder `tool_result` block for any `tool_use` id that has no matching result. |

### Built-in example

```toml
[transforms.deepseek_compat]
schema = "openai-completions"

request_ingress.builtins = ["lowercase_tool_schema_types"]

before_upstream.builtins = ["recover_tool_message_name"]
before_upstream.ops = [
  { op = "rename", path = "max_tokens", to = "max_completion_tokens" },
]
```

---

## Named sets and defaults

Transform sets are defined under `[transforms.<name>]` and referenced by name.

### Default resolution order

For every route, the effective transform list is:

```
mode-defaults  →  sector-defaults  →  entry transforms
```

- **mode-defaults**: `[transform_defaults]` — a map of `upstream_mode → [set_names]`. Applied to every route using that upstream mode.
- **sector-defaults**: `transforms = "..."` on a `[models.<section>]` category block.
- **entry transforms**: `transforms = "..."` in the model entry itself (5th element of the positional array, or `transforms` key in the inline-table form).

Multiple names are comma-separated strings: `transforms = "set_a,set_b"`. List form (`transforms = ["a","b"]`) is **not** supported — use CSV.

### Config wire format for model entries

Model entries are positional arrays:

```toml
[models.deepseek]
"deepseek-v3" = ["deepseek-chat", "https://api.deepseek.com/v1", "sk-...", "openai-completions", "deepseek_compat"]
#                 ^target          ^base_url                       ^api_key  ^upstream_mode        ^transforms CSV
```

Or inline-table form (equivalent):

```toml
[models.deepseek]
"deepseek-v3" = { target = "deepseek-chat", base_url = "https://api.deepseek.com/v1", api_key = "sk-...", mode = "openai-completions", transforms = "deepseek_compat" }
```

---

## Visibility

To see which transforms resolve for a route, run the server with `LOG_LEVEL=debug`. One line per request is emitted showing the resolved set names and per-hook op/builtin counts:

```
[req_…] [DEBUG] transforms: request_ingress=[deepseek_compat:b=1] before_upstream=[deepseek_compat:b=1,ops=1]
```

`b=N` = N built-ins, `ops=N` = N Tier-1 ops. Only hooks with at least one op or builtin are listed.
