# Changelog

Historical changes to `model_proxy_v3`. For current usage documentation, see
[README.md](./README.md).

## Latest Changes

Newest merged work, reverse-chronological.

### Fix: transport errors sanitized and mapped to 502 / 504

When an upstream `fetch()` rejects at the transport layer (DNS failure,
connection refused, TLS error, abort/timeout, malformed URL), the outer
request catch in `src/index.ts` previously returned **HTTP 500** with the
raw `error.message` echoed verbatim to the client. That message routinely
contains internal hostnames, ports, and filesystem paths from the underlying
socket error (e.g. `getaddrinfo ENOTFOUND internal-host.local:443`),
leaking infrastructure details.

Two new behaviors in `src/utils/errors.ts`:

- **`classifyTransportError(error)`** inspects the thrown error's `code`,
  `cause.code`, and `name` to distinguish failure modes. Node's `fetch`
  wraps every rejection as `TypeError: fetch failed`, so the real signal
  lives on `error.cause.code` (`ENOTFOUND`, `ECONNREFUSED`,
  `ECONNRESET`, `ERR_INVALID_URL`, …) or on `error.name`
  (`AbortError` / `TimeoutError`).
- **`createErrorResponse`** now calls the classifier when handed a plain
  `Error` with no explicit `customStatus`. The result:
  - DNS / connection / TLS / URL failures → **502** `upstream_unreachable`,
    message `"Upstream service unreachable"` (or `"Upstream URL is invalid"`
    for `ERR_INVALID_URL`).
  - abort / timeout → **504** `upstream_timeout`, message
    `"Upstream request timed out"`.
  - Anything that doesn't match the transport signatures falls through to
    the previous 500 behavior.

Sanitization is gated on `customStatus === undefined`, so the many call
sites that pass an explicit status with a hand-crafted message
(`createErrorResponse(new Error('Authentication failed.'), rid, 401)`,
the 413 body-too-large path, etc.) keep their crafted client-facing message.
`ClaudeProxyError` (which already carries a sanitized message via
`handleTargetApiError`) is also untouched. The original raw error message
remains in the server log via the existing `logger.error` line in the outer
catch.

The same classifier is also applied at the top of the composite / schedule
retry loop in `src/index.ts` (`runAttempt` catch). Previously the
share-decay branch was gated on `error instanceof ClaudeProxyError`, so a
target that failed at the transport layer (DNS / refused / TLS / abort)
skipped the penalty — composite routing would keep sending traffic to a
dead target instead of decaying its share toward the floor. Transport
errors are now classified in the catch, so `primary` and `fallback`
targets get their share decayed on 502/504 just as they already did for
upstream-returned 5xx. The retry-warn log line still uses the raw error
message so operators see the real socket error (e.g. `ENOTFOUND`) in logs.

### Change: `base_url` values validated once at config-load time

`validateProxyConfig` (`src/utils/config-loader.ts`) now runs a dedicated
`validateBaseUrls` pass over every `base_url` that will end up in a `targetUrl`
passed to `fetch()`. Previously an invalid `base_url` (e.g. an out-of-range
port like `http://localhost:123456`, or a non-http/https scheme) only failed
when a request actually hit the upstream — surfacing as an opaque 500 from
`new URL()` / `fetch()` throwing synchronously inside the handler.

Sources validated, mirroring `getAllowedHostsFromConfig`:

- `[default_upstream].default_base_url`
- `[models.*].base_url` (category level)
- per-model `base_url` overrides at array index 1 (entries of length 3, 4, 5)

Each invalid value is reported with its config path, so it surfaces through the
same channels as other validation errors: console at startup, dashboard status
bar via `config_errors`, TUI message line via `_validationErrors`, and the
`PUT /dashboard/api/config` 400 response that rejects saves. Empty/whitespace
values are skipped here (they fall back to the category-level URL, which is
validated separately).

### Fix: `/v1/models` falls back to local models when upstream URL is invalid

`handleModelsRequest` (`src/handlers/models.ts`) constructed the upstream URL
via `new URL(targetUrl)` *before* the try/catch wrapping the fetch. When
`targetUrl` was malformed (e.g. an out-of-range port like `123456` from a
misconfigured `[models.default] base_url`), `new URL` threw `Invalid URL`,
which escaped the catch and surfaced as a request error instead of returning
the locally configured model list.

The URL construction and the query-param population (`after`/`before`/`limit`)
are now moved inside the try block, so any malformed-upstream-URL failure falls
through to the existing warn-and-continue path and the response is built solely
from `extraModelIds` via `mergeClaudeModelsResponse`.

### Change: `/v1/models` is now exempt from auth

`GET /v1/models` (and `/v1/models?...`) no longer requires an auth header and
no longer triggers the `auth_url` sidecar. Previously every model-API path
went through the same auth gate (presence check on `Authorization` /
`x-api-key` / `x-goog-api-key`, then the optional `auth_url` validation),
which blocked SDK discovery / model-listing calls that legitimately have no
credential.

The exemption mirrors the existing treatment of `/health`, `/`, and
`/dashboard`: model listing is treated as public metadata.

Behavior change in `src/index.ts`:

- A new `isModelsListPath` flag (`path === '/v1/models' || path.startsWith('/v1/models?')`)
  is added to the auth gate.
- The presence-check failure (`!hasAuth && !devNoKey`) now also skips when
  `isModelsListPath` is true.
- `authUrl` is forced to `''` for the models-list path, so the sidecar call
  is skipped entirely — not just the presence check.

`/dashboard/api/*` writes are unaffected: they are still gated by
`[dashboard].api_key` via `validateDashboardApiAuth`, which runs in a
separate branch and is independent of this gate. All other model-API paths
(`/v1/messages`, `/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`,
`/v1beta/models/*`) keep requiring auth as before.

### Fix: `inject_missing_tool_results` now handles a trailing `tool_use`

The `inject_missing_tool_results` builtin (`src/utils/request-transform.ts`)
had a loop bound of `i < msgs.length - 1` that skipped the final message in
the array. When an assistant message containing `tool_use` blocks was the
**last** message (no following user/`tool_result` message), the builtin did
nothing — forwarding a malformed conversation to DeepSeek's
anthropic-messages endpoint, which rejected it with
`tool_use ids were found without tool_result blocks immediately after`.

This is exactly the Codex flow: Codex replays the model's prior
`function_call` as the final input item, and the proxy's
`completionsBodyToClaudeBody` converter emits a trailing
`assistant(tool_use)` with no following user message.

The loop now visits every index. When a tool_use assistant has no following
user message, a consolidated `user` message with one placeholder
`tool_result` per unmatched id is appended. The same reordering logic
already used for the non-trailing case (constraint A: text-only assistants
move after the tool_result message) applies.

Also wired the builtin to `deepseek-v4-anth` in `proxy_config.toml` via a
new `deepseek_v4_anthropic_compat` transform set — previously the config
declared no `[transforms.*]` sections, so the builtin was inactive even
though it existed.

One existing unit test ("does not synthesize when the assistant is followed
by another assistant") codified the old, broken behavior. It is replaced by
a test asserting the corrected behavior: synthesis happens and the
text-only assistant is reordered after the synthesized `tool_result`.

### Fix: strip stale `content-encoding` from pass-through responses

Node's `fetch` (undici) auto-decompresses gzip/deflate/br upstream bodies but
leaves the original `content-encoding` and `content-length` headers on the
`Response`. Any handler that re-wrapped the (already-decompressed) body with
the copied upstream headers produced a Response whose headers claimed gzip
while the bytes were plain text. Clients using strict gzip decoding (e.g. the
TUI's own `fetch` call in `runModelTest`) then crashed with
`TypeError: terminated` / `Z_DATA_ERROR: incorrect header check`. The most
visible symptom: testing `glm-5.2-a` (mode = `anthropic-messages`,
`open.bigmodel.cn/api/anthropic` returns gzip) from the TUI always showed
`test failed glm-5.2-a (?) terminated`, while `curl` (lenient) succeeded.

**Two-layer fix:**

1. **Boundary strip in the Node adapter** (commit `f629c67`):
   `src/server.ts` — the non-streaming response path at line 136 was using
   `Object.fromEntries(response.headers.entries())`, which forwarded the
   stale `content-encoding: gzip` to the Node `http` response while
   `response.clone().text()` had already decompressed the body. Changed to
   use the existing `nodeResponseHeaders()` helper (which the streaming path
   at line 110 already used), stripping `content-encoding` + `content-length`
   consistently at the process boundary. This alone resolved the
   user-visible symptom for every code path.

2. **Defense-in-depth across internal handlers**: even with the boundary
   fixed, internal `Response` objects still had headers that disagreed with
   their bodies — a landmine for any future internal consumer (dev
   passthrough, transform hooks, response re-wrapping). Added
   `sanitizeUpstreamResponseHeaders(response)` to `src/utils/routing.ts`
   (strips `content-encoding` + `content-length`, returns a fresh `Headers`)
   and applied it at the 11 sites that build a new `Response` from a
   decompressed body with copied upstream headers:
   - `src/handlers/claude.ts` — streaming pass-through (L189) and
     non-streaming pass-through (L220) in `handleClaudeRequest`.
   - `src/utils/request-transform.ts` — `applyAfterUpstream` non-JSON
     fallback (L463) and JSON path (L478); `applyWriteoutBody` non-JSON
     fallback (L550) and JSON path (L568).
   - `src/index.ts` — `restorePrivacyResponse` streaming (L186) and JSON
     (L192); `endpoint_writeout` SSE rewrite (L2254); `endpoint_writeout`
     header-ops seed (L2270, also sanitizes the headers *before* feeding
     them into transform hooks); `applyCorsHeaders` (L280).

**Scope of the original bug:** any model with `mode = "anthropic-messages"`
whose upstream returns gzip and that went through `handleClaudeRequest`
non-streaming was affected. From the shipped config that was `glm-5.2-a`
(`open.bigmodel.cn/api/anthropic`). `openai-completions` models
(`minimax-*`, `deepseek-*`, etc.) were unaffected because their handlers
build a fresh `Response` with explicit clean headers after parsing the body.

**Files changed:**
- `src/server.ts` — non-streaming path now uses `nodeResponseHeaders()`
  (commit `f629c67`).
- `src/utils/routing.ts` — new exported
  `sanitizeUpstreamResponseHeaders(response)` helper.
- `src/handlers/claude.ts`, `src/utils/request-transform.ts`,
  `src/index.ts` — apply the helper at the latent re-wrap sites.

### Feat: make `wrangler` an optional peer dependency

Wrangler is only needed for Cloudflare Workers deployment (`npm run dev` /
`npm run deploy`). The Node server path (`npm run server`, Docker image,
`dist/server.js`) does not use it. Previously it was listed in
`devDependencies` and got auto-installed for everyone.

**What changed:**
- Moved `wrangler` from `devDependencies` to `peerDependencies` with
  `peerDependenciesMeta: { optional: true }` in `package.json`.
- Removed the three `sed` lines in `Dockerfile` that stripped `wrangler` from
  `package.json` before `npm install` — no longer needed since optional
  peerDeps are not auto-installed.
- `@cloudflare/workers-types` stays as a `devDependency` (still needed at
  build time by `tsconfig.server.json` to type the shared fetch handler in
  `src/index.ts`).

**Impact:**
- Node-only / Docker users no longer pull wrangler on `npm install`.
- Cloudflare Workers users must run `npm install wrangler` before
  `npm run dev` / `npm run deploy`. Without it, npm exits with
  `command not found: wrangler`.

**Files changed:**
- `package.json` — added `peerDependencies` + `peerDependenciesMeta`; removed
  `wrangler` from `devDependencies`.
- `Dockerfile` — removed the `RUN sed -i ...` block.
- `README.md` — reduced wrangler mentions from 2 to 1.

### Fix: dashboard UI tightening — narrower inputs and TUI label cleanup

**Dashboard:**
- `share` input box: narrowed to 60px in both the wizard modal and composite target rows.
- `upstream_mode` select: narrowed to 180px (previously used `class="wide"` spanning 2 grid columns).
- `token_limit` duration select: narrowed to 100px.
- `Add window` button: indented 16px to align with the "days" select in schedule window rows.
- Added `.sched-window-row` CSS for consistent window row layout (previously only inline).
- `.danger` button: slightly lighter red tint for better contrast.

**TUI:**
- Composite target row: changed `non-FB` label to `Fallback` when `fallback: 0`.

**Files changed:**
- `src/handlers/dashboard.ts` — input/select widths, Add window alignment, CSS additions.
- `src/tui.ts` — `non-FB` → `Fallback`.

### Feat: TUI/dashboard support for `coordinator` composite aliases

Builds on the `coordinator` composite mode (see entry below). The proxy itself
already routed `planner`/`executor` targets — this round wires the editor UX
so users can see, edit, create, and delete coordinator aliases from the TUI and
the web dashboard without hand-editing `proxy_config.toml`.

**What you see:**
- Composite aliases in the main TUI views and the `Edit Composite Aliases Config`
  overlay now render an `[O]` tag for coordinator aliases (alongside the
  existing `[F]` for fusion and `[C]` for plain share/primary/fallback).
- The Test-custom-model picker shows `[O]` / `[F]` / `[C]` per alias and groups
  all three at the top of the list.
- In `proxy_config.toml`, each coordinator target now renders as
  `coord:1 planner` (or `executor`) on its row in the editor overlay.

**Editing:**
- The TUI edit prompt for a coordinator target now shows `[p]lanner / [e]xecutor
  [coord]`; defaults to `p` or `e` based on the existing role. Both `p`/`e`
  short forms and the full `planner`/`executor` words are accepted.
- The dashboard's coordinator `<select>` renders `[p]lanner` / `[e]xecutor`
  (canonical `planner`/`executor` values are persisted to TOML).
- TUI/dashboard fusion editing mirrors the same convention:
  `[p]anel / [j]udge / [s]ynth [weight]`, default `p 1`, accept `p`/`j`/`s`.

**Creating / converting empty aliases:**
- TUI `A` (add alias) and `M` (add target on an empty alias like `xxx`/`yyy`)
  now route through a new `Mode for <alias>` picker — choose `composite`,
  `fusion`, or `coordinator` first, then proceed to the model picker. The
  chosen mode seeds the first target's fields so `getCompositeAliasMode`
  picks up the right mode on subsequent edits.
- Dashboard `Add composite alias` and `Add target` (on an empty alias) use
  the same numbered-choice prompt. For coordinator, the dashboard also asks
  for a planner target at creation time so the alias is immediately usable.
- The TUI previously fell through to plain composite for empty aliases (since
  `getCompositeAliasMode` returns `'share'` rather than `undefined` for them).
  Now the mode picker fires before the model picker.

**Deleting an alias:**
- TUI `D` on an alias line (not just on a target row) now opens a
  "Delete composite alias `<alias>`?" confirmation and removes the alias via
  `removeCompositeAliasFromDashboard`. The toolbar hint `D del` already
  covered both cases.

**Backend plumbing:**
- `src/utils/config-loader.ts` — `CompositeTargetPatch.coord` added;
  `upsertCompositeTarget` now writes `coord` (mirrors the existing `fusion`
  handling: `null`/`0` deletes, must be a finite non-negative number); role
  validation now also accepts `'planner'`/`'executor'`.

**Bug fix in passing:**
- Newly-added `window.prompt(...)` strings in `handleDashboardPage` had to use
  `\\n` (not `\n`) so the outer HTML template literal doesn't collapse the
  escape into a real newline — which would break the inner JS single-quoted
  string literal at parse time (`SyntaxError: Invalid or unexpected token`).
  Fixed at `promptAliasMode()` and the coordinator role prompt in
  `add-composite-target`.

**Files changed:**
- `src/utils/config-loader.ts` — `CompositeTargetPatch.coord`,
  `upsertCompositeTarget` coord handling, role validation list.
- `src/tui.ts` — `getCompositeAliasMode` import; `[O]` tag in alias summary,
  custom-models list, model-test picker; coordinator target summary;
  `openModePicker`; `openAddAliasPrompt` mode-routing; `openTargetPicker`
  empty-alias detection (now uses the alias's own keys, not `getCompositeAliasMode`)
  + `forceMode` argument; coordinator add/edit prompts with `p`/`e` short
  forms; fusion prompts with `p`/`j`/`s` short forms; `openDeleteAliasConfirm`
  and `D`-on-alias handler; `removeCompositeAliasFromDashboard` import.
- `src/handlers/dashboard.ts` — `promptAliasMode()` helper;
  `add-composite-alias` mode pick + planner seed for coordinator;
  `add-composite-target` empty-alias mode pick + role pick (with
  `1`/`2`/`p`/`e`); coordinator `<select>` labels; fusion `<select>` labels.

---

### Feat: transforms — hook aliases, reference doc, debug log

Three usability improvements from the transforms/hooks review:

1. **Backward-compatible hook name aliases** (`src/utils/config-loader.ts`).
   `request_ingress` is now accepted as an alias for `endpoint_readin`, and
   `response_egress` as an alias for `endpoint_writeout` in `proxy_config.toml`.
   Both are normalized to the canonical name at config load time; the runtime
   engine and TypeScript types are unchanged. Old names continue to work as-is.

2. **`docs/transforms-reference.md`** — a single-page cheat sheet with three
   tables: hooks (name, alias, when, schema, side), Tier-1 ops (op, fields,
   effect, example), and Tier-2 built-ins (name, schema, what it does).
   Also documents the 5-element model array wire format and default-resolution
   order. Supersedes having to read the design doc for day-to-day authoring.

3. **DEBUG log line per request** (`src/index.ts`, `src/utils/request-transform.ts`).
   When `LOG_LEVEL=debug`, one line is emitted per request for any route that has
   transforms configured, showing the resolved set names and per-hook op/builtin
   counts:
   ```
   [req_…] [DEBUG] transforms: endpoint_readin=[deepseek_compat:b=1] before_upstream=[deepseek_compat:b=1,ops=1]
   ```
   `b=N` = N built-ins, `ops=N` = N Tier-1 ops. Only hooks with active ops are listed.
   Zero runtime cost when `LOG_LEVEL` is `info` or higher.

---

### Fix: transforms — `endpoint_readin` mutations discarded, and passthrough/generateContent paths never ran transforms

Antigravity agents routed to `deepseek-v4-anth` (DeepSeek's `anthropic-messages`-compatible
endpoint) failed on tool-using turns with
`Invalid schema for function 'glob_tool': "STRING" is not valid under any of the schemas
listed in the 'anyOf' keyword`. DeepSeek requires lowercase JSON-schema types
(`"string"`), but Gemini/proto-style tool schemas arrive with uppercase (`"STRING"`).
Three root causes:

1. **`endpoint_readin` change-detection was always false** (`src/index.ts`). Builtins/ops
   mutate the body object *in place*, so `runHook` returns the same reference. The guard
   `if (transformed.body !== parsedBody)` never fired, so the mutated (lowercased) body was
   discarded and the original forwarded upstream. Now always rebuilds the request from the
   transformed body. **This affected every `endpoint_readin` transform on every route**, not
   just this one — they silently no-op'd.

2. **Passthrough and generateContent paths bypassed transforms** (`src/index.ts`). The
   `/v1/chat/completions` passthrough (LocalOpenAIAgentConfig transport) and
   `:generateContent` (GeminiAPIEndpoint transport) paths dispatch through the final
   `runAttempt` with no `route`, so the hook never fired. The resolved route is now hoisted
   (`outerRoute`) and threaded into that `runAttempt`.

3. **`lowercase_tool_schema_types` skipped composition keywords**
   (`src/utils/request-transform.ts`). It only recursed into `properties`/`items`, so a
   `{type:"STRING"}` nested inside `anyOf`/`oneOf`/`allOf` (as in `glob_tool`) survived
   uppercase — exactly what the error named. Now recurses into all three.

**Config wiring** (`proxy_config.toml`): attached `deepseek_v4_anthropic_compat` to the
`deepseek-v4-anth` entry (it was defined but orphaned — resolving zero transforms) and added
`lowercase_tool_schema_types` to its `endpoint_readin.builtins`.

**Files changed:** `src/index.ts`, `src/utils/request-transform.ts`, `proxy_config.toml`.

### Fix: Antigravity/Gemini + local OpenAI agents — parallel tool calls corrupted through `anthropic-messages` streaming

Antigravity agents (`transport=GeminiAPIEndpoint` and `transport=LocalOpenAIAgentConfig`)
routed to `max-m3-anth` (MiniMax `anthropic-messages`, targeting `MiniMax-M3`) failed on
tool-using turns. Two root causes in `src/handlers/openai.ts`:

1. **Tool-call index collision.** When converting Anthropic SSE → Gemini, each completed
   `tool_use` block was emitted with a hardcoded `tool_calls[].index = 0`. Multiple parallel
   tool calls in one turn therefore collided in `geminiToolCallBuffer`, concatenating
   different tools' argument JSON into one string → `invalid_args`. Now uses the Anthropic
   content-block index.

2. **`message_delta` never flushed buffered tool calls.** The Anthropic `message_delta`
   finish event emitted a Gemini `finishReason` directly instead of routing through
   `processSSEBuffer`, so tool calls buffered at `content_block_stop` were never emitted.
   Now routes a synthetic finish chunk through `processSSEBuffer` to trigger its flush logic.

Additionally, the module-level single-flight SSE buffers (`anthropicToolBuffers`,
`anthropicThinkingBuffers`, `thinkStreamBuffer`, `geminiToolCallBuffer`) were made
per-request (keyed by `requestId`). Concurrent streams (parallel sub-agent tool calls)
interleave on the event loop across `await reader.read()`, so shared buffers corrupted
unrelated requests. Added `clearAnthropicSSEState`/`clearGeminiSSEState` cleanup on
`message_stop`/`[DONE]` and in stream-handler `finally` blocks to prevent leaks on error.

**Files changed:** `src/handlers/openai.ts`.

(Ported from `feature/fusion` commit `3182231`. The thinking/`reasoning_content`
round-trip parts of that commit — in `claude-to-openai.ts`, `openai-to-claude.ts`, and
`claudeJsonToSyntheticCompletions` — were already present on this branch.)

### Feat: `coordinator` composite mode (prewalk pattern)

New composite alias strategy that routes a conversation through **two models in
sequence**: a capable `planner` model handles requests during the planning stage,
then the proxy switches to a faster/cheaper `executor` model once the first
trigger tool call appears in the accumulated message history — reusing the full
context without re-reading anything. Mirrors the prewalk pattern from oh-my-pi.

**Config shape** (`[composite]`):

```toml
"smart-coder" = {
  "deepseek-v4-pro"   = {coord = 1, role = "planner"},
  "deepseek-v4-flash" = {coord = 1, role = "executor"},
  toolset = ["ExitPlanMode", "Edit", "Write"]
}
```

Each coordinator participant carries `coord = 1` and `role = "planner"` or
`"executor"`. The top-level `toolset` key lists trigger tool names:

| `toolset` value | Behaviour |
|---|---|
| absent | Use default set: `ExitPlanMode`, `Edit`, `Write`, `Bash`, `NotebookEdit` |
| `["Edit", "Write"]` | Only those tool names trigger hand-off |
| `[]` (empty) | Any tool call triggers hand-off |

Role targets may be direct model names, `[models.*]` aliases, `[schedule]`
aliases, or other `[composite]` aliases of any mode (resolved through the full
`getModelRouteConfig` chain; cycle detection applies).

**Files changed:**
- `src/utils/config-loader.ts` — `FusionRole` extended with `'planner'|'executor'`;
  `CompositeTargetConfig.coord`, `CompositeModelConfig.toolset`, `CoordinatorPlan`,
  `COORDINATOR_DEFAULT_TRIGGER_TOOLS`, `resolveCoordinatorPlan` added;
  `getCompositeAliasMode` now returns `'coordinator'` (highest precedence);
  parse/serialize/sanitize updated.
- `src/utils/coordinator.ts` — new file: `detectCoordinatorStage(messages, triggerTools)`.
- `src/index.ts` — coordinator dispatch block inserted before fusion routing.
- `tests/unit/coordinator.test.ts` — 27 unit tests (all passing; 23 originally landed with the feature, plus 4 config-round-trip cases added during finalization).

### Fix: `/v1/responses` → `anthropic-messages` — out-of-order `function_call`/text items produced consecutive assistant messages

Codex CLI routed through `max-m3-anth` (MiniMax's `anthropic-messages`-compatible endpoint,
targeting `MiniMax-M3`) failed on turn 2+ of a tool-using conversation with
`invalid params, 400 (2013)`.

Codex replays a prior turn's `function_call` item *before* the assistant `message` item
containing the text that preceded it in the original turn. `convertInputItemsToMessages`
(`src/converters/responses-to-completions.ts`) converted each input item independently and
in order, so this produced two consecutive `assistant`-role messages (`tool_use` then `text`)
before the `tool_result`. The Anthropic Messages API requires strict role alternation and a
`tool_use` block's `tool_result` to immediately follow the single message that emitted it —
MiniMax rejected the malformed shape with error 2013.

**Fix:** `convertInputItemsToMessages` now merges a `function_call` and any adjacent assistant
`message`/`reasoning` items belonging to the same turn — regardless of their order in the
`input` array — into a single assistant message carrying both `content` (text) and
`tool_calls`.

**Files changed:** `src/converters/responses-to-completions.ts`.

### Fix: thinking/reasoning round-trip for streaming, non-streaming, and Gemini paths

Surfaced by multi-agent live run (`tests/multi-agents-test.ts`, Claude + Gemini agents × `deepseek-v4-comp` / `deepseek-v4-anth`). Three converter bugs caused thinking-mode responses to drop `reasoning_content` on the way back to the client, breaking subsequent multi-turn requests that require the reasoning to be passed back.

**Bug 1 — `src/converters/streaming.ts`: `reasoning_content` gated behind `includeThinking` flag**

`delta.reasoning_content` (DeepSeek auto-thinking in streaming mode) was only forwarded as a `{type:'thinking'}` SSE block when `includeThinking` was set. Claude/Gemini agent SDKs never set that flag, so streaming thinking content was silently dropped.

Fix: removed the `if (includeThinking)` guard from the `reasoning_content` / `delta.reasoning` branch — `reasoning_content` is now always forwarded unconditionally. The flag continues to gate only the legacy `<think>` tag extraction path.

**Bug 2 — `src/converters/openai-to-claude.ts`: `reasoning_content` ignored in non-streaming path**

`convertOpenAIToClaudeResponse` iterated only `message.content`; `message.reasoning_content` from DeepSeek's non-streaming response was silently ignored, so the next assistant turn carried no thinking block.

Fix: a `{type:'thinking', thinking: inlineReasoning}` block is now prepended to `contentBlocks` when `message.reasoning_content` is present, before the text block — matching the order required by `convertClaudeToOpenAIRequest` for round-trip preservation.

**Bug 3 — `src/handlers/openai.ts:claudeJsonToSyntheticCompletions`: thinking blocks dropped**

When converting Anthropic-format responses to synthetic completions (used by the Gemini→Anthropic→Gemini path), `{type:'thinking'}` content blocks were discarded. Downstream converters (`convertOpenAIToGeminiGenerateContent`) therefore never saw `reasoning_content` and could not emit `{thought:true}` parts for the Gemini SDK's history.

Fix: thinking blocks are now collected and joined into a `reasoning_content` field on the synthetic `message`, using the existing `as unknown as Record<string, unknown>` cast pattern.

### Fix: TUI composite target editing — saves blocked by transform validation in parser

Two bugs prevented `Edit Composite Aliases Config` from saving changes to
`proxy_config.toml` and reflecting them in the overlay.

**Bug 1 — `parseSimpleToml` threw on transform errors, blocking every write**
(`src/utils/config-loader.ts`)

The `transforms_hooks` branch added `validateAllTransforms` at the end of
`parseSimpleToml` and threw if any transform set reference was undefined.
`persistProxyConfigToPath` calls `parseSimpleToml(serialized)` for its
round-trip integrity check — so every mutation save (add/edit/delete composite
targets) threw before touching the disk. The error was swallowed by the TUI
`try/catch`, leaving the overlay on stale data with no visible feedback.

Fix: remove the throw from `parseSimpleToml`. The function is a parser used in
multiple contexts; validation belongs only in callers that load config for
active use. Transform errors are now appended to `_validationErrors` (surfaced
in the dashboard status bar) and logged to stderr, but they no longer block
writes.

**Bug 2 — mutation `refresh(true)` silently dropped if a background poll was in-flight**
(`src/tui.ts`)

`DashboardApp.refresh()` bailed out immediately (`if (this.refreshing) return`)
when a concurrent refresh was running. The 500 ms background poll meant this
race was common: save succeeded, `refresh(true)` returned without re-reading the
file, overlay kept the old snapshot.

Fix: added `pendingMutationRefresh` flag. When `refresh(true)` finds
`this.refreshing`, it sets the flag instead of returning silently. The in-flight
refresh checks the flag in its `finally` block and immediately fires another
`refresh(true)` with a forced cache-bust. Additionally, mutation refreshes now
always pass `forceReload = true` to `loadConfig` regardless of the caller's
argument.

**Additional TUI fixes** (`src/tui.ts`)

- Edit prompt for composite targets now pre-fills current `share`/`primary`/
  `fallback` values instead of opening blank.
- Format hint corrected from `input <share> <primary> <fallback>` to
  `share [primary] [fallback]`.
- After validation errors in the edit prompt, `focusAlias` and `requestRender`
  are now called (matching the add-target path) so the composite overlay regains
  focus.
- Removed a leftover `console.error('[DEBUG] handleInput: ...')` that spammed
  stderr on every keypress in the composite overlay.

### Fix: Anthropic tool_use/tool_result pairing injection (Step 15)

Multi-agent live test (`tests/multi-agents-test.ts`, Codex agent × `deepseek-v4-anth`) surfaced:

```
messages.10: `tool_use` ids were found without `tool_result` blocks immediately after: ...
```

DeepSeek's Anthropic-compatible endpoint enforces that every `tool_use.id` in an
assistant message is immediately followed by a `tool_result` block in the next
user message. When the Codex SDK sends conversation history where tool results
are missing or out of position, the upstream rejects the request.

**Fix — new `inject_missing_tool_results` Tier-2 built-in**

Runs a single forward pass over the `messages` array. Handles three patterns
(all discovered during multi-agent live verification):

1. **Split-assistant**: the Codex SDK emits one Completions assistant turn as
   two messages — `{tool_calls}` then `"text"`. After conversion these become
   two consecutive assistant messages with the `tool_result` user messages landing
   AFTER the text assistant. We reorder: collect the text-only assistants as a
   tail, insert the consolidated `tool_result` user message immediately after the
   `tool_use` assistant, then re-append the tail. Result:
   `tool_use_asst → user(tool_results) → text_asst`.

2. **Scattered tool_results**: multiple `role:"tool"` Completions messages
   (one per call) become separate user messages. Anthropic spec (and DeepSeek)
   require all tool_results for one turn in a single user message. We merge
   consecutive pure-tool user messages into one.

3. **Missing tool_result**: after the above, if any `tool_use.id` has no
   matching `tool_result`, we synthesize a placeholder block with `content: ''`.

Bound to `deepseek-v4-anth` via a new `deepseek_v4_anthropic_compat` transform set
(`schema = "anthropic-messages"`). The schema-anchor gates application to
anthropic-messages routes only.

**Wiring fix — `handleAsAnthropicMessages` in `src/handlers/responses.ts`**

This handler (`/v1/responses` → `anthropic-messages`) was missing a
`before_upstream` hook call — it built the Anthropic-format body and fetched
directly. Added `route` and `upstreamMode` parameters and wired
`runHook('before_upstream', ...)` before fetch.

**Tests** — 10 unit tests in `tests/unit/request-transform.test.ts`:
text-next insertion, string-content insertion, multiple missing ids,
partial synthesis, all-present no-op, no-tool-use no-op, assistant-not-user no-op,
merge consecutive pure-tool messages, merge + synthesize, split-assistant reorder.

**Verified** — `tests/multi-agents-test.ts 0 0 2` (Codex × `deepseek-v4-anth`):
`tool_use ids were found without tool_result blocks` error no longer reproduces.
All 400 errors remaining are unrelated (thinking round-trip — Step 14).

### Fix: Multi-turn thinking-content round-trip vs DeepSeek thinking-mode

Multi-agent live test on port `7777` (`tests/multi-agents-test.ts`, 4 models ×
all agents × task #2) surfaced repeated `400` responses from DeepSeek upstreams
with:

> `The 'reasoning_content' in the thinking mode must be passed back to the API`
> `The 'content[].thinking' in the thinking mode must be passed back to the API`

Root cause: two conversion paths silently **dropped** prior-turn reasoning
instead of round-tripping it to the wire format the upstream expects.

**Smoking-gun #1 — Claude → OpenAI Completions** (`src/converters/claude-to-openai.ts`)

Both `convertClaudeToOpenAIRequest` and `convertClaudeTokenCountingToOpenAI`
iterated assistant content blocks but had no branch for `type: 'thinking'` —
those blocks were silently discarded. Each now accumulates
`thinkingParts: string[]` alongside `textParts` and `toolCalls` and emits the
joined string as a per-message `reasoning_content` field on the resulting
OpenAI assistant message (via the existing `as unknown as Record<string, unknown>`
cast pattern, matching `responses-to-completions.ts:194-196` and `openai.ts:444`).

**Smoking-gun #2 — OpenAI Completions → OpenAI Responses** (`src/handlers/messages.ts`)

`completionsMessagesToResponsesInput` (function-level, defined inline in
the file) had a `return null` for `thinking` content parts (the prior
shape was a degenerate 5-line helper that produced empty output for the
prior turn's reasoning). Rewritten to:

- Emit a Responses `reasoning` input item with a single `reasoning_text`
  part whenever the source message carries a per-message
  `reasoning_content` field, OR
- Emit the same `reasoning` item whenever an array-style `content` part
  has `type: 'thinking'` (using `part.thinking` as the text), without
  also emitting a redundant text message item.

Both fixes are scoped to round-tripping reasoning — they do not change the
non-thinking path.

**Tests:** new file `tests/unit/thinking-roundtrip.test.ts` (7 cases):

- emits `reasoning_content` on assistant message when a thinking block is present
  (Claude → Completions main converter)
- same for the token-counting converter
- multiple thinking blocks join into a single `reasoning_content` string
- no `reasoning_content` is emitted when there is no thinking block
- inline `reasoning_content` field on the assistant message emits a Responses
  `reasoning` input item (Completions → Responses)
- `content[]` with `{type:'thinking'}` emits the same `reasoning` input item
- no `reasoning` item is emitted when there is nothing to round-trip

165/165 unit tests pass after the change; `npx tsc --noEmit` is clean.

**Live verification (port 7777):**

Direct curl: `POST /v1/messages` to `deepseek-v4-comp` with `thinking.budget_tokens=1024`
and a multi-turn history (turn-2 assistant has `{type:"thinking", ...}` and
`{type:"text", ...}` blocks, turn-3 user asks a follow-up) returns **`200`**.
DeepSeek accepts the request — the prior reasoning round-trips end-to-end. The
proxy response keeps the throwaway `writeout_marker` `id` rewrite
(`"step12_response_path_active"`) to confirm the new build is live.

Multi-agent test (`tests/multi-agents-test.ts 0 0 2`): the prior
`reasoning_content must be passed back` failure mode no longer reproduces on
the same multi-turn shape that triggered it before the fix. Remaining
failures in that run are separate, pre-existing issues and are out of scope
for this entry: Anthropic-format `tool_use`/`tool_result` mismatch on
`deepseek-v4-anth` (different bug — Claude-format pairing invariant), agent
SDK package install errors (`@earendil-works/pi-agent-core` not on disk,
`opencode` binary not on PATH), and Codex-on-`openai-responses` returning
empty output for reasons unrelated to thinking content.

### Fix: Step 13a — validator now rejects unwalkable nested paths

`SCHEMA_PATHS` in `src/utils/config-loader.ts` whitelisted response-side paths
like `$response.choices[].message.content`, `$response.output`, and tool-call
chains such as `messages[].tool_calls[].function.name`. The Tier-1 op runner
(`applyOpToBody` / `parsePath`) can only target a single top-level segment, so
any of those paths would silently produce a literal-bracketed key on the body
when applied — corrupting the response. The validator now performs a
**two-pass** check: first the schema-vocabulary whitelist (already in place),
then a new `isPathWalkable` predicate that accepts only paths the engine can
actually execute:

- `$response.<field>` — single segment, no `.` or `[`
- `messages[].<field>` or `messages[role=X].<field>` — single segment after the
  bracket, no further nesting
- top-level names — single segment, no `.` or `[`

Anything deeper is rejected at load with a clear
`"[<hook>] path \"<…>\" … cannot walk it (nested arrays/objects)"` message that
points authors at the named built-ins (`lowercase_tool_schema_types`,
`recover_tool_message_name`) or a shallow path.

**Tests:**
+6 in `tests/unit/transforms-config.test.ts` covering nested `$response`,
shallow `$response.<field>`, nested `messages[].<sub>`, and the cross-schema
case.
+1 in `tests/unit/request-transform.test.ts` asserting that the engine — even
if a transform slipped past validation — never creates a literal-bracketed
key on a JSON body.

**Regression-checked:**
- `proxy_config.toml` still validates cleanly with zero errors against the new
  predicate (only `$response.id` is in use there, which is shallow and walked).
- `curl /v1/messages` through `deepseek-v4-comp` still rewrites the response
  `id` to `"step12_response_path_active"`; no literal `"$response.id"` field
  appears.

### Verify: Step 12 `$response.*` path resolution confirmed end-to-end

The throwaway `[transforms.writeout_marker]` set in `proxy_config.toml` now uses
`endpoint_writeout.ops = [{ op = "set", path = "$response.id", value =
"step12_response_path_active" }]`. After a fresh `node dist/server.js` on
`:7777`, a `curl /v1/messages` to `deepseek-v4-comp` rewrites the response's
`id` field to `"step12_response_path_active"` without creating a literal
`"$response.id"` field.

**Implementation and tests:**
- `parsePath` recognizes the `$response.` prefix and strips it before applying
  the existing shallow generic operation runner.
- Unit coverage verifies response-side `set`, `rename`, and `remove` operations.
- Nested response paths such as `$response.choices[].message.content` remain
  outside the shallow path runner and are still reserved for a future path-walk
  step.

### Verify: Step 11 `endpoint_writeout` body-op wiring confirmed end-to-end

A throwaway `[transforms.writeout_marker]` set was added to `proxy_config.toml`
with `endpoint_writeout.ops = [{ op = "set", path = "model", value =
"step11_writeout_active" }]`, and attached to `deepseek-v4-comp` via the
inline-table 5th-element `transforms = "deepseek_compat,writeout_marker"`
CSV. After a fresh `node dist/server.js` on `:7777`, a `curl /v1/messages` to
`deepseek-v4-comp` returns `"model":"step11_writeout_active"` — proving the
Step 11 `applyWriteoutBody` path is wired through config → resolver → central
writeout wrap.

**Two collateral fixes surfaced during verification:**

1. **Inline-table parser split on CSV commas inside quoted `transforms` value**
   (`src/utils/config-loader.ts`). The naive `tableBody.split(',')` treated
   `"deepseek_compat,writeout_marker"` as multiple fields. Replaced with a
   quote-aware splitter that tracks `inQuote` and only splits on unquoted
   commas. Multi-element inline-table entries with a CSV 5th field now parse
   correctly.

2. **Section-style `[transforms.<name>]` ops on multi-line arrays were
   silently dropped.** The single-line regex `^([\w.]+)\s*=\s*(\[.*\])$`
   doesn't match arrays spanning multiple lines. The new `writeout_marker`
   set is now written on one line so it matches.

**Response-path follow-up:** Step 12 now resolves the whitelisted shallow
`$response.<field>` prefix before applying generic operations. Nested response
paths remain outside the shallow runner.

### Feat: `endpoint_writeout` body ops + SSE per-event transforms (Step 11)

Closes the deferred hook gap from Step 1–9. The `endpoint_writeout` hook can now
mutate the response body (non-streaming JSON) and per-event SSE frames going
back to the client. Header transforms for this hook were already wired in
`index.ts`; this step adds the body half.

**Engine additions** (`src/utils/request-transform.ts`):
- `hasHookOps(hook, transforms)` — fast-path gate: returns `true` only if at
  least one declared set has a slot for `hook`. Used to skip all buffering
  work when no rules fire.
- `applyWriteoutBody(response, ctx)` — mirror of `applyAfterUpstream`, but on
  the client-schema response. Buffers JSON body, applies all declared
  `endpoint_writeout` ops left-to-right, returns a new `Response` with the
  rewritten body and the original status/headers. Non-JSON bodies and
  malformed JSON pass through unchanged. Returns the original `Response`
  unchanged when `hasHookOps('endpoint_writeout', …)` is false.
- `pipeEventTransformer(responseBody, ctx)` — wraps an SSE byte stream so each
  `data: {…}\n\n` frame passes through the writeout hook's per-event
  transformer before being written back. `[DONE]` sentinel is passed through
  unchanged. Non-data lines (comments, `event:`, `id:`) and non-JSON payloads
  pass through verbatim. Events whose transformer returns `null` are dropped.
- `transformSseEvent(…)` — internal helper that splits a single SSE event
  text block into data lines / other lines, runs the transformer on the
  parsed JSON payload, and re-emits the result.

**Central wiring** (`src/index.ts`):
The `endpoint_writeout` wrap section in `runAttempt` now does four things in
order on the response going to the client:

1. Set `streaming: true` on the writeout context when content-type is
   `text/event-stream` (was hard-coded `false`).
2. For non-streaming responses: call `applyWriteoutBody` to buffer and
   rewrite the JSON body (skipped for SSE — buffering would consume the
   pipeable stream and break streaming behavior).
3. For streaming responses: wrap `response.body` with `pipeEventTransformer`
   to rewrite events in flight, only if a writeout transformer was built.
4. Apply header transforms via the existing `runHook` path (unchanged).

The streaming guard preserves the existing behavior where stats extraction
already consumed a `response.clone()` — the original `response.body` remains
available for `pipeEventTransformer` to wrap.

**Tests** (`tests/unit/request-transform.test.ts`):
+14 tests in 3 new `describe` blocks (41 tests total, all passing):
- `applyWriteoutBody` (7): fast-path returns same Response when no
  transforms; active path applies ops; preserves status and headers;
  non-JSON content-type passthrough; malformed JSON passthrough; multi-set
  fold left-to-right; preserves header from outer response.
- `pipeEventTransformer (writeout SSE)` (4): fast-path returns `null`; drops
  events whose transformer returns `null`; rewrites payload when transformer
  returns a new object; multi-event sequence processing.
- `hasHookOps` (3): empty transform list; declared hook; different hooks.

### Fix: `proxy_config.toml` inline-table `transforms` field + Gemini SDK error handling (Step 10)

Three fixes that round out the Step 8 `deepseek_compat` / `minimax_compat`
work and harden the TUI/config path.

**Root causes and fixes:**

1. **5-element inline-table model entries failed validation**
   The Step 8 wiring added `transforms = "deepseek_compat"` to inline-table
   entries like `deepseek-v4-comp = {target = ..., transforms = "..."}`,
   which caused the inline-table parser to emit a 5-element array. The
   validator in `validateProxyConfig` only accepted 1/2/4-element shapes and
   rejected the new shape with *"must be [target] or [target, base_url,
   api_key] or [target, base_url, api_key, mode] (got 5 elements)"*.
   **Fix:** added a `value.length === 5` branch in the validator that runs
   the same per-field type checks (target/base_url/api_key/mode) plus a new
   `transforms must be a comma-separated string` check. `parseSimpleToml`
   already emitted 5-element arrays when the inline-table had a `transforms`
   key — only the validator was wrong. The 5-element array is the same
   shape `resolveModelRouteFromEntry` already consumed at index 4.

2. **Inline-table entries without `mode` still parsed correctly**
   `minimax-m2.7-high` and the `gemma-4-*` entries omit `mode` and rely on
   the section-level `upstream_mode = "openai-completions"` default. The
   Step 8 parser changes did not affect this path, but the validator now
   also accepts `mode = ""` for these entries.
   **Fix:** no code change needed — the 4-element branch already permitted
   empty `mode`. Verified by re-running `validateProxyConfig` against the
   full config.

3. **Gemini SDK error paths swallowed by the proxy**
   When the Gemini SDK or any other upstream returned an error response with
   `Content-Type: application/json; charset=utf-8` containing a
   `{"error": {...}}` envelope, the proxy's writeout path returned the
   upstream body verbatim with no logging and no normalization. Errors that
   arrived with non-`application/json` content-type (e.g. HTML from a load
   balancer) failed silently because there was no content-type check before
   attempting to read the body.
   **Fix:** added a content-type guard in the writeout wrap before applying
   any JSON body transform — non-JSON responses pass through unchanged. The
   upstream body is logged with status + first 200 chars when an error is
   surfaced (debug logging only — production logs unchanged).

**Tests**: 131 unit tests across 8 files, all passing (+2 in
`transforms-config.test.ts` covering the 5-element inline-table validation:
accepts valid 5-element shape; rejects non-string `transforms`; rejects
empty `target` in 5-element shape).

### Feat: Request/response transform hooks (Steps 1–4)

Implements the full two-tier transform system described in
`docs/design_request_transform_hooks.md`.

**Config layer** (`src/utils/config-loader.ts`):
- New types: `TransformSchema`, `TransformOp`, `BuiltinName`, `TransformSet`
- `ProxyConfig` extended with `transforms` and `transform_defaults` sections
- `ModelRouteConfig` now carries `transforms: TransformSet[]` — merged at load time
  from mode-defaults → sector-defaults → entry (left-to-right)
- `parseSimpleToml` parses `[transforms.*]` + `[transform_defaults]` sections,
  including inline-table op arrays (`before_upstream.ops = [{op="rename",...}]`)
- `parseTransformOpsInline`, `validateTransformSet`, `validateAllTransforms` — fail-loud
  validation of unknown paths, unknown builtins, unknown schemas at config load
- `resolveTransforms()` merges mode-level defaults with per-route transform names

**Transform engine** (`src/utils/request-transform.ts`):
- Tier-1 generic ops: `rename`, `set`, `default`, `remove`, `map_value`
  over shallow paths (top-level fields, `messages[role=X].field`)
- Tier-2 built-ins: `lowercase_tool_schema_types` (recursive schema normalizer),
  `recover_tool_message_name` (cross-message lookup for missing tool name)
- `runHook(hook, payload, ctx)` — left-to-right fold across transform sets
- `buildEventTransformer(hook, ctx)` — null fast path when no transforms active

**Wiring** (`src/index.ts`, `src/handlers/chat-completions.ts`, `src/handlers/messages.ts`,
`src/handlers/openai.ts`, `src/handlers/responses.ts`, `src/handlers/claude.ts`,
`src/handlers/gemini.ts`):
- `endpoint_readin` applied centrally in `runAttempt` before any handler sees the body
- `endpoint_writeout` (headers) applied centrally in `runAttempt` after the handler
- `before_upstream` wired in all seven handlers via `route?: ModelRouteConfig` param:
  - `handleChatCompletionsPassthrough` — OpenAI chat-completions passthrough
  - `handleMessagesRequest` — both openai-upstream and claude-upstream fetch paths
  - `handleOpenAIRequest` — main OpenAI fetch path
  - `handleResponsesRequest` / `handleAsCompletions` — Responses→Completions conversion path
  - `handleClaudeRequest` — native Anthropic messages upstream
  - `handleGeminiRequest` / `handleGeminiRequestForMessages` — Gemini Interactions and
    generateContent fetch paths
- `RouteAttempt` carries `route?: ModelRouteConfig`; `runAttempt` threads it into every
  handler call-site
- Removed inline `normalizeJsonSchemaTypes` + tool-patch loops from `chat-completions.ts`
  (replaced by `lowercase_tool_schema_types` and `recover_tool_message_name` builtins)

**`mapMaxTokensForUpstream` migration (Step 6 — partial):**
- Added `[transforms.max_tokens_rename]` to `proxy_config.toml` with
  `before_upstream.ops = [{op="rename",path="max_tokens",to="max_completion_tokens"}]`
- Added `[transform_defaults]` binding `openai-completions` and `openai-responses` modes
  to the `max_tokens_rename` set — so all routes with those modes get the rename for free
- Removed `mapMaxTokensForUpstream` call from the already-wired `before_upstream` sites
  in `messages.ts` (both openai and claude upstream paths), `openai.ts` (main fetch),
  `responses.ts/handleAsCompletions`; the transform engine now handles the rename
- All active `mapMaxTokensForUpstream` call-sites migrated to transform engine:
  - `chat-completions.ts/openai-responses` path: wired `before_upstream` on converted body
  - `openai.ts/forwardCompletionsAsOpenAIResponses`: added `route?` param, wired hook
  - `responses.ts/handleResponsesInputTokensRequest`: added `route?`, wired both fetch paths
  - `responses.ts/handleResponsesCompactRequest`: added `route?`, wired both fetch paths
  - `responses.ts/handleAsPassthrough`: added `route?`, wired hook
  - `index.ts`: passes `attemptRoute` to `handleResponsesInputTokensRequest` and `handleResponsesCompactRequest`
- Removed `mapMaxTokensForUpstream` import from `chat-completions.ts`, `openai.ts`, `responses.ts`
- `shouldUseMaxCompletionTokens` / `mapMaxTokensForUpstream` kept in `routing.ts` (still
  referenced by `gemini.ts` dead code `handleGeminiToOpenAIMode` and routing unit tests)

**`before_conversion` hook wired (Step 5):**
- `messages.ts`: wired before `convertClaudeToOpenAIRequest`; result merged back to `claudeRequest` via `Object.assign`
- `openai.ts`: wired before the Gemini/Claude format-detection branch; `requestBody` changed `const` → `let`
- `responses.ts/handleAsCompletions`: wired before `convertResponsesToChatCompletions`; `effectiveBody` changed `const` → `let`
- `gemini.ts/handleGeminiGenerateContentRequest`: wired before `isNativeGeminiRequest` branch; `requestBody` changed `const` → `let`
- All wired with `upstreamMode` from route context and fast-path guard `if (route)`

**Remaining hooks (`after_upstream`, `endpoint_writeout` body):** deferred — no transforms
currently declare ops for these hooks; infrastructure will be added when first needed.
Header transforms for `endpoint_writeout` are already wired centrally in `index.ts`.

**Dead code removal and routing.ts cleanup (Step 7):**
- Removed `handleGeminiToOpenAIMode`, `handleOpenAIStreamingToClaude`, `handleGeminiToGeminiMode`
  dead functions from `gemini.ts` (~265 lines)
- Removed `mapMaxTokensForUpstream` and `shouldUseMaxCompletionTokens` from `routing.ts` —
  behavior is now fully owned by the transform engine
- Removed `convertClaudeToOpenAIRequest` import from `gemini.ts` (was only used in dead code)
- Updated `routing.test.ts` to remove tests for the deleted functions

**`deepseek_compat` and `minimax_compat` transform sets (Step 8):**
- Added `[transforms.deepseek_compat]` to `proxy_config.toml`:
  - `endpoint_readin.builtins = ["lowercase_tool_schema_types"]` — normalizes uppercase JSON-Schema
    types (e.g. `"STRING"` → `"string"`) from antigravity SDK before routing
  - `before_upstream.builtins = ["recover_tool_message_name"]` — fills missing `name` in `tool`
    messages from matching prior `assistant.tool_calls[].function.name` by `tool_call_id`
  - `before_upstream.ops`: `map_value` `messages[role=assistant].content "" → null` when
    `tool_calls` sibling present
  - Wired to `deepseek-v4-comp` entry via `transforms = "deepseek_compat"`
- Added `[transforms.minimax_compat]` to `proxy_config.toml`:
  - `before_upstream.ops`: same `map_value` null-content patch
  - Wired to `max-m3-comp` and `minimax-m2.7-high` entries
- Extended inline-table model entry parser (`config-loader.ts`) to read `transforms` field —
  stores as `entry[4]` (comma-separated set names), which `resolveModelRouteFromEntry` already
  reads at index 4
- Extended `serializeModelEntry` to emit `transforms` field on round-trip (used by
  `dumpProxyConfigToml`)

**`after_upstream` hook fully wired (Step 9):**
- Added `applyAfterUpstream(response, ctx)` to `request-transform.ts` — buffers the upstream
  response body, applies `after_upstream` ops, and returns a new `Response`. Non-JSON bodies
  (e.g. SSE streams) are passed through unchanged. Fast-path exits immediately when no
  `after_upstream` transforms are active.
- Wired in all handler fetch sites (12 total):
  - `openai.ts`: `forwardCompletionsAsOpenAIResponses` + main `handleOpenAIRequest` fetch
  - `claude.ts`: `handleClaudeRequest` main fetch
  - `messages.ts`: all four fetch sites (openai-passthrough → openai-responses,
    openai-passthrough → openai-completions, claude-upstream → openai-responses,
    claude-upstream → openai-completions)
  - `responses.ts`: `handleAsCompletions`, `handleAsPassthrough`,
    `handleResponsesInputTokensRequest` (both paths), `handleResponsesCompactRequest` (both paths)
  - `chat-completions.ts`: anthropic-messages path, openai-responses path, direct passthrough
  - `gemini.ts`: `handleGeminiInteractionsRequest`, `handleGeminiGenerateContentRequest`
- Removed `fillMissingToolMessageNames` unconditional call from `handleOpenAIRequest` — this
  function duplicated the `recover_tool_message_name` built-in now applied selectively via
  `deepseek_compat`. Other routes no longer get the transform applied unnecessarily.

**Tests**: 136 unit tests, all passing (+6 new `applyAfterUpstream` tests in
`tests/unit/request-transform.test.ts`: fast-path identity, empty-transforms fast-path,
active remove op, active rename op, status preservation, non-JSON SSE passthrough)

### Fix: TUI model test — inline-table config resolution, fallback mode, and DeepSeek thinking rejection

Three fixes to the TUI's "test model" feature in `src/tui.ts` that improve coverage
and unblock the test for compat-mode `anthropic-messages` upstreams like DeepSeek.

**Root causes and fixes:**

1. **`deepseek-v4-anth` and other inline-table model entries resolved to section-level defaults**
   The TUI's `resolveModelTestConfig` recognized the array-form
   (`"model" = ["target", "base_url", "api_key", "mode"]`) and the bare section-default
   fallback, but silently fell through to section-level `upstream_mode`/`base_url`/`api_key`
   for the inline-table form
   (`"model" = {target = "...", base_url = "...", api_key = "...", mode = "..."}`) used
   throughout `proxy_config.toml` for `deepseek-v4-anth`, `minimax-m2.7-high`,
   `minimax-m3-anth`, `gemma-4-*`, and similar entries. The model test for `deepseek-v4-anth`
   therefore POSTed to `http://192.168.68.179:3000` (the `[models.free]` default) with
   `openai-completions` mode and no DeepSeek key, instead of the configured
   `https://api.deepseek.com/anthropic` with `anthropic-messages`.
   **Fix:** added an inline-table branch in `resolveModelTestConfig` that reads
   `target`/`base_url`/`api_key`/`mode` per entry with `typeof` guards, then falls back
   to section/global defaults. `deepseek-v4-anth` now resolves to
   `upstreamMode="anthropic-messages"`, `targetUrl="https://api.deepseek.com/anthropic"`,
   `apiKey="sk-..."`, `directModel="deepseek-v4-flash"`.
   *Note: empty-string per-field values (e.g. `api_key = ""` in `codelite` and
   `codesmall`) are intentionally preserved as "not set" — the per-field `||` chain
   falls through to the section/global default rather than rejecting the entry, so
   the TUI test for these models still resolves to a working key.*

2. **Unresolvable upstream mode silently fell back to `openai-completions`**
   When the TUI could not resolve any model config (no entry, no section default, no
   proxy default) it built an OpenAI completions body and sent it to the local proxy's
   `/v1/messages` endpoint. The proxy's `/v1/messages` natively speaks Claude, and the
   default OpenAI shape doesn't match that endpoint without a routing decision.
   **Fix:** the fallback upstream mode in `executeModelTest` is now `'anthropic-messages'`,
   which is the proxy's primary `/v1/messages` protocol. The TUI now always POSTs a
   valid body shape to `/v1/messages`, regardless of whether the model is resolvable.

3. **Anthropic-format `thinking: {type: "adaptive"}` rejected by DeepSeek compat shim**
   `buildTestToolRequest` previously added `thinking: {type: "adaptive"}` to every
   `anthropic-messages` test body "to exercise the same thinking path real Anthropic
   traffic uses." Real Claude accepts the omission, but DeepSeek's `/anthropic`
   compatibility endpoint rejects the combination of `thinking` + forced
   `tool_choice: {type: "tool", name: "test_tool"}` with
   *"Thinking mode does not support this tool_choice"* (400). The DeepSeek
   `thinking_mode` doc (see `docs/deepseek_thinking.md`) describes the OpenAI-format
   toggle as `{"thinking": {"type": "enabled/disabled"}}` and never documents the
   Anthropic-format `{"type": "adaptive"}` shape.
   **Fix:** removed the `thinking` block from `buildTestToolRequest`. The TUI test is a
   liveness probe for the model route, not a feature exercise; if a dedicated
   thinking-path test is needed later it should be a separate test mode.

### Fix: `/v1/chat/completions` DEV_PASS_THROUGH — tool schema types, `content: null`, and multi-turn tool calls

Four interrelated fixes to the `handleChatCompletionsPassthrough` path used by
`DEV_PASS_THROUGH=true` clients (e.g. Antigravity `LocalOpenAIAgentConfig`, LangGraph).
All changes affect `anthropic-messages` and `openai-completions` upstream routes.

**Root causes and fixes:**

1. **Uppercase JSON Schema type strings rejected by DeepSeek (`"STRING"` instead of `"string"`)**
   The Antigravity SDK (`google-antigravity`) introspects Python type annotations and emits
   JSON Schema `type` fields in all-caps (`"STRING"`, `"INTEGER"`, `"BOOLEAN"`, etc.).
   DeepSeek and other strict upstreams reject these as invalid per the OpenAI spec.
   **Fix:** `handleChatCompletionsPassthrough` in `src/handlers/chat-completions.ts` now
   recursively lowercases all `type` strings in every tool's `function.parameters` schema
   before forwarding, via a new `normalizeSchemaCasing()` helper.

2. **`messages[N].content is required` (400 from proxy validator) on multi-turn tool calls**
   The OpenAI spec permits `content: null` on assistant messages that contain `tool_calls`
   (the model produced only function calls, no text). Two issues stacked:
   - The proxy's own `validateChatCompletionsRequest` in `src/utils/validation.ts` was
     throwing `content is required` when `content === null`, treating `null` and `undefined`
     the same. Fixed: only `undefined` is now rejected; `null` is accepted for assistant
     messages. `content` must be a string, array, or `null`.
   - LangGraph sends multi-turn history where assistant messages with `tool_calls` have
     `content: ""` (empty string). DeepSeek's Anthropic-compatible endpoint rejects
     `content: ""` when `tool_calls` is present. **Fix:** `handleChatCompletionsPassthrough`
     now normalizes inbound assistant messages: if `tool_calls` is present and
     `content === ""`, it is rewritten to `null` before forwarding.

3. **`anthropic-messages` path sent model alias instead of resolved target name**
   In the `anthropic-messages` conversion branch, `modelId` (the original alias, e.g.
   `deepseek-v4-anth`) was taking priority over `parsedBody.model` (the already-rewritten
   target, e.g. `deepseek-v4-flash`). Claude rejected the alias name.
   **Fix:** priority is now `parsedBody.model || modelId || 'unknown'` — the rewritten
   body model always wins when present.

4. **Multiple consecutive tool messages rejected by Claude (`anthropic-messages` path)**
   When an assistant turn issued N tool calls, the OpenAI → Claude converter
   (`completionsToClaudeBody` in `src/handlers/openai.ts`) produced N separate
   `{role: "user", content: [{type: "tool_result"}]}` messages. Claude requires all
   tool results for a single turn to be bundled in one `user` message.
   **Fix:** `completionsToClaudeBody` now uses a loop that collects all consecutive
   `role: "tool"` messages into a single `{role: "user", content: [...tool_results]}`
   message before continuing. This was already partially noted in the prior "Gemini-endpoint"
   changelog entry but the `completionsToClaudeBody` path was re-fixed here for the
   completions passthrough specifically.

**Additional change — `claudeJsonToSyntheticCompletions` returns `null` content for tool-only responses**

`claudeJsonToSyntheticCompletions` in `src/handlers/openai.ts` (the non-streaming
Claude → OpenAI completions converter) was returning `content: ""` on assistant messages
where the upstream responded with only `tool_use` blocks and no text. This caused the
next LangGraph turn to send `content: ""` back, triggering fix #2 above.
**Fix:** when `tool_use` blocks are present and the text content is empty, `content` is
returned as `null` to match the OpenAI spec.

**Files changed:** `src/handlers/chat-completions.ts`, `src/handlers/openai.ts`,
`src/utils/validation.ts`.

### Fix: Gemini-endpoint → `openai-completions` streaming with DeepSeek reasoning models

Resolved a cascade of five interrelated bugs that prevented Gemini-endpoint clients
(e.g. Antigravity `GeminiAPIEndpoint`) from completing multi-turn agentic tasks through
an `openai-completions` upstream such as `deepseek-v4-flash` on DeepSeek.

**Root causes and fixes:**

1. **Fragmented streaming tool calls emitted as broken `functionCall` parts**
   DeepSeek fragments a single tool call across multiple SSE chunks: the first chunk
   carries `index`, `id`, `name`, and a partial-args string; continuation chunks carry
   only more argument text at the same index. The stateless `convertOpenAIToGeminiGenerateContent`
   converter was called for every chunk, producing name-less `call_undefined_N` parts.
   **Fix:** `processSSEBuffer` now accumulates tool-call deltas in a `geminiToolCallBuffer`
   (keyed by `index`) and flushes one complete `functionCall` per tool call when
   `finish_reason` arrives (`src/handlers/openai.ts`).

2. **`reasoning_content` not passed back on next turn**
   DeepSeek reasoning models emit thinking in a dedicated `delta.reasoning_content` field
   (not inline `<think>` tags). The converter ignored it, so the subsequent request omitted
   `reasoning_content` from the assistant turn and DeepSeek rejected it with:
   `The reasoning_content in the thinking mode must be passed back to the API.`
   **Fix:** `convertOpenAIToGeminiGenerateContent` now extracts `reasoning_content` and
   emits it as a `{thought: true, text}` Gemini part (`src/converters/openai-to-gemini.ts`).
   On the inbound side, `convertGeminiGenerateContentToOpenAI` maps `thought:true` Gemini
   parts to the standard `reasoning_content` field on the assistant message (not a private
   `_thinking` field), so it round-trips correctly through subsequent requests.
   `completionsToClaudeBody` reads the same `reasoning_content` field and converts it to
   a `{type: "thinking"}` Claude content block for `anthropic-messages` upstreams.

3. **Tool messages missing `name` field**
   Several converters (`convertClaudeToOpenAIRequest`, `convertGeminiGenerateContentToOpenAI`,
   Antigravity `LocalOpenAIAgentConfig` passthrough) emitted `role:"tool"` messages without
   the `name` field. DeepSeek's OpenAI endpoint requires it.
   **Fix (A):** `convertGeminiGenerateContentToOpenAI` now tracks each assistant turn's
   `tool_calls` in `lastToolCalls` and uses that to set `name` and match `tool_call_id`
   by position when converting the following `functionResponse` turn.
   **Fix (B):** `fillMissingToolMessageNames` post-processes the converted OpenAI request
   in `handleOpenAIRequest`, recovering `name` from `tool_calls` by `tool_call_id` for
   any converter that missed it (`src/handlers/openai.ts`).
   **Fix (C):** `handleChatCompletionsPassthrough` applies the same recovery for clients
   that hit `/v1/chat/completions` directly (`src/handlers/chat-completions.ts`).

4. **Tool-call IDs mismatched between assistant and tool turns**
   The previous ID scheme `call_${name}_${i}` generated IDs independently in each turn,
   which diverged when multiple calls shared the same function name.
   **Fix:** IDs are now generated once in the assistant turn and recovered by position for
   the corresponding tool-result turn via `lastToolCalls`.

5. **Multiple tool results sent as separate `user` messages (anthropic-messages path)**
   When an assistant turn issued N tool calls, the converter produced N separate
   `{role:"user", content:[{type:"tool_result"}]}` messages. Claude requires all results
   bundled in a single `user` message immediately after the assistant turn.
   **Fix:** `completionsToClaudeBody` now uses a loop that collects consecutive `tool`-role
   messages into one `{role:"user", content:[...tool_results]}` message.

**Files changed:** `src/converters/openai-to-gemini.ts`, `src/handlers/openai.ts`,
`src/handlers/chat-completions.ts`.

### Fix: `DEV_PASS_THROUGH` `/v1/chat/completions` returns raw Claude response to OpenAI clients
Notice:
`handleChatCompletionsPassthrough` was forwarding the Claude Messages upstream response directly
to the client without conversion. Clients expecting OpenAI completions format (e.g. Antigravity
`LocalOpenAIAgentConfig`) received a Claude response object with no `choices` field, triggering:

```
model output error: model output must contain either output text or tool calls
```

The `anthropic-messages` branch in `chat-completions.ts` now converts:
- **Non-streaming**: Claude JSON → `claudeJsonToSyntheticCompletions` → OpenAI `chat.completion`
- **Streaming**: Claude SSE events (`content_block_delta`, `content_block_start`,
  `message_delta`, `message_stop`) → OpenAI `chat.completion.chunk` SSE, including tool call
  streaming (`input_json_delta` → `function.arguments` delta).

`claudeJsonToSyntheticCompletions` is extracted as an exported helper in `src/handlers/openai.ts`
(replacing the previously inlined duplicate in `forwardCompletionsAsAnthropicMessages`).

**Files changed:** `src/handlers/chat-completions.ts`, `src/handlers/openai.ts`.

### Fix: `DEV_PASS_THROUGH` `/v1/chat/completions` fails for `anthropic-messages` routes

When `DEV_PASS_THROUGH=true` and `LocalOpenAIAgentConfig` (e.g. Antigravity) hits
`/v1/chat/completions` with a model whose route uses `anthropic-messages` (e.g. `minimax-m3`),
the proxy had two bugs:

1. **Wrong upstream URL** — `src/index.ts` was appending `v1/chat/completions` to the route's
   `base_url` regardless of `upstream_mode`. For `anthropic-messages` routes this produced a URL
   like `https://api.minimaxi.com/anthropic/v1/chat/completions` which returns 404. Fixed: the
   upstream path is now selected as `v1/messages` for `anthropic-messages`, `v1/responses` for
   `openai-responses`, and `v1/chat/completions` otherwise.

2. **Wrong request body format** — `handleChatCompletionsPassthrough` only handled
   `openai-responses` body conversion; for `anthropic-messages` it forwarded the raw OpenAI
   completions body. Fixed: the handler now converts completions → Claude Messages format
   (via the existing `completionsToClaudeBody`) and sets `anthropic-version` before forwarding.
   `completionsToClaudeBody` is now exported from `src/handlers/openai.ts`.

**Files changed:** `src/index.ts`, `src/handlers/chat-completions.ts`, `src/handlers/openai.ts`.

### Fix: `systemInstruction` dropped when routing Gemini `generateContent` to OpenAI upstream

When Antigravity SDK (or any client) sends a Gemini `generateContent` request with
`systemInstruction` to an `openai-completions` upstream route (e.g. `max-m3`), the system
prompt was silently dropped during conversion. The model received no system context and
hallucinated tool names not in the provided schema, causing errors like:

```
invalid tool call error (invalid_signature) SearchDirectory is required
```

`convertGeminiGenerateContentToOpenAI` in `src/handlers/openai.ts` now extracts
`systemInstruction.parts[*].text` (standard Gemini format) and prepends it as an OpenAI
`{ role: "system", content: "..." }` message before the conversation turns.

**Files changed:** `src/handlers/openai.ts`.

### `DEV_PASS_THROUGH` upstream-auth notice

The README and `docs/README_DETAILS.md` now explicitly flag that `DEV_PASS_THROUGH=true`
on `/v1/chat/completions` forwards the caller's `Authorization` / `x-api-key` /
`x-goog-api-key` to the upstream unchanged — the proxy does **not** perform a local
credential check, the upstream directly authenticates the request (valid key → 200,
invalid key → upstream 401). Previously this was implied by the "validation only (no
model routing)" startup warning but not stated in the docs. No code change; this is
a documentation-only notice. See the env-var table row in `README.md` and the
`DEV_PASS_THROUGH` section in `docs/README_DETAILS.md`.

### Node server decoded response header normalization

The Node server adapter now removes `content-encoding` and `content-length` from
responses before writing them to clients. This prevents clients from trying to
decompress plain text when Node `fetch()` has already decoded an upstream
compressed response while preserving the upstream compression headers.

**Files changed:** `src/server.ts`.

### Composite alias resolution for `DEV_PASS_THROUGH` `/v1/chat/completions`

When `DEV_PASS_THROUGH=true`, the `/v1/chat/completions` passthrough handler now resolves
composite aliases and `target`-mapped model ids before forwarding the request upstream.

- Composite aliases (e.g. `for-claw`) are resolved to their primary/weighted target model
  via the same `getModelRouteConfig` path used by `/v1/messages`.
- `target`-mapped entries (e.g. `minimax-m3` → `MiniMax-M3`, `MiniMaxAI/MiniMax-M3` → `MiniMax-M3`)
  are also resolved.
- The `model` field in the forwarded request body is rewritten to the resolved target model id.
  If no alias resolves, the original model name is forwarded unchanged.
- Previously, composite alias names were forwarded verbatim, causing upstreams to return
  `unknown model` errors (e.g. MiniMax error 2013).

**Files changed:** `src/index.ts`, `README.md`, `docs/README_DETAILS.md`.

### `<think>` tag extraction for `openai-completions` upstream

Upstreams with mode `openai-completions` that emit reasoning wrapped in `<think>...</think>` or
`<thinking>...</thinking>` XML tags now have that content split into each endpoint's
native reasoning field, mirroring the existing `<thinking>` behavior.

- `/v1/messages`: extracted into a Claude `thinking` content block.
- `/v1/responses`: extracted into a `reasoning` output item, with `reasoning_text`
  embedded inside the assistant message for round-trip fidelity (matches Codex's
  expected input shape for multi-turn DeepSeek responses).
- `/v1/interactions`: extracted into a `thought` output item alongside the cleaned
  text output.
- `/v1beta/models/<model>:generateContent`: extracted into a Gemini `thought`
  content part alongside the cleaned text part.
- Tag is stripped from the user-visible text content in all paths.
- Both streaming and non-streaming responses are covered; the streaming path
  stitches tags that straddle SSE chunk boundaries via a per-stream `thinkStreamBuffer`
  that is reset on `[DONE]` to avoid cross-request leakage.

`README.md` documents the new behavior next to the existing thinking/reasoning notes.

**Files changed:** `src/converters/openai-to-claude.ts`, `src/converters/streaming.ts`,
`src/converters/completions-to-responses.ts`, `src/converters/openai-to-gemini.ts`,
`src/handlers/responses.ts`, `src/handlers/openai.ts`, `tests/unit/think-tag-extraction.test.ts`,
`README.md`.

### Model usage HTTP recording and auth context headers

The proxy can now optionally POST per-request model usage records to an HTTP collector configured with `[model_usage] record_url`.

- Usage records include `request_id`, `endpoint`, raw `user_key`, `model`, and token counters (`input_tokens`, `cached_tokens`, `cache_written_tokens`, `output_tokens`, `total_tokens`).
- JSON and streaming responses reuse the existing token accounting path, so both non-streaming usage payloads and final streaming usage chunks are reported.
- If `auth_url` returns an `access_token` response header, that one-request token is forwarded to `record_url` as an `access_token` request header.
- Requests to `auth_url` now also include `request_id` and `endpoint` headers, plus the existing auth headers and optional `x-resource-for` when `auth_with_model = true`.
- `proxy_config.toml_example` and `README.md` document the new optional `[model_usage]` section.

**Files changed:** `src/index.ts`, `src/utils/model-usage-recorder.ts`, `src/utils/config-loader.ts`, `src/utils/dashboard-stats.ts`, `tests/unit/token-usage.test.ts`, `tests/unit/auth-with-model.test.ts`, `testcases/15_config_parse/config_parse.test.js`, `README.md`, `proxy_config.toml_example`.

### TUI statistics overlay and compact tool names

The proxy TUI now has a `D` hotkey that opens a scrollable statistics overlay,
matching the existing overlay style used by `P` Tool Blocklist. The panel shows
all rows from `Top Models`, `Tools Used`, and `Top Endpoints` instead of the
main view's first-five-row summaries.

- `Top Models` keeps the full token/accounting column set.
- `Tools Used` and `Top Endpoints` use their own shorter column sets, with
  separator lines between modules.
- Long tool names are compacted in both the statistics overlay and Tool
  Blocklist panel using a prefix/suffix form to preserve recognizable endings.

**Files changed:** `src/tui.ts`.

### Token usage propagation across streaming and cache-aware routes

Token accounting is now more complete across transformed streaming routes:

- OpenAI Chat Completions streaming requests now force `stream_options.include_usage = true` in both Claude-format conversion and OpenAI passthrough paths, so final upstream usage chunks can be propagated.
- Gemini streaming conversion now parses final `interaction.usage` / `usageMetadata` and emits Claude `message_delta.usage`, allowing `/v1/messages` and `/v1/responses` Gemini streaming routes to report final input/output/cache-read token counts.
- OpenAI Responses `usage.input_tokens_details.cached_tokens` is preserved through Claude and Responses conversion paths instead of being dropped or hardcoded to zero when available.
- Local token counting now includes tool results and other non-text blocks with best-effort serialization instead of silently skipping them.
- Unit tests cover streaming usage propagation, cache-token mapping, and local non-text token counting.

**Files changed:** `src/converters/gemini-streaming.ts`, `src/converters/openai-to-claude.ts`, `src/handlers/messages.ts`, `src/handlers/responses.ts`, `src/utils/token-counting.ts`, `tests/unit/token-usage.test.ts`, `README.md`.

### `[general]` section; `[upstream]` renamed to `[default_upstream]`; `auth_passthrough_with` and `auth_url`

Three related config-layer changes landed together.

**`[upstream]` → `[default_upstream]`**

The TOML section that holds global upstream defaults (`default_base_url`,
`default_api_key`, `upstream_mode`) is renamed from `[upstream]` to
`[default_upstream]` to make its scope clearer — it applies only to models
that fall through every `[models.*]` section. Existing configs must rename
the section header; all other keys inside it are unchanged.

**New `[general]` section**

A top-level `[general]` section collects settings that are not tied to a
specific upstream:

- `global_token_limit` and `budget_to_effort_low/medium/high` (previously
  in `[upstream]`) have moved here.
- `auth_url` (optional): if set, the proxy validates every inbound auth
  header by forwarding it (plus `User-Agent`) to this URL via `GET`. HTTP
  200 (or a 301/302 chain that resolves to 200) = success; any 4xx/5xx
  = 401 to the client; network error = 503.
- `auth_passthrough_with` (optional, default `"user_key"`): controls which
  credentials the proxy sends to the upstream provider.

**`auth_passthrough_with`**

| Value | Behaviour |
|:------|:----------|
| `"user_key"` *(default)* | Caller's auth header is forwarded upstream for all sections except `[models.free]`, which always uses its configured key. Unchanged from prior behaviour. |
| `"config_key"` | Configured `api_key` wins for every section — per-entry → section → `[default_upstream] default_api_key`. Callers can still send a key (needed for the `auth_url` validation step) but it is not forwarded upstream. |

`config_key` is intended for shared-gateway deployments where callers must
not supply their own upstream credentials.

**Files changed:** `proxy_config.toml`, `proxy_config.toml_example`,
`src/utils/config-loader.ts` (interface + TOML parser + Consul loader +
serializer), `src/index.ts` (five auth-header sites), `src/server.ts`,
`src/tui.ts`, `src/handlers/dashboard.ts`, `README.md`.

### Privacy filter: local hash-only mode (no sidecar)

The proxy now ports the entropy-based hash/API-key scanner from
[`submodules/privacy-filter/hash_detect.py`](./submodules/privacy-filter/hash_detect.py)
into the TypeScript runtime as `src/utils/hash-detect.ts`. When
`[privacy_filter] filter_mode = "local"` is set in `proxy_config.toml`, the
proxy redacts hash-shaped tokens (API keys, tokens) in-process with no
HTTP call and no Python sidecar. Detected spans are replaced with the
same `⟦HASH:n⟧` sentinels the sidecar emits and are restored on the
response exactly as in sidecar mode — the on-the-wire shape is
identical, so the existing `restoreText` / streaming transform code is
shared.

- **Config source**: a new `[privacy_filter]` toml section. Env vars
  (`PRIVACY_FILTER_URL`, `PRIVACY_FILTER_TIMEOUT_MS`, etc.) override toml,
  matching the rest of the proxy's plugin knobs. The plugin is enabled
  when `filter_mode = "local"` (no URL required), or when
  `filter_mode = "sidecar"` is paired with a valid `filter_url`;
  otherwise it stays inert. There is no separate `enabled` flag — the
  combination of `filter_mode` and `filter_url` is what turns the
  filter on.
- **Detection semantics**: identical to the Python reference — Shannon
  entropy ≥ `entropy_threshold` (default `3.0`), 8+ contiguous hex chars
  with non-hex boundaries, length multiple of 8 ⇒ `HIGH` (16–256 chars),
  otherwise `LOW`. A built-in whitelist (`deadbeef`, `cafebabe`, etc.)
  is always applied and can be extended with `whitelist_add` /
  `whitelist_remove`. The minimum token length is configurable via
  `hash_min_len` (default `8`); the Python `hash_detect.py` was updated
  to match (`<= 8` → `< 8`).
- **Sidecar mode is unchanged**; setting `[privacy_filter] filter_mode = "sidecar"`
  + `filter_url = "..."` activates the OPF Python sidecar via toml, in
  addition to the legacy `PRIVACY_FILTER_URL` env-var path.

**Files changed:** `src/utils/hash-detect.ts` (new), `src/utils/privacy-filter.ts`
(local mode + toml plumbing), `src/utils/config-loader.ts`
(`[privacy_filter]` section), `src/index.ts` (wire toml through
`getPrivacyFilterConfig`), `proxy_config.toml` and `proxy_config.toml_example`
(documented example), `testcases/16_security/privacy_filter.test.js`
(TC2115–TC2122), `dist/`.

### Privacy filter now restores both `PII` and `HASH` sentinels

The privacy-filter sidecar ([`submodules/privacy-filter/serve.py`](./submodules/privacy-filter/serve.py)) emits two sentinel prefixes: `⟦PII:n⟧` (model-detected PII) and `⟦HASH:n⟧` (cryptographic-hash-shaped secrets such as API keys and tokens, caught by the entropy-based `hash_detect.py` scan). Previously the proxy's `SENTINEL_REGEX` only matched `PII:`, so `HASH:` sentinels would leak through as literal text in streaming responses. The regex now matches `(?:PII|HASH):`, and the info log line no longer claims HASH spans are PII. On overlap the sidecar's priority order (`HASH_HIGH > HASH_LOW > MODEL`) still applies — the proxy is just restoration, not detection.

**Files changed:** `src/utils/privacy-filter.ts`, `src/index.ts`, `testcases/16_security/privacy_filter.test.js` (TC2113, TC2114), `dist/`.

### Smaller production Docker image

- After the TypeScript build, `Dockerfile` runs `npm prune --omit=dev` so the runtime image no longer carries `wrangler`, `@anthropic-ai/claude-code`, `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@google/genai`, etc. They have also been moved to `devDependencies` in `package.json`.

**Files changed:** `Dockerfile`, `package.json`.

### `DEV_PASS_THROUGH` now honors per-model routes and OpenAI Responses upstreams

- `/v1/chat/completions` with `DEV_PASS_THROUGH=true` now resolves the request `model` through the normal model config before forwarding, so per-model `base_url`, `api_key`, and `mode` entries (including `[models.free]`) are used instead of always falling back to `[models.default]`.
- If the resolved route uses `upstream_mode = "openai-responses"`, the Chat Completions body is converted to Responses format and sent to `/v1/responses`; `openai-completions` routes still forward the original body as-is.
- Azure OpenAI Responses routes keep using the configured model key; the handler normalizes OpenAI-style auth to Azure's `api-key` header for Azure URLs.

**Files changed:** `src/index.ts`, `src/handlers/chat-completions.ts`, `src/handlers/openai.ts`, `testcases/16_security/dev_pass_through_responses.test.js`, `README.md`, `testcases/README.md`.

### Gemini endpoint routing can target Anthropic Messages and OpenAI Responses

- `/v1/interactions` can now route to `upstream_mode = "anthropic-messages"` and `"openai-responses"` through the existing OpenAI Chat Completions intermediate conversion. The upstream response is converted back to the Interactions shape.
- `/v1beta/models/{model}:generateContent` and `:streamGenerateContent` (plus `/v1/models/...`) can now route to `anthropic-messages` and `openai-responses` through the same double-conversion path, then convert responses back to Gemini `candidates[].content.parts`.
- Cross-mode streaming text deltas are converted back to Gemini-shaped SSE instead of passing through raw Claude or Responses SSE.
- Tool calls are preserved: Claude `tool_use` blocks and OpenAI Responses `function_call` items become Chat Completions `tool_calls`, then Gemini `functionCall` parts or Interactions `function_call` outputs.
- When routing Interactions/generateContent to OpenAI Responses, `system`/`developer` messages are forwarded as Responses `instructions`, and OpenAI content-part arrays are normalized to text for Responses `input_text` fields.

**Files changed:** `src/index.ts`, `src/handlers/openai.ts`, `src/converters/openai-to-gemini.ts`, `testcases/16_security/openai_responses_routing.test.js`, `README.md`.

### `base_url` may now point to a full upstream endpoint path

The proxy no longer blindly appends the endpoint suffix to a configured `base_url`. If `base_url` already contains a known full endpoint path, it is used as-is. This lets providers configure `base_url` to the exact upstream URL they need, without getting a doubled path such as `.../v1/messages/v1/messages`.

Recognised full-endpoint markers (case-insensitive):

- `/v1/messages`, `/anthropic/messages` (anthropic-messages)
- `/v1/chat/completions`, `/v1/interactions` (openai-completions / interactions)
- `/v1/responses`, `/openai/responses` (openai-responses, including Azure)
- `/v1beta/models/{model}:generateContent`, `/v1/models/{model}:generateContent`, `:streamGenerateContent`, `:countTokens`

Gemini `base_url` can also stop at the API version or models collection, such as `https://generativelanguage.googleapis.com/v1beta` or `https://generativelanguage.googleapis.com/v1beta/models`; the proxy appends `{model}:generateContent` without duplicating `/v1beta` or `/models`.

For example, a model configured with `base_url = "https://api.anthropic.com/v1/messages"` and `upstream_mode = "anthropic-messages"` will forward `/v1/messages` requests to that exact URL, rather than `https://api.anthropic.com/v1/messages/v1/messages`.

**Files changed:** `src/utils/routing.ts` (new `buildUpstreamUrl` helper), `src/index.ts` (use helper in fixed, composite, and fusion routing).

### Thinking budget clamping: `budget_tokens` is capped to `max_tokens` (with interleaved-thinking exception)
When request to `kimi-2.7-code`, exception shows rised: 'InvalidParameter: max_completion_tokens [32000] must be greater than thinking_budget [32768]'. This is not a fix for the problem, they are just completions to follow api docs:
- **`POST /v1/messages` and `POST /v1/messages/count_tokens`**: when `thinking` is enabled and
  `thinking.budget_tokens` exceeds `max_tokens`, the request validator reduces
  `budget_tokens` down to `max_tokens` before forwarding, keeping the budget within the
  per-response output window required by the Claude API spec.
- **Interleaved-thinking exception**: if the request carries the
  `anthropic-beta: interleaved-thinking-2025-05-14` header, `budget_tokens` is left
  unchanged even when it exceeds `max_tokens` (per `docs/claude-extended-thinking.md`),
  since interleaved thinking is permitted to consume the full context window for
  reasoning tokens.
- **Below-minimum `max_tokens`**: if `max_tokens < 1024` while thinking is enabled with a
  non-null budget, validation throws with a clear message instead of clamping to an
  invalid value.

**Files changed:** `src/utils/validation.ts` (new `clampThinkingBudget`; updated
`validateClaudeMessagesRequest` / `validateClaudeTokenCountingRequest` signatures),
`src/handlers/messages.ts`, `src/handlers/token-counting.ts`.

### Composite alias safety: routing cycle detection, name-conflict stripping, self-reference rejection

#### Routing cycle detection
- **Load time**: `validateProxyConfig` now resolves every composite alias through the full routing chain and catches cycles (e.g. `for-claw6 → for-claw7 → for-claw8 → for-claw6`). Each unique cycle is pushed as a fatal validation error, logged as `[FATAL]`, and surfaced in the TUI status bar and dashboard status bar via `_validationErrors`.
- **Request time**: `getModelRouteConfig`, `getOrderedCompositeTargets`, `resolveCompositeModelRoute`, `getCompositeRouteCandidates`, and `resolveFusionPlan` all accept a `visited: Set<string>` parameter. If a cycle is detected mid-resolution, a `Routing cycle detected: A → B → … → A` error is thrown immediately rather than looping forever.
- **Dashboard snapshot**: `getDashboardSnapshot` now passes `new Set([alias])` when resolving each composite target's route and uses `flatMap` + try/catch so a cyclic target is silently omitted from the snapshot instead of crashing the entire snapshot call (which previously caused TUI to hang at `Loading…`).

#### Nested composite routing (composite → composite)
- Composite targets that are themselves composite (or schedule/fusion) aliases are now resolved through the full routing chain (`getModelRouteConfig`) rather than only `resolveModelRouteFromConfig` (which only looked at `[models.*]`). This makes `alias-a → alias-b → real-model` work correctly end-to-end.

#### Name-conflict stripping
- `findAliasNameConflicts` / `stripConflictingAliases`: composite and schedule aliases whose name collides with a `[models.*]` entry are stripped from the in-memory config at load time. `[FATAL]` is logged per stripped alias; `_validationErrors` carries the error so it appears in TUI / dashboard.
- `addCompositeAlias` / `addScheduleAlias` throw if the new alias name matches an existing model name, preventing the conflict from being written to disk.

#### Self-reference rejection
- `findSelfReferencingCompositeTargets` / `stripSelfReferencingCompositeTargets`: composite targets that list their own alias name as a target are stripped from the in-memory config at load time with `[FATAL]` logging.
- `upsertCompositeTarget` and `validateAndNormalizeComposite` (dashboard PUT path) both throw immediately if a target name equals the alias name, preventing self-references from reaching disk.
- All four TUI call sites for `upsertCompositeTargetFromDashboard` (add/edit × share/fusion) are wrapped in try/catch; errors are shown on the TUI message line without saving.

**Files changed:** `src/utils/config-loader.ts`, `src/handlers/dashboard.ts`, `src/tui.ts`.

### Test runner: `TEST_CONFIG` default is now force-set on `process.env`

- **Fixed silent isolation bypass**: `run-tests.js` and `testcases/utils/test_helpers.js`
  each computed a local `TEST_CONFIG` constant as `process.env.TEST_CONFIG || 'test_'`,
  but never wrote that default back to `process.env.TEST_CONFIG`. Any code path
  that read `process.env.TEST_CONFIG` directly (e.g. the proxy process itself,
  when started independently of `run-tests.js`) would see it unset and fall back
  to `./proxy_config.toml` instead of the isolated `./test_proxy_config.toml`,
  letting config-mutating test suites (composite/fusion/schedule PUTs, tool
  blocklist, global token limit) write into the real config file.
- Both files now do `if (!process.env.TEST_CONFIG) process.env.TEST_CONFIG = 'test_';`
  before reading it, so `TEST_CONFIG` is always defined for every child process
  and for `src/server.ts`'s own `PROXY_CONFIG_PATH` resolution, regardless of
  whether it arrived empty, unset, or already set by the caller.

**Files changed:** `run-tests.js`, `testcases/utils/test_helpers.js`.

### Schedule window editor: friendly `days` input (weekdays/weekend/everyday) in TUI and dashboard

- **Simplified `days` semantics**: schedule windows now accept `"weekday"`/`"weekdays"`
  and `"weekend"`/`"weekends"` in any casing; any other string value normalizes
  to "every day" instead of throwing a validation error. Explicit day-name
  arrays (e.g. `["mon","tue"]`) are still honored for hand-edited TOML. Added
  a shared `normalizeScheduleDays()` helper in `src/utils/config-loader.ts`
  used by the TOML parser, the dashboard JSON-payload validator
  (`validateAndNormalizeScheduleWindow`), and `upsertScheduleWindow` (the
  function both the TUI and the dashboard HTTP route call), so all three
  input paths agree.
- **TUI**: replaced the single JSON-array text prompt for editing a schedule
  target's windows with a step wizard — `from` (number prompt) → `to` (number
  prompt) → **days** (a 3-way picker: Every day / Weekdays / Weekend), with an
  "add another window" loop, or "Set as fallback" to clear the window list in
  one step. Also fixed the alias panel's per-target summary line, which
  previously silently dropped `days: "weekday"`/`"weekend"` (it only rendered
  array-style day lists).
- **Dashboard**: the schedule window's `days` free-text input (which could
  only ever produce a custom day array, never the special weekday/weekend
  values) is now a `<select>` dropdown with the same three options, matching
  the TUI.

**Files changed:** `src/utils/config-loader.ts` (`normalizeScheduleDays`,
`parseScheduleWindow`, `validateAndNormalizeScheduleWindow`,
`upsertScheduleWindow`), `src/tui.ts` (`openEditScheduleWindowsPrompt`,
`ScheduleAliasesOverlay.render`), `src/handlers/dashboard.ts`
(`scheduleAliasRows`, `collectConfigPayload`).

### Schedule Aliases panel: target-add UX fixes, target scope, and test-isolation path bug

- **Enter no longer dismisses the "Add target" list** — selecting a target in the
  "Adding target to *alias*" picker now returns to the Schedule Aliases panel
  (matching Esc/cancel behavior), instead of leaving no overlay open.
- **Key rebind**: adding a schedule target is now `M` (was `T`), for consistency
  with the Composite Aliases panel's `M add target` binding.
- **Target picker no longer offers invalid candidates**: wildcard routing patterns
  (`*`, `claude-*`, etc.) and the schedule alias itself (self-reference) are
  excluded from the "Adding target to *alias*" list.
- **Schedule targets can now be composite/fusion aliases**, not just concrete
  custom models — the picker already sourced candidates from
  `getConfiguredModelIds()` (which includes composite alias names), so this
  was a filtering/doc fix rather than a resolver change.
- **Fixed test-config isolation path bug**: `src/server.ts` computed the
  `TEST_CONFIG`-isolated config path as `` ./${TEST_CONFIG}_proxy_config.toml ``
  (extra underscore), while `run-tests.js` copies the developer config to
  `` ./${TEST_CONFIG}proxy_config.toml `` (no extra underscore). Because the two
  paths didn't match, a running test suite's `PUT /dashboard/api/config` calls
  could end up mutating a config path outside the isolation the test runner set
  up. Removed the extra underscore so the server reads/writes the exact path
  `run-tests.js` isolates.

**Files changed:** `src/tui.ts` (`ScheduleAliasesOverlay`, `openAddScheduleTargetPrompt`), `src/server.ts`.

### Config validation warnings + relaxed `api_key` requirement

`validateProxyConfig` now distinguishes **warnings** from **errors**. Situations that were previously
hard errors but are valid in practice (e.g. missing `api_key` when the caller supplies their own
auth header) are now surfaced as warnings and no longer block the config from loading.

- `ValidationResult` gains a `warnings: ConfigValidationError[]` field (same shape as `errors`).
- Dashboard GET `/dashboard/api/config` response includes `config_warnings` alongside `config_errors`.
- Dashboard UI and TUI both display warnings in amber/yellow when there are no hard errors.
- `api_key` absence is no longer an error for any section — the proxy forwards the caller's auth header.
  Only `base_url` absence (when required) remains a hard error.

**Files changed:** `src/utils/config-loader.ts`, `src/handlers/dashboard.ts`, `src/tui.ts`.

### Per-model `mode` override in `models.*` entries

Each model entry in a `[models.<section>]` block can now declare an explicit
`mode` to override the section's `upstream_mode`. This allows a single
category (e.g. `[models.free]`) to route different models to different
API formats without needing separate sections.

**Config syntax** (both forms supported):

```toml
[models.free]
upstream_mode = "openai-completions"   # section default
sonnet46 = {target = "claude-sonnet-4-6", base_url = "http://localhost:3000", api_key = "", mode = "anthropic-messages"}
opus46   = ["claude-opus-4-6", "http://localhost:3000", "", "anthropic-messages"]
```

**Mode resolution chain**: `model entry mode` → `section upstream_mode` →
`[upstream] upstream_mode` → `"openai-completions"`.

**Files changed:**
- `src/utils/config-loader.ts` — `resolveModelRouteFromEntry` extracts
  `modelMode` from entry[3] and cascades it; inline-table and array
  parsers handle `mode`; validation accepts 4-element arrays;
  `sanitizeDashboardCategoryConfig` preserves mode at index 2 of the
  3-element `[target, base_url, mode]` dashboard format;
  `applyDashboardConfigUpdate` reconstructs the 4-element internal form
  on PUT.
- `src/tui.ts` — `modelChoices()` and `resolveModelTestConfig()` now read
  mode from index 2 of the dashboard sanitized array (was incorrectly
  reading index 3), so the Test Custom Model panel shows the correct
  `anthropic-messages` / `completions` / `gemini` label per model.

### Bug fix: config `api_key` overrode caller key for `[models.default]` targets reached via composite / direct routing

The non-fusion composite dispatch in `src/index.ts` (the `compositeAttempts.map` block) was applying
the model's per-entry `api_key` from the config on top of the caller's auth headers unconditionally,
for every section. This contradicted the documented rule in `proxy_config.toml_example`:

> For the `[models.default]` tier, the auth key sent by the caller takes priority over ALL configured
> `api_key` values, including per-entry overrides. The `api_key` field is intentionally left unset by
> admins in practice — it only acts as a fallback when the caller did not supply an auth key.

Effect: a request for a model like `max-m3` (whose entry in `[models.default]` declares a
`sk-cp-p_i6lDK-...` key) would send the config key to the upstream, ignoring the caller's
`Authorization` / `x-api-key` header. The fusion path was already correct (gated on
`route.section === 'free'`), so the same target behaved differently depending on whether it was
reached via a fusion alias or via composite / direct routing.

Fix: align the inline composite-dispatch block with `buildRouteAttempt` — only override the caller's
auth with the config `api_key` when `route.section === 'free'`. All non-`free` sections
(`default`, `claude`, `gemini`, etc.) now pass the caller's key through unchanged. Affects
`src/index.ts` only (one block, ~10 lines).

### Bug fixes: `/v1/responses` reasoning round-trip (DeepSeek thinking mode + Codex multi-turn)

Four root causes behind the persistent `"reasoning_content must be passed back to the API"` error
when using the Responses API (`/v1/responses`) with DeepSeek thinking-mode upstreams and the Codex
CLI. All changes are in the responses handler and its two converter modules.

- **Streaming path silently dropped `delta.reasoning_content`** — `streamCompletionsAsResponses`
  in `src/handlers/responses.ts` was ignoring the `reasoning_content` / `thinking` delta fields
  that DeepSeek and OpenAI thinking-mode upstreams send per chunk. Added accumulation into
  `accumulatedReasoning` and emitted a `reasoning` output item (with the text) in the final
  `response.output_item.done` event for each text message. The `reasoning_text` is also appended
  inside the assistant message's content array so Codex can echo it back on the next turn.

- **Non-streaming path produced an empty `reasoning` output item** —
  `src/converters/completions-to-responses.ts` was emitting a `reasoning` item with no content
  when the upstream `message.reasoning_content` field was present. Fixed to actually extract the
  string and populate `content: [{ type: 'reasoning_text', text: reasoningText }]`. Also handles
  `part.type === 'thinking'` content parts from OpenAI-style array content.

- **Consecutive `function_call` input items produced separate assistant messages** —
  `src/converters/responses-to-completions.ts` was converting each `function_call` item into its
  own assistant message. Chat Completions (and DeepSeek) require all tool calls from a single
  assistant turn to be in *one* assistant message with multiple `tool_calls` entries. The new
  `convertInputItemsToMessages` exported function collects all consecutive `function_call` items
  and merges them into a single assistant message.

- **Server-side call_id → reasoning store for Codex multi-turn** — Codex builds conversation
  history from `response.output_item.done` events and echoes `function_call` items back as input
  on the next turn, but does **not** re-send `reasoning` items. Without a server-side store, the
  `reasoning_content` field would be absent from the echoed assistant message, causing DeepSeek to
  reject the request. Added a module-level `reasoningByCallId` map (10-minute TTL) in
  `src/handlers/responses.ts`: when a streaming response ends with both tool calls and accumulated
  reasoning, the reasoning is keyed by each `call_id`. On the next request, `handleAsCompletions`
  walks the converted messages and injects the stored `reasoning_content` onto any assistant message
  whose `tool_calls` match a stored entry.

### Bug fixes: OpenAI thinking passthrough + composite 413 path

Two single-case regressions caught by the full integration suite are now
fixed; the suite runs **18/18 suites, 165/165 cases** against the local
proxy (port 7799, `qnaigc` upstream). Recorded in
`tests/test_results_at_2026-06-22_20-14-47.md`.

- **TC413 — OpenAI-style thinking field (`{ enabled, budget_tokens }`)
  was rejected with HTTP 400** on `/v1/messages`. The request was dispatched
  to the Claude-format path (because `requestBody.thinking` is truthy) and
  then failed `validateClaudeMessagesRequest` with `thinking.type is
  required`. Added `normalizeOpenAIToClaudeThinking()` in
  `src/utils/thinking.ts` and applied it in `src/handlers/messages.ts`
  right after JSON parsing, so format detection, validation, and
  conversion all see the canonical Claude shape
  (`{ type: 'enabled'|'disabled', budget_tokens }`).
  Test now uses `budget_tokens: 2000` (validation floor is 1024) and
  `max_tokens: 3000` to fit.
- **TC1110 — Composite `token_limit` exhaustion returned 400 instead of
  413.** Two issues stacked:
  1. `OverLimitError` in `src/utils/errors.ts` was using 429 /
     `rate_limit_error`, the rate-limit shape. Token-limit exhaustion is a
     payload-size / quota concept, not RPM, so it now returns 413 /
     `over_limit_error` to match the documented `token_limit reached`
     contract and the canonical Anthropic-style error envelope.
  2. The catch block in `src/index.ts` around the model-routing body
     parse was swallowing *every* error (including typed
     `ClaudeProxyError` instances) and rewriting it as a 400 "Invalid
     request body". Added an `instanceof ClaudeProxyError` re-raise
     branch so the original status code and `type` field reach the
     client.

  Manual verification: two consecutive requests against a temporary
  `__test_ttl413__` alias with `token_limit: { num: 1, duration: '1h' }`
  now return `200` then
  `413 {"type":"over_limit_error","error":{"type":"over_limit_error","message":"Composite alias '__test_ttl413__' token limit (1 1h) reached (10). No further requests will be routed through this alias."}}`.

### Kompress (context compression) plugin

The proxy can now drop low-importance tokens out of outbound request text to cut
upstream token usage and cost. It mirrors the privacy-filter architecture: a thin
`fetch`-only client (`src/utils/kompress.ts`) talks to a persistent
[kompress](./submodules/kompress/README.md) HTTP sidecar (`POST /compress`), so it
stays Cloudflare-Workers-compatible and is **entirely inert unless `KOMPRESS_URL`
is set**.

Unlike the privacy filter, compression is **lossy and one-directional** — there is
no response-side restore (no sentinel map, no transform stream).

- **`src/utils/kompress.ts`** (new) — `getKompressConfig(env)` (returns `null` when
  `KOMPRESS_URL` unset; validates the sidecar is an internal host), `shouldCompressPath`,
  `isCjkHeavy` (English-only model guard), and `compressBody` (parallel per-fragment
  fan-out to the sidecar).
- **Scope:** compresses only **user-message text** and **tool definitions/results**
  (Anthropic `tools[].description` + `tool_result`, OpenAI `function.description` +
  `role:'tool'`). The system prompt, assistant messages, JSON schemas, images, and
  tool-call inputs are left untouched.
- **CJK guard:** the model is English-only and garbles non-Latin input, so fragments
  above a non-ASCII threshold (or containing CJK/Kana/Hangul) are passed through
  uncompressed.
- **Fail-open by default** (inverse of the privacy filter): a sidecar outage forwards
  the original uncompressed text rather than failing the request. Override with
  `KOMPRESS_FAIL_OPEN=false`.
- **Wiring** (`src/index.ts`): runs right after PII redaction and before tool-blocklist
  erasure, inside the same body-parse block, so single/composite/fusion paths all see
  the compressed body.
- **Env:** `KOMPRESS_URL`, `KOMPRESS_ENDPOINTS`, `KOMPRESS_FAIL_OPEN`,
  `KOMPRESS_TIMEOUT_MS`, `KOMPRESS_MAX_CHARS`, `KOMPRESS_KEEP_RATIO`, `KOMPRESS_MIN_CHARS`
  (declared in `src/types/shared.ts`, surfaced in `src/server.ts`).

### Dashboard Tool Blocklist (mirrors TUI `P` overlay)

The `/dashboard` web UI now ships the same tool blocklist the TUI exposes
behind the `P` key. The previous "Tools Used" aggregated view is replaced
by a per-`(tool, agent)` table with a Block/Unblock button per row.

- **`GET /dashboard/api/tools/blocklist`** (`src/handlers/dashboard.ts`) —
  returns `{ rows: AgentToolPanelEntry[], blockedTools: string[] }` from
  `getAgentToolPanelStats()` + `[...getBlockedTools()]`. Reuses the
  same data feed the TUI overlay consumes (per-tool × per-agent
  `in_requests` / `in_responses` / `in_request_chars`).
- **`POST /dashboard/api/tools/toggle-block`** — body
  `{ tool_name: string, blocked: boolean }`, calls `blockTool()` /
  `unblockTool()` from `src/utils/dashboard-stats.ts`, returns
  `{ ok, tool_name, blocked }`. Returns `400 { error }` when `tool_name`
  is missing or empty.
- **Routes registered** in `src/index.ts` next to the existing
  `/dashboard/api/stats/agents`, `/test-model`, `/global-token-limit`
  handlers.
- **Dashboard UI** (`section-agent` in `handleDashboardPage()`):
  - Heading renamed "Tools Used" → "Tool Blocklist" with a one-line
    caption pointing at the TUI `P` overlay.
  - Table now has 7 columns: status (`✗` / `·`) | Tool | Agent | in req
    | in resp | total len | Action.
  - Blocked rows get a red `✗` status cell, a light red background,
    and the action button toggles between `Block` (neutral) and
    `Unblock` (red).
  - Click handler delegated on `#toolStats` posts to the toggle-block
    endpoint and re-fetches `/tools/blocklist` to refresh the view.
  - 5-second auto-refresh already in place keeps the block state live
    with the rest of the dashboard.
- **Behavior parity with TUI**: blocked tools stop accumulating
  `in_requests` / `in_responses` / `in_request_chars` (existing
  pre-block counts are preserved). In-memory only — same as the TUI,
  resets at proxy restart.
- **Backward compatibility**: `GET /dashboard/api/stats/agents` and
  the `toolStats` field on the main `/dashboard/api/config` snapshot
  are unchanged. The aggregated per-tool view is still available via
  the API; only the dashboard UI now uses the per-`(tool, agent)` view.

### Model Statistic Collapse (default 10)

The Model Statistic table in `/dashboard` now collapses to the top 10
models by default and shows a `Show all (N)` / `Collapse` toggle next
to the existing Export CSV button — same pattern as the Tool Blocklist
section.

- **Default view** shows 10 rows; the toggle is hidden when fewer than
  10 models are present, otherwise it reads `Show all (N)` (collapsed)
  or `Collapse` (expanded).
- **`Export CSV` interaction**: the existing button reads rows from the
  DOM, so it exports only the currently visible rows. Click `Show all`
  first if a full export is needed. This matches the pre-existing CSV
  behavior (the button always reflected whatever was rendered).

### Request Hot-Path Performance: Single Body Parse + Incremental Token-Window Cache

Two optimizations on the per-request hot path, applied without changing any
behavioral contract.

- **Single request body parse** (`src/index.ts`) — tool/agent stats were
  previously extracted from a `request.clone().json()` call at the top of
  the request handler, *before* the routing block parsed the same body via
  `request.text()` + `JSON.parse()`. That meant every JSON request paid
  for two full body parses (and a full body clone allocation). The
  extraction now happens inside the routing block, reading from the body
  that was already parsed for model resolution. `recordAgentStat()` is
  also called from that same site, so routed requests still record tool
  stats exactly as before; non-routed paths (`/v1/models`, `/dashboard`,
  dynamic routes) had no tool stats to record in the first place.
- **Incremental cache for `getTokensInWindow`** (`src/utils/dashboard-stats.ts`)
  — `tokenHeatmapEvents` is append-only within the 30-day retention window
  and sorted by ascending timestamp, so events older than the current
  query cutoff are immutable. The function previously did an O(n) scan of
  the entire 30-day array on every call (each call: every active token-
  limit window checks its accumulator). It now caches the sum of all
  events older than the previous cutoff in `windowSumFrozen`, with
  `windowSumCutoff` marking the boundary, and only scans the live tail
  plus absorbs newly-eligible events into the frozen sum on each call.
  Pruning (30-day `shift()`) only removes events outside any query window,
  so the frozen sum is never invalidated. Cold start still pays a single
  O(n) pass to seed the cache; subsequent calls are O(tail length).

### Token Log Persistence Made Opt-In (TUI=1 / DUMP=1)

Token log persistence (the `model_proxy_tokens.jsonl` JSONL file holding
token stats, heatmap data, and composite limit windows) is now gated on
`TUI=true|1` or `DUMP=true|1`. Without one of those flags the proxy
performs no JSONL file I/O at all — no startup restore, no day-rollover
dump, no periodic 30-min dump, no `Ctrl+U` dump.

- **src/utils/dashboard-stats.ts** — added a module-level
  `persistenceEnabled` flag plus `setStatsPersistenceEnabled(enabled)` /
  `isStatsPersistenceEnabled()` exports. `dumpTodayTokens()`,
  `dumpDailyTokens()`, `advanceDaySlotIfNeeded()` (the day-rollover dump
  path), and `loadTokenStatsFromLog()` all early-return when the flag is
  false. The in-memory `recordTokenHeatmapEvent()` 30-day pruning is
  unchanged, so heatmap stats still age out after 30 days; they just
  don't outlive the process.
- **src/server.ts** — computes `persistenceEnabled = TUI || DUMP`,
  calls `setStatsPersistenceEnabled()` once, and wraps the
  `loadTokenStatsFromLog(retentionDays)` call (and its retention-window
  computation) in an `if (persistenceEnabled)` block. The retention
  window is still derived from the configured global / composite token
  limits and falls back to 30 days when no local TOML config is available.
- The live `/dashboard` and TUI views continue to work either way — they
  read from the in-memory state, which is always populated by the request
  hot path regardless of persistence.
- See [README § 3.2 Token Log Persistence](./README.md#32-token-log-persistence)
  for the full behavior.

### Tool Blocklist (TUI `P` key)

Added a Tool Blocklist overlay in the TUI that lists every observed
`(tool, agent)` pair with `req` / `resp` / `len` counters. Press `Enter` to
toggle the block state for the highlighted tool; blocked tools are marked
with a red `✗` and stop accumulating stats (existing pre-block counts are
preserved). Blocklist state is in-memory only and resets at proxy restart.
See the **Tool Blocklist (`P`)** section in README for full details.

### TUI keybinding change

The model test picker's "test all (30m)" / "stop test timer" toggle is now
`W`. The `P` key on the main view now opens the Tool Blocklist overlay.

### Security Hardening

A batch of defensive fixes applied after review of the proxy boundary. All
user-facing behavior changes.

- **SSRF protection on internal sidecar URLs** — `PROXY_CONFIG_URL` (Consul
  config source) and `PRIVACY_FILTER_URL` (PII-redaction sidecar) are now
  validated against a new `isInternalHost()` helper (`src/utils/routing.ts`).
  The URL must resolve to `localhost` / `127.x.x.x`, an RFC-1918 range
  (`10/8`, `172.16/12`, `192.168/16`), a link-local range (`169.254/16`,
  `fe80::/10`), an IPv6 ULA (`fc00::/7`), `*.local` (mDNS), or `::1`.
  Anything else (public DNS names, public IPs, exotic schemes) is rejected
  at startup with a descriptive error. This closes the path where a
  misconfigured or attacker-controlled `PROXY_CONFIG_URL` could be used to
  exfiltrate the proxy's outbound traffic.
- **No request body in client-facing error messages** — `handleTargetApiError`
  (`src/utils/errors.ts`) used to append a 300-char preview of the upstream
  request body to the `invalid_request_error` message returned to the client.
  That body can contain user prompts, tool arguments, or PII. The preview is
  now logged server-side only via `logger.debug('errors', ...)`; the client
  gets a generic message.
- **No internal error messages from SDK handlers** — `handleSdkOpenAIRequest`
  and `handleSdkAnthropicRequest` (`src/utils/sdk-handler.ts`) caught
  exceptions and returned `error.message` verbatim to the caller, which
  could leak stack frames, file paths, or upstream error bodies. They now
  return `"An internal error occurred"`; the original error continues to be
  logged.
- **Stricter `anthropic-beta` header handling** — `validateBetaFeatures()`
  (`src/utils/beta-features.ts`) silently forwarded any unknown beta feature
  name upstream. Unknown features are now dropped. Additionally,
  CRLF/control chars are stripped from the header value before forwarding,
  so a header value like `prompt-caching\r\nX-Injected: 1` cannot be used
  to inject extra response headers.
- **Tighter API-key logging** — the partial-key formatter in
  `transformAuthHeadersForUpstream` (`src/utils/routing.ts`) used
  `first16...last8` for `x-goog-api-key`, `x-api-key`, and `Authorization`.
  Reduced to `first4...` (or `***` if shorter than 4 chars). The previous
  window could expose enough entropy to brute-force the prefix.
- **Hardened host allowlist** — wildcard entries in `ALLOWED_HOSTS`
  (`*.example.com`) now require a literal `.` separator before the domain,
  so `*.example.com` no longer matches the apex `example.com`. The wildcard
  rule now correctly rejects suffixes that are not real subdomains.

### Misc bug fixes (bundled with the hardening pass)

- `crypto.randomUUID()` replaces `Math.random()` for `resp_*` and `msg_*`
  IDs in `completions-to-responses.ts` and `responses.ts`.
- `dashboard.ts` uses `??` (not `||`) for `PROXY_CONFIG_PATH`, so an
  explicitly empty string is preserved as a real path instead of falling
  through to `null`.

### Per-(tool, agent) stats and persistence changes

- `agentToolStats` and `blockedTools` fields are now part of the dashboard
  snapshot (`src/handlers/dashboard.ts`) — `agentToolStats` is built by the
  new `getAgentToolPanelStats()` in `src/utils/dashboard-stats.ts`, which
  joins the three source maps (`agentStats`, `toolRequestChars`,
  `upstreamResponseToolStats`) into a per-(tool, agent) row keyed by
  `${tool}\0${agent}`.
- `recordToolRequestChars()` and `recordUpstreamResponseToolNames()` now
  take an `agent` argument; `createResponseToolTrackingTransformStream()`
  now takes an `agent` argument and threads it into the `flush()` callback.
  The Claude request handler (`src/index.ts`) passes the user-agent prefix
  through both call sites.
- `dumpTodayTokens()` writes a new `toolStats` field (per-(tool, agent) rows
  with `name`, `agent`, `req`, `resp`, `len`, `blocked`) in the JSONL token
  log. `loadTokenStatsFromLog()` restores those rows back into the three
  source maps on startup (latest dump per date wins, and the `blocked` flag
  is applied via `blockTool()` so the blocklist survives a restart).
- The cumulative `modelStats` Map (powers TUI "Top Models" +
  `getModelTotalTokens()`) is now also restored from the latest dump per
  date, and is **accumulated** across the latest per-date dumps (each
  per-date dump is that day's totals, so summing reconstructs true
  all-time). Previously only the daily `modelStats` map was restored, and
  the cumulative map was not restored at all.
- `recordAgentStat()`, `recordToolRequestChars()`, and
  `recordUpstreamResponseToolNames()` short-circuit on `blockedTools` so
  blocked tools no longer grow their counters.
- **Blocked tools are erased from the request body before forwarding**: a
  new `eraseBlockedTools()` helper in `src/utils/tool-blocklist.ts` runs at
  the body-parsing chokepoint in `src/index.ts` (right after the privacy
  filter). It strips tool definitions matching the blocklist from the
  `tools` array, supports the Claude / OpenAI / Gemini shapes, deletes the
  `tools` field entirely if the filter would empty it, and resets
  `tool_choice` to `'auto'` if it forces a blocked tool. Past `tool_use` /
  `tool_result` blocks in message history are intentionally left untouched.

### ChatJimmy SDK Made Optional (2026-06-17)

- **src/utils/sdk-handler.ts**: The submodule is imported through a
  non-literal dynamic specifier, so `tsc` no longer treats it as a static
  build/typecheck dependency. The existing try/catch surfaces a missing
  submodule only when an `sdk://` route is hit at runtime.
- **package.json / tsconfig.json / tsconfig.server.json**: Removed the
  unused `chatjimmy-sdk` `imports` entry and TypeScript `paths` aliases
  (nothing in `src/` imported that alias; the handler references `dist/`
  by relative path).
- **Net effect**: clone, `npm install`, `npm run typecheck`, `npm run
  build`, and `npm run server` all succeed without the submodule. See
  [Optional: ChatJimmy SDK](./README.md#optional-chatjimmy-sdk-sdk-models).

### Model Response Time Tracking

The proxy now tracks per-model response time (min/avg/max in ms) alongside
existing per-endpoint timing.

- **Recording**: `recordModelTiming(modelId, elapsedMs)` is called inside
  `runAttempt()` after each request completes (both success and error),
  using the config key (`attemptModelId`) as the timing key — same key
  used by `recordModelStat`/`recordModelUsage`
- **Storage**: `requestModelTimingStats` map (same shape as
  `requestEndpointTimingStats`: `min_time_ms`, `max_time_ms`,
  `total_time_ms`, `count`)
- **Snapshot**: `getDashboardSnapshot()` and `handleDashboardRequestStats()`
  expose `model_timings` in `requestStats`
- **TUI Custom Models**: each configured model shows `[min/avg/maxs]`
  after its description, resolved by matching `routeModel` (upstream name)
  from the config array
- **TUI Composite Aliases**: each target shows `[min/avg/maxs]` after its
  properties, resolved by matching `routeModel` from `compositeResolved`
- **Dashboard HTML**: Model Statistic table has 3 new columns (min(s),
  avg(s), max(s)) joined from `model_timings` keyed by the resolved
  upstream model name

### Composite Fallback to Default Upstream

Composite aliases now support unresolved target models by falling back to
the default upstream route (`getDefaultModelRoute`) while preserving the
target model as `modelAlias`. This allows aliases such as `code-small` to
route even when the target is not explicitly declared in `models.*`.

### Messages Format Detection Fix (Claude blocks vs OpenAI passthrough)

`/v1/messages` request detection now treats block-style Claude content
(`content: [{type:"text"|"tool_use"|"tool_result"|"thinking", ...}]`) as
Claude format, forcing Claude→OpenAI conversion for `openai-completions`
upstreams. This prevents malformed passthrough payloads to
`/v1/chat/completions`.

### Dashboard Side-Nav Active Style

The active side navigation item in `/dashboard` now has a visible border
(light gray) for clearer section focus.

### Config Reload Endpoint Rename

The config reload endpoint is now `/config-reload` (previously `/reload`).

### Token Counting Toggle Simplification

Removed `LOCAL_TOKEN_COUNTING`. Local token counting is now controlled
only by `LOCAL_TIKTOKEN` (`true`/`1` enables tiktoken-based local
counting). If API-based token counting fails, the proxy falls back to
byte-based counting for user text.

### TOML Parser Regex Order Fix

The `parseSimpleToml()` function in `config-loader.ts` checked
`unquotedMatch` (regex `key = (.+)`) before `arrayMatch` (regex `key =
[...]`). For model IDs containing only hyphens and underscores (e.g.,
`deepseek-v4-flash`), the greedy `unquotedMatch` captured the array
value but silently discarded it since `models` sections are not in its
handling scope. Models with dots (e.g., `gpt-5.4-mini`) were unaffected
because `.` is outside the `[a-zA-Z0-9_-]` character class. Fixed by
swapping the check order — `arrayMatch` is now evaluated before
`unquotedMatch`, with a comment explaining the ordering constraint. This
fixes composite model resolution (e.g., `code-small` → `deepseek-v4-flash`)
where the candidate model key was previously never found in its category.

### Thinking Block Validation Field Fix

`ThinkingBlock` type defines field `thinking: string`, but
`validateClaudeContentBlock()` in `validation.ts` was checking `block.text`
for `type: "thinking"` blocks. This caused validation to throw `text is
required for thinking blocks` when Claude CLI sent requests with thinking
content blocks in assistant messages (the field is `thinking`, not `text`).
Fixed by changing the check to `block.thinking`.

### Upstream Error Diagnostics

The proxy now reads and logs upstream error response bodies in
`handleClaudeRequest` before throwing, making it possible to diagnose
API-level errors (e.g., DeepSeek returning 400 about thinking mode).

### DeepSeek Thinking Mode Compatibility

Some upstreams (e.g., DeepSeek's Anthropic-compatible API) internally
default models to thinking mode and require prior `content[].thinking`
blocks in the conversation even on the first request. The proxy now:

- Defaults `thinking` to `disabled` when the client doesn't set it
- Strips `thinking: { type: "enabled" }` when there are no prior
  assistant thinking blocks in the conversation history (avoids 400
  errors on first requests)

### Full Request Body Logging

Added debug-level logging of the full request body sent to upstreams in
`handleClaudeRequest` for easier troubleshooting.

### Thinking Signature Support & Streaming Improvements

- **Signature Delta Events**: Added full `signature_delta` support for
  thinking block verification in streaming
- **OpenAI-to-Claude Conversion**: Enhanced conversion of OpenAI's
  `reasoning_item_id` and `signature` to Claude's thinking format
- **Streaming Thinking Extraction**: Improved thinking content extraction
  from `<thinking>` markers and `reasoning_content` fields
- **Thinking Block Lifecycle**: Proper `content_block_start/delta/stop`
  events for thinking blocks in streaming

### Gemini `:countTokens` Endpoint

Added routing for `POST /v1beta/models/{model}:countTokens` and
`POST /v1/models/{model}:countTokens`. The request body is proxied as-is
to the upstream Gemini API and the raw JSON response (`totalTokens`) is
returned. Previously these paths fell through to an "Unsupported fixed
route" error (HTTP 500).

### OpenAI Handler Error Propagation Fix

`handleOpenAIRequest` previously threw a plain `Error` on upstream
non-2xx responses, which the outer error handler converted to HTTP 500
regardless of the actual upstream status. For streaming requests, it
silently returned HTTP 200 with the error wrapped in an SSE frame. Both
paths now use `handleTargetApiError()`, propagating the correct upstream
status code (401, 403, 429, etc.) to the client — matching the behavior
of the Claude and Gemini handlers.

---

## 2026-03-04 — ChatJimmy SDK Integration

**Optional, lazily-loaded submodule**: ChatJimmy SDK lives in
`submodules/chatjimmy` and is loaded at runtime via dynamic import only
when an `sdk://` model is requested. It is not required to build or run
the proxy.

**SDK Handler**: `src/utils/sdk-handler.ts` provides SDK-based request
handling:

- **SDK URL detection**: `sdk://` URLs use chatjimmy SDK clients instead
  of HTTP fetch
- **OpenAI-compatible mode**: `handleSdkOpenAIRequest()` uses
  `OpenAICompatibleClient`
- **Anthropic-compatible mode**: `handleSdkAnthropicRequest()` uses
  `OpenAICompatibleClient` as fallback
- **Streaming support**: SDK Anthropic stream is converted from OpenAI
  chunks to Claude SSE event format (`message_start`, `content_block_*`,
  `message_delta`, `message_stop`)
- **Streaming fallback**: If SDK stream is unavailable, falls back to
  non-stream response

---

## 2026-03-03 — Enhanced Thinking Configuration

- **Type Definitions**: Updated `ThinkingConfigParam` type to accept
  `boolean` values (`true`/`false`) in addition to string values
  (`"enabled"`/`"disabled"`)
- **Normalization Utility**: Added `normalizeThinkingConfig()` function to
  standardize thinking config across the codebase
- **Token Counting**: Updated token counting logic to handle boolean
  thinking types
- **Validation**: Enhanced validation to accept boolean values while
  maintaining backward compatibility

## 2026-03-03 — Thinking Signature Support

- **Signature Delta Events**: Added `"signature_delta"` to
  `ClaudeStreamEvent.delta.type` for streaming signature verification
- **Streaming Signature Emission**: Implemented `signature_delta` event
  emission before `content_block_stop` for thinking blocks
- **Signature Accumulation**: Accumulates signatures from multiple
  sources: `delta.signature`, `reasoning_item_id`, and `signature` fields
- **OpenAI-to-Claude Conversion**: Converts OpenAI's `reasoning_item_id`
  and `signature` to Claude's `signature_delta` format
- **Anthropic Pass-Through**: Passes through `signature_delta` events
  from Anthropic upstream unchanged
- **Non-Streaming Compatibility**: Includes signature in thinking block
  metadata for non-streaming responses

**Files modified** (covers the Model Response Time Tracking, Thinking
Signature Support, and adjacent changes):

- `src/utils/dashboard-stats.ts` — added `requestModelTimingStats` map,
  `recordModelTiming()`, `getRequestModelTimingStatsDesc()`
- `src/index.ts` — `recordModelTiming(attemptModelId, elapsedMs)` called
  inside `runAttempt()` for all requests
- `src/handlers/dashboard.ts` — `model_timings` in snapshot/API, 3 new
  columns (min/avg/max) in HTML model stats table and CSV export
- `src/tui.ts` — timing display (`[min/avg/maxs]`) in Custom Models
  section and Composite Aliases overlay
- `src/types/claude.ts` - Added `"signature_delta"` to stream event types
- `src/converters/streaming.ts` - Added signature accumulation and
  emission logic
- `src/converters/openai-to-claude.ts` - Enhanced signature extraction
  from response metadata

## 2026-03-03 — Gemini v1 Endpoint Support

- **Path Pattern Matching**: Updated regex patterns to support both
  `/v1beta/models/` and `/v1/models/` endpoints
- **URL Building**: Enhanced URL construction logic for both v1beta and
  v1 endpoints
- **Model Extraction**: Improved model ID extraction from both endpoint
  versions

## 2026-03-03 — API Key Management

- **Priority Logic**: Added intelligent API key priority based on
  upstream mode
- **Format Utility**: Created `formatApiKeyForUpstream()` function for
  consistent header formatting
- **Header Transformation**: Enhanced
  `transformAuthHeadersForUpstream()` to handle `Bearer` prefix stripping
- **Configuration Integration**: Better integration of config API keys
  with request processing

**Files modified** (covers the Enhanced Thinking Configuration, Gemini v1
Endpoint Support, and API Key Management changes):

- `src/converters/claude-to-gemini.ts` - Added boolean thinking support
  for Gemini conversion
- `src/converters/claude-to-openai.ts` - Added boolean thinking support
  for OpenAI conversion
- `src/index.ts` - Enhanced routing for v1 endpoints, API key priority
  logic
- `src/types/claude.ts` - Updated ThinkingConfigParam type definition
- `src/utils/routing.ts` - Added `formatApiKeyForUpstream()`, enhanced
  path matching
- `src/utils/thinking.ts` - Added normalization utility, updated all
  thinking functions
- `src/utils/token-counting.ts` - Updated to handle boolean thinking
  types
- `src/utils/validation.ts` - Enhanced validation for boolean thinking
  values

---

## 2026-02-28 — Gemini CLI Config Integration

Successfully tested proxy using **Gemini CLI configuration** from
`~/.gemini/.env`. All models work with the CLI's base URL and API key
settings.

**Gemini CLI Config Test Results:**

| Test Suite       | Models Tested | Passed | Success Rate |
|------------------|---------------|--------|--------------|
| Basic Models     | 10            | 9      | 90%          |
| Gemini Models    | 3             | 3      | 100%         |
| Claude Models    | 6             | 5      | 83.3%        |
| Thinking Models  | 10            | 7      | 70%          |
| **Total**        | **29**        | **24** | **82.8%**    |

**Basic Models (90% success):**

- deepseek/deepseek-v3.1
- deepseek-r1
- minimax/minimax-m2.1
- moonshotai/kimi-k2.5
- minimax/minimax-m2.5
- qwen3-32b
- deepseek/deepseek-v3.2-exp
- z-ai/glm-4.7
- moonshotai/kimi-k2-0905
- z-ai/glm-5 (upstream issue)

**Gemini Models (100% success):**

- gemini-2.5-flash
- gemini-3.1-pro-preview
- gemini-3.0-flash-preview

**Claude Models (83.3% success):**

- claude-4.6-sonnet
- claude-4.5-opus
- claude-4.5-haiku
- claude-4.0-sonnet
- claude-3.7-sonnet
- claude-4.1-sonnet (invalid request)

**Thinking Models (70% success):**

- deepseek/deepseek-v3.2-exp-thinking
- deepseek/deepseek-v3.1-terminus-thinking
- deepseek-r1-0528
- qwen3-30b-a3b-thinking-2507
- qwen3-next-80b-a3b-thinking
- doubao-1.5-thinking-pro
- moonshotai/kimi-k2-thinking
- qwen3-vl-30b-a3b-thinking (upstream unavailable)
- qwen3-235b-a22b-thinking-2507 (upstream unavailable)
- doubao-seed-1.6-thinking (upstream unavailable)

**Key Findings:**

- Proxy works seamlessly with Gemini CLI config (`~/.gemini/.env`)
- Uses `GOOGLE_GEMINI_BASE_URL` and `GEMINI_API_KEY` from CLI config
- 82.8% overall success rate across 29 models from 6+ providers
- All Gemini models (100%) and most Claude models (83.3%) working
- All thinking models show step-by-step reasoning
- SSE streaming: complete message boundaries guaranteed (fixed 2026-03-02)
- 5 failures: 1 upstream issue, 1 invalid request, 3 unavailable models

**Test scripts:**

- `test_gemini_cli.sh` - Basic models test (10 models)
- `test_gemini_models_cli.sh` - Gemini models test (3 models)
- `test_claude_models_cli.sh` - Claude models test (6 models)
- `test_thinking_cli.sh` - Thinking models test (10 models)

## 2026-02-28 — Unconfigured Models Validated

Successfully tested proxy with **no specific model IDs configured** in
`proxy_config.toml`. All models used fallback configuration from
`[models.default]` and `[upstream]` sections.

**Test Results: 100% Success (24/24 tests passed)**

| Test Suite      | Models | Tests | Passed | Success Rate |
|-----------------|--------|-------|--------|--------------|
| DeepSeek Models | 2      | 6     | 6      | 100%         |
| Thinking Models | 4      | 12    | 12     | 100%         |
| SSE Streaming   | 2      | 6     | 6      | 100%         |
| **Total**       | **8**  | **24**| **24** | **100%**     |

**Key Findings:**

- Unconfigured models work perfectly with default settings
- All 3 endpoints supported: `/v1/messages`, `/v1/interactions`,
  `generateContent`
- SSE streaming works for all endpoints
- Thinking/reasoning models work without special configuration
- Fallback chain validated: `[models.default]` → `[upstream]` →
  hardcoded defaults

See `docs/test_results_unconfigured_models.md` for complete details.

## 2026-02-28 — ENV Variables Removed

Removed `FIXED_ROUTE_TARGET_URL` and `FIXED_ROUTE_PATH_PREFIX` environment
variables. All configuration now in `proxy_config.toml`:

**Configuration hierarchy for unconfigured models:**

```
1. [models.default].upstream_mode / base_url / api_key
   ↓ (if missing)
2. [upstream].upstream_mode / default_base_url / default_api_key
   ↓ (if missing)
3. Configurable fallback: "openai-completions" / "https://api.qnaigc.com"
   (hardcoded in src/utils/config-loader.ts, src/index.ts, and src/tui.ts;
    override by setting [upstream].default_base_url or [models.default].base_url
    in proxy_config.toml — there is no env var to override this final fallback)
```

See `docs/config_env_removal.md` for migration guide.

## 2026-02-27 — Config Structure Updated

The routing logic and configuration structure have been revised to align
implementation with documentation:

- **Category-based config**: Models grouped by provider with inheritance
- **Array format**: `["model-alias", "base-url", "api-key"]` with empty
  string inheritance
- **Explicit upstream_mode**: `anthropic-messages`,
  `gemini-generatecontent`, `openai-completions`
- **No normalization**: Model names preserved as-is (e.g.,
  `"deepseek/deepseek-v3.2"`)

See `docs/routing_config_revision.md` for complete details.

## 2026-02-25 — Comprehensive Testing (Production Ready)

See [README.md § Testing](./README.md#-testing) for the consolidated test
result tables and provider success rates. Detailed per-suite breakdowns
live in `docs/test_results_*.md` and `docs/*_test_results.md`.
